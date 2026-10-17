import { exec } from "child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";

type Args = Record<string, any>;
interface Ctx { cwd?: string; allowedTools: string[]; apiKeyEnv?: string }

const str = (description: string) => ({ type: "string", description });
const def = (name: string, description: string, properties: Args, required: string[]) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});

export const TOOL_DEFS = [
  def("Read", "Read a file (optionally a line range).", { file_path: str("Path"), offset: { type: "number" }, limit: { type: "number" } }, ["file_path"]),
  def("Write", "Write a file, creating parent directories.", { file_path: str("Path"), content: str("Full content") }, ["file_path", "content"]),
  def("Edit", "Replace old_string with new_string in a file.", { file_path: str("Path"), old_string: str("Text to find"), new_string: str("Replacement"), replace_all: { type: "boolean" } }, ["file_path", "old_string", "new_string"]),
  def("Glob", "List files matching a glob pattern (supports **, *, ?).", { pattern: str("Glob"), path: str("Directory") }, ["pattern"]),
  def("Grep", "Search file contents with a JS regular expression.", { pattern: str("Regex"), path: str("Directory"), glob: str("File glob filter") }, ["pattern"]),
  def("Bash", "Run a shell command.", { command: str("Command"), timeout: { type: "number", description: "ms, max 600000" } }, ["command"]),
];

const truncate = (s: string, max: number) => (s.length > max ? s.slice(0, max) + "\n[truncated]" : s);

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") i++;
      re += "(?:.*/)?";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const rec = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) await rec(p);
      else if (e.isFile()) out.push(p);
    }
  };
  await rec(root);
  return out.sort();
}

async function run(name: string, a: Args, cwd: string, apiKeyEnv?: string): Promise<string> {
  const root = resolve(cwd);
  const p = (x: string) => {
    const r = resolve(root, String(x));
    const rel = relative(root, r);
    if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) throw new Error(`path outside cwd: ${x}`);
    return r;
  };
  switch (name) {
    case "Read": {
      const lines = (await readFile(p(a.file_path), "utf-8")).split("\n");
      const start = Math.max(0, Number(a.offset ?? 0));
      const end = a.limit ? start + Number(a.limit) : lines.length;
      return truncate(lines.slice(start, end).join("\n"), 100_000);
    }
    case "Write":
      await mkdir(dirname(p(a.file_path)), { recursive: true });
      await writeFile(p(a.file_path), String(a.content), "utf-8");
      return `Wrote ${a.file_path}`;
    case "Edit": {
      const text = await readFile(p(a.file_path), "utf-8");
      const n = a.old_string === "" ? 0 : text.split(a.old_string).length - 1;
      if (n === 0) return "Error: old_string not found";
      if (n > 1 && !a.replace_all) return `Error: old_string is not unique (${n} matches); use replace_all or add context`;
      await writeFile(p(a.file_path), text.split(a.old_string).join(a.new_string), "utf-8");
      return `Edited ${a.file_path} (${n} replacement${n > 1 ? "s" : ""})`;
    }
    case "Glob": {
      const root = p(a.path ?? ".");
      const re = globToRegExp(a.pattern);
      return (await walk(root)).map((f) => relative(root, f)).filter((f) => re.test(f)).join("\n");
    }
    case "Grep": {
      const root = p(a.path ?? ".");
      const re = new RegExp(a.pattern);
      const fileRe = a.glob ? globToRegExp(a.glob) : undefined;
      const hits: string[] = [];
      for (const f of await walk(root)) {
        const rel = relative(root, f);
        if (fileRe && !fileRe.test(rel)) continue;
        if ((await stat(f)).size > 1_000_000) continue;
        const lines = (await readFile(f, "utf-8")).split("\n");
        for (let i = 0; i < lines.length && hits.length < 200; i++) {
          if (re.test(lines[i])) hits.push(`${rel}:${i + 1}:${lines[i]}`);
        }
        if (hits.length >= 200) break;
      }
      return hits.join("\n");
    }
    case "Bash": {
      const t = Number(a.timeout);
      const timeout = Number.isFinite(t) && t >= 1 ? Math.min(Math.floor(t), 600_000) : 120_000;
      return new Promise((res) =>
        exec(String(a.command), {
          cwd,
          timeout,
          maxBuffer: 10 * 1024 * 1024,
          env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== apiKeyEnv && k !== "CLAUDE_CODE_OAUTH_TOKEN" && !k.startsWith("ANTHROPIC_"))),
        }, (err, stdout, stderr) => {
          const code = err ? (typeof err.code === "number" ? err.code : err.killed ? "timeout" : "error") : 0;
          res(truncate(`exit code: ${code}\n${stdout}${stderr ? `\nstderr:\n${stderr}` : ""}`, 30_000));
        })
      );
    }
    default:
      return `Error: unknown tool ${name}`;
  }
}

/** Execute one tool call. Failures are returned to the model as "Error: …" strings, never thrown. */
export async function runTool(name: string, argsJson: string, ctx: Ctx): Promise<string> {
  if (!ctx.allowedTools.includes(name)) return `Error: tool ${name} is not allowed`;
  let args: Args;
  try {
    args = JSON.parse(argsJson || "{}");
  } catch (err) {
    return `Error: invalid JSON arguments for ${name}: ${(err as Error).message}`;
  }
  try {
    return await run(name, args, ctx.cwd ?? process.cwd(), ctx.apiKeyEnv);
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : err}`;
  }
}
