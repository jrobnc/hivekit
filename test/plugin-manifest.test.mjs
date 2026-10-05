// Validation tests for the HiveKit Codex plugin.
// Checks plugin.json fields, SKILL.md frontmatter, size limits,
// and that CLI flags referenced in skills exist in --help output.
//
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_DIR = join(ROOT, "plugins", "hivekit");
const PLUGIN_JSON_PATH = join(PLUGIN_DIR, "plugin.json");
const PKG_JSON_PATH = join(ROOT, "package.json");
const CLI = join(ROOT, "dist", "index.js");
const MAX_SKILL_SIZE = 256 * 1024; // 256 KiB

// ── Helpers ──────────────────────────────────────────────────────────

function readJSON(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

/** Extract YAML frontmatter from a SKILL.md string. Returns { name, description } or null. */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fm = {};
  for (const line of match[1].split("\n")) {
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (m) fm[m[1]] = m[2].trim();
  }
  return fm.name && fm.description ? fm : null;
}

/** Extract --flags from a SKILL.md body (after frontmatter). */
function extractFlags(content) {
  const flags = new Set();
  // Match --word patterns, excluding table header separators
  for (const m of content.matchAll(/`--([\w-]+)(?:\s[^`]*)?`/g)) {
    flags.add(`--${m[1]}`);
  }
  return flags;
}

// ── Load plugin data ─────────────────────────────────────────────────

const plugin = readJSON(PLUGIN_JSON_PATH);
const pkg = readJSON(PKG_JSON_PATH);

const skillsDir = resolve(PLUGIN_DIR, plugin.skills.replace(/^\.\//, ""));
const skillDirs = readdirSync(skillsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

// ── plugin.json tests ────────────────────────────────────────────────

test("plugin.json exists and parses as valid JSON", () => {
  // If we got here, readJSON succeeded
  assert.ok(plugin);
});

test("plugin.json has required fields", () => {
  for (const field of ["name", "version", "description", "skills"]) {
    assert.ok(plugin[field], `missing required field: ${field}`);
  }
});

test("plugin.json name <= 64 chars", () => {
  assert.ok(plugin.name.length <= 64, `name is ${plugin.name.length} chars`);
});

test("plugin.json displayName <= 30 chars", () => {
  assert.ok(plugin.displayName, "displayName is required");
  assert.ok(
    plugin.displayName.length <= 30,
    `displayName is ${plugin.displayName.length} chars`,
  );
});

test("plugin.json shortDescription <= 30 chars", () => {
  assert.ok(plugin.shortDescription, "shortDescription is required");
  assert.ok(
    plugin.shortDescription.length <= 30,
    `shortDescription is ${plugin.shortDescription.length} chars`,
  );
});

test("plugin.json version matches package.json version", () => {
  assert.equal(plugin.version, pkg.version);
});

test("plugin.json skills path resolves to a directory with skill subdirs", () => {
  assert.ok(
    skillDirs.length > 0,
    `skills directory has no subdirectories: ${skillsDir}`,
  );
});

// ── SKILL.md tests ───────────────────────────────────────────────────

for (const dir of skillDirs) {
  const skillPath = join(skillsDir, dir, "SKILL.md");

  test(`${dir}/SKILL.md exists`, () => {
    assert.ok(statSync(skillPath).isFile());
  });

  test(`${dir}/SKILL.md has YAML frontmatter with name and description`, () => {
    const content = readFileSync(skillPath, "utf-8");
    const fm = parseFrontmatter(content);
    assert.ok(fm, `${dir}/SKILL.md: missing or invalid YAML frontmatter`);
    assert.ok(fm.name, `${dir}/SKILL.md: frontmatter missing 'name'`);
    assert.ok(fm.description, `${dir}/SKILL.md: frontmatter missing 'description'`);
  });

  test(`${dir}/SKILL.md <= 256 KiB`, () => {
    const size = statSync(skillPath).size;
    assert.ok(size <= MAX_SKILL_SIZE, `${dir}/SKILL.md is ${size} bytes (max ${MAX_SKILL_SIZE})`);
  });
}

// ── CLI flag validation ──────────────────────────────────────────────

test("CLI flags referenced in skills exist in --help output", () => {
  // Get --help output
  const helpText = execFileSync("node", [CLI, "--help"], {
    encoding: "utf-8",
    timeout: 5000,
    env: { ...process.env, NODE_OPTIONS: "" },
  });

  // Extract known flags from help text
  const knownFlags = new Set();
  for (const m of helpText.matchAll(/--(\w[\w-]*)/g)) {
    knownFlags.add(`--${m[1]}`);
  }

  // Collect all flags from all skill files (skip the intent skill — it has no CLI commands)
  const missing = [];
  for (const dir of skillDirs) {
    const skillPath = join(skillsDir, dir, "SKILL.md");
    const content = readFileSync(skillPath, "utf-8");

    // Skip guidance-only skills (no CLI command)
    const fm = parseFrontmatter(content);
    if (fm && fm.cli === 'false') continue;

    const flags = extractFlags(content);
    for (const flag of flags) {
      if (!knownFlags.has(flag)) {
        missing.push(`${dir}: ${flag}`);
      }
    }
  }

  assert.deepEqual(missing, [], `Unknown CLI flags in skills:\n${missing.join("\n")}`);
});

// The npm name "hivekit" belongs to an unrelated third-party package (texthive/hivekit). The plugin must
// never tell anyone to install it, and must point at the real repo.
test('plugin never installs the unrelated npm package "hivekit"', () => {
  const walk = (dir) => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
  const root = resolve(new URL('..', import.meta.url).pathname);
  const files = [...walk(join(root, 'plugins/hivekit')), join(root, 'docs/codex-plugin.md')];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    assert.doesNotMatch(text, /npm (install|i)( -g)? hivekit\b/, `${f} installs the unrelated npm package`);
    assert.doesNotMatch(text, /github\.com\/anthropics\/hivekit/, `${f} points at a non-existent repo`);
  }
});

// ── extractFlags self-tests ─────────────────────────────────────────

test("extractFlags catches flags with trailing content", () => {
  const content = "Use `--mode review` to run a review.\nSet `--depth <quick|standard|deep>` for depth.";
  const flags = extractFlags(content);
  assert.ok(flags.has("--mode"), "should extract --mode from `--mode review`");
  assert.ok(flags.has("--depth"), "should extract --depth from `--depth <quick|standard|deep>`");
});

test("cross-reference rejects unknown flags", () => {
  const fakeContent = "Run with `--not-a-real-flag` to test.";
  const flags = extractFlags(fakeContent);
  assert.ok(flags.has("--not-a-real-flag"), "should extract the fake flag");

  // Simulate cross-reference against a known set that doesn't include the fake flag
  const knownFlags = new Set(["--help", "--version", "--mode"]);
  const missing = [];
  for (const flag of flags) {
    if (!knownFlags.has(flag)) missing.push(flag);
  }
  assert.ok(missing.length > 0, "fake flag should appear in missing list");
  assert.ok(missing.includes("--not-a-real-flag"), "missing list should contain --not-a-real-flag");
});

// ── Exit code consistency ───────────────────────────────────────────

test("exit codes in src/outcome.ts are all documented in hivekit-improve SKILL.md", () => {
  const outcomeSource = readFileSync(join(ROOT, "src", "outcome.ts"), "utf-8");

  // Extract numeric exit codes from EXIT_CODES object
  const sourceCodes = new Set();
  for (const m of outcomeSource.matchAll(/:\s*(\d+)/g)) {
    sourceCodes.add(Number(m[1]));
  }
  // Sanity: we expect codes 0-4
  assert.ok(sourceCodes.size >= 4, `Expected at least 4 distinct exit codes, found ${sourceCodes.size}`);

  const improveSkill = readFileSync(
    join(PLUGIN_DIR, "skills", "hivekit-improve", "SKILL.md"),
    "utf-8",
  );

  // Extract code numbers from the exit code table (lines like "| 0 | ...")
  const docCodes = new Set();
  for (const m of improveSkill.matchAll(/\|\s*(\d+)\s*\|/g)) {
    docCodes.add(Number(m[1]));
  }

  const undocumented = [];
  for (const code of sourceCodes) {
    if (!docCodes.has(code)) undocumented.push(code);
  }
  assert.deepEqual(
    undocumented,
    [],
    `Exit codes from src/outcome.ts missing in hivekit-improve SKILL.md: ${undocumented.join(", ")}`,
  );
});

test("build and review skills mention non-zero exit codes", () => {
  const nonZeroCodes = [1, 2, 3, 4];
  for (const skillName of ["hivekit-build", "hivekit-review"]) {
    const content = readFileSync(
      join(PLUGIN_DIR, "skills", skillName, "SKILL.md"),
      "utf-8",
    );
    for (const code of nonZeroCodes) {
      assert.ok(
        content.includes(String(code)),
        `${skillName}/SKILL.md should mention exit code ${code}`,
      );
    }
  }
});

// ── Link resolution ────────────────────────────────────────────────

test("relative markdown links in plugins/ and docs/ resolve to existing files", () => {
  const walk = (dir) =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });

  const mdFiles = [
    ...walk(join(ROOT, "plugins")).filter((f) => f.endsWith(".md")),
    join(ROOT, "docs", "codex-plugin.md"),
  ];

  const broken = [];
  for (const file of mdFiles) {
    const text = readFileSync(file, "utf-8");
    const linkRegex = /\]\(([^)]+)\)/g;
    for (const m of text.matchAll(linkRegex)) {
      const target = m[1];
      // Skip URLs, anchors, and template placeholders
      if (/^https?:\/\//.test(target) || target.startsWith("#") || target.includes("<")) continue;
      // Strip anchor from relative links (e.g., file.md#section)
      const filePart = target.split("#")[0];
      if (!filePart) continue;
      const resolved = resolve(dirname(file), filePart);
      if (!existsSync(resolved)) {
        broken.push(`${file}: ${target} → ${resolved}`);
      }
    }
  }

  assert.deepEqual(broken, [], `Broken relative links:\n${broken.join("\n")}`);
});

// ── Category field ─────────────────────────────────────────────────

test("plugin.json has category field matching docs", () => {
  assert.ok(plugin.category, "plugin.json missing category field");
  assert.equal(plugin.category, "developer-tools");
});
