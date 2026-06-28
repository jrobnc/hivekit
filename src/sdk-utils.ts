import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

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

export interface AgentOptions {
  prompt: string;
  model?: string;
  cwd?: string;
  allowedTools?: string[];
  permissionMode?: PermissionMode;
  maxTurns?: number;
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
  };

  let result = "";
  let sessionId = "";
  let durationMs = 0;
  let totalCostUsd = 0;
  let isError = false;

  let messageCount = 0;
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
    }
  }

  if (messageCount === 0) {
    console.warn("[agent] WARNING: No messages received from SDK query");
  } else {
    console.log(`  [agent] ${messageCount} messages, ${Math.round(durationMs / 1000)}s, $${totalCostUsd.toFixed(2)}`);
  }

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
  return result;
}
