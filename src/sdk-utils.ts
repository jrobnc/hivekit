import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { readFile, appendFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { turnCapMessage } from "./turns.js";
import type { TurnPhase } from "./types.js";

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

export type Effort = "low" | "medium" | "high" | "max";

/**
 * Model tier per role. Aliases, not pinned ids, so each new release is picked up.
 * Opus plans and judges, Sonnet does the volume, Fable only at advisor checkpoints.
 */
export const TIERS = {
  plan: { model: "opus", effort: "high" },
  build: { model: "sonnet", effort: "medium" },
  review: { model: "sonnet", effort: "medium" },
  evaluate: { model: "opus", effort: "high" },
  advise: { model: "fable", effort: "high" },
} as const satisfies Record<string, { model: string; effort: Effort }>;

/** Cost ledger. HIVEKIT_LEDGER points it elsewhere (the test suite uses a throwaway file). */
export const LEDGER = process.env.HIVEKIT_LEDGER || join(homedir(), ".cache", "hivekit", "ledger.jsonl");

export interface AgentOptions {
  prompt: string;
  model?: string;
  effort?: Effort;
  /** Ledger label, e.g. "planner" or "generator-r2" */
  label?: string;
  cwd?: string;
  allowedTools?: string[];
  permissionMode?: PermissionMode;
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
  const sdkOpts: Options = {
    model: opts.model ?? "opus",
    cwd: opts.cwd,
    allowedTools: opts.allowedTools ?? ["Read", "Glob", "Grep", "Bash"],
    permissionMode: opts.permissionMode ?? "acceptEdits",
    maxTurns: opts.maxTurns ?? 30,
    effort: opts.effort,
    // ponytail: one optional per-agent cap; per-run caps when the ledger shows a need
    maxBudgetUsd: positiveNumber(process.env.HIVEKIT_MAX_USD_PER_AGENT),
  };

  let result = "";
  let sessionId = "";
  let durationMs = 0;
  let totalCostUsd = 0;
  let isError = false;
  let subtype: string | undefined;
  let turns = 0;
  let usage: Record<string, unknown> | undefined;
  let thrown: unknown;

  let messageCount = 0;
  try {
    for await (const message of query({ prompt: opts.prompt, options: sdkOpts })) {
      messageCount++;

      // Log message types for debugging
      if (process.env.HARNESS_DEBUG) {
        const msg = message as Record<string, unknown>;
        console.error(`  [agent] msg#${messageCount} type=${msg.type}`);
      }

      // Progress indicator for assistant messages
      if (message.type === "assistant" && opts.onProgress) {
        opts.onProgress(".");
      }

      // Capture the final result
      if (message.type === "result") {
        const msg = message as Record<string, unknown>;
        result = (msg.result as string) ?? "";
        sessionId = (msg.session_id as string) ?? "";
        durationMs = (msg.duration_ms as number) ?? 0;
        totalCostUsd = (msg.total_cost_usd as number) ?? 0;
        isError = (msg.is_error as boolean) ?? false;
        subtype = msg.subtype as string | undefined;
        turns = (msg.num_turns as number) ?? 0;
        usage = msg.usage as Record<string, unknown> | undefined;
      }
    }
  } catch (err) {
    thrown = err;
  }

  if (messageCount === 0) {
    console.warn("[agent] WARNING: No messages received from SDK query");
  } else {
    console.log(`  [agent] ${messageCount} messages, ${Math.round(durationMs / 1000)}s, $${totalCostUsd.toFixed(2)}`);
  }

  // The ledger is bookkeeping: an unwritable ~/.cache must never crash a run before result.json exists.
  try {
    await mkdir(dirname(LEDGER), { recursive: true });
    await appendFile(
      LEDGER,
      JSON.stringify({
        ts: new Date().toISOString(),
        label: opts.label ?? "agent",
        model: sdkOpts.model,
        effort: opts.effort ?? null,
        usd: totalCostUsd,
        ms: durationMs,
        cwd: opts.cwd,
        maxTurns: sdkOpts.maxTurns,
        error: isError || thrown !== undefined,
        runId: opts.runId ?? "",
        phase: opts.phase ?? "",
        turns,
        usage: {
          input_tokens: Number(usage?.input_tokens ?? 0),
          output_tokens: Number(usage?.output_tokens ?? 0),
          cache_read_input_tokens: Number(usage?.cache_read_input_tokens ?? 0),
          cache_creation_input_tokens: Number(usage?.cache_creation_input_tokens ?? 0),
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
    throw new Error(turnCapMessage(opts.phase, sdkOpts.maxTurns!, opts.phase === "planner" ? opts.specPaths : undefined));
  }
  if (thrown !== undefined) throw thrown;
  if (isError) {
    throw new Error(`Agent failed: ${result}`);
  }

  return { result, sessionId, durationMs, totalCostUsd };
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
