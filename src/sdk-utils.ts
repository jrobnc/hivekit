import { readFile, appendFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { turnCapMessage } from "./turns.js";
import type { TurnPhase } from "./types.js";
import { getProvider } from "./providers/index.js";
import type { Effort, Role, ProviderRunOutput } from "./providers/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let principlesCache: string | null = null;

/**
 * Load the shared operating principles (Ponytail-style guardrails) injected into
 * every agent prompt via the {{principles}} placeholder. Cached after first read.
 */
export async function loadPrinciples(): Promise<string> {
  if (principlesCache === null) {
    principlesCache = await readFile(
      join(__dirname, "prompts", "principles.md"),
      "utf-8"
    );
  }
  return principlesCache;
}

/** A finite number > 0 from an env value, else undefined (so a typo never disables a cap via NaN). */
export function positiveNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export type { Effort };

/**
 * Role and effort per agent job. The active provider maps each role to a concrete
 * model: a frontier model plans, judges and advises, a workhorse does the volume.
 */
export const TIERS = {
  plan: { role: "plan", effort: "high" },
  build: { role: "build", effort: "medium" },
  review: { role: "review", effort: "medium" },
  evaluate: { role: "evaluate", effort: "high" },
  advise: { role: "advise", effort: "high" },
} as const satisfies Record<string, { role: Role; effort: Effort }>;

/** Cost ledger. HIVEKIT_LEDGER points it elsewhere (the test suite uses a throwaway file). */
export const LEDGER = process.env.HIVEKIT_LEDGER || join(homedir(), ".cache", "hivekit", "ledger.jsonl");

export interface AgentOptions {
  prompt: string;
  /** Which provider model tier to use; defaults to "plan" */
  role?: Role;
  /** Claude-only override; ignored by other providers */
  model?: string;
  effort?: Effort;
  /** Ledger label, e.g. "planner" or "generator-r2" */
  label?: string;
  cwd?: string;
  allowedTools?: string[];
  permissionMode?: string;
  maxTurns?: number;
  /** Phase name; when set, a max-turns stop throws a named cap-hit error */
  phase?: TurnPhase | "advisor";
  /** Run id, recorded on the ledger line */
  runId?: string;
  /** Spec path count, for the planner cap-hit message */
  specPaths?: number;
  /** Called periodically with progress indicators */
  onProgress?: (indicator: string) => void;
}

export interface AgentResult {
  result: string;
  sessionId: string;
  durationMs: number;
  totalCostUsd: number;
}

/**
 * Run an agent query and return the final result.
 * Abstracts away the SDK message stream into a simple async function.
 */
export async function runAgent(opts: AgentOptions): Promise<AgentResult> {
  const provider = getProvider();
  const role = opts.role ?? "plan";
  const model = provider.name === "claude" && opts.model ? opts.model : provider.modelFor(role);
  const maxTurns = opts.maxTurns ?? 30;

  let out: ProviderRunOutput | undefined;
  let thrown: unknown;
  try {
    out = await provider.run({
      prompt: opts.prompt,
      model,
      effort: opts.effort,
      cwd: opts.cwd,
      allowedTools: opts.allowedTools ?? ["Read", "Glob", "Grep", "Bash"],
      permissionMode: opts.permissionMode ?? "acceptEdits",
      maxTurns,
      maxBudgetUsd: positiveNumber(process.env.HIVEKIT_MAX_USD_PER_AGENT),
      onProgress: opts.onProgress,
    });
  } catch (err) {
    thrown = err;
  }
  const result = out?.result ?? "";
  const isError = out?.isError ?? false;
  const subtype = out?.subtype;
  const durationMs = out?.durationMs ?? 0;
  const totalCostUsd = out?.totalCostUsd ?? 0;

  // The ledger is bookkeeping: an unwritable ~/.cache must never crash a run before result.json exists.
  try {
    await mkdir(dirname(LEDGER), { recursive: true });
    await appendFile(
      LEDGER,
      JSON.stringify({
        ts: new Date().toISOString(),
        label: opts.label ?? "agent",
        model,
        provider: provider.name,
        effort: opts.effort ?? null,
        usd: totalCostUsd,
        ms: durationMs,
        cwd: opts.cwd,
        maxTurns,
        error: isError || thrown !== undefined,
        runId: opts.runId ?? "",
        phase: opts.phase ?? "",
        turns: out?.turns ?? 0,
        usage: {
          input_tokens: out?.usage.input_tokens ?? 0,
          output_tokens: out?.usage.output_tokens ?? 0,
          cache_read_input_tokens: out?.usage.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: out?.usage.cache_creation_input_tokens ?? 0,
        },
        lane: process.env.HIVEKIT_LANE ?? "",
      }) + "\n",
      "utf-8"
    );
  } catch (err) {
    console.warn(`  [ledger] not written (${err instanceof Error ? err.message : err})`);
  }

  const thrownMsg = thrown === undefined ? undefined : (thrown as Error)?.message ?? String(thrown);
  const capHit = subtype === "error_max_turns" || /maximum number of turns/i.test(thrownMsg ?? (isError ? result : ""));
  if (capHit && opts.phase && opts.phase !== "advisor") {
    throw new Error(turnCapMessage(opts.phase, maxTurns, opts.phase === "planner" ? opts.specPaths : undefined));
  }
  if (thrown !== undefined) throw thrown;
  if (isError) {
    throw new Error(`Agent failed: ${result}`);
  }

  return { result, sessionId: out?.sessionId ?? "", durationMs, totalCostUsd };
}

/**
 * Fill {{template}} placeholders in a string with values.
 */
export function fillTemplate(
  template: string,
  vars: Record<string, string>
): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  // Warn about any unfilled placeholders left after substitution
  const unfilled = [...result.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]);
  if (unfilled.length > 0) {
    const unique = [...new Set(unfilled)];
    console.warn(`[fillTemplate] WARNING: unfilled placeholders: ${unique.join(", ")}`);
  }
  return result;
}
