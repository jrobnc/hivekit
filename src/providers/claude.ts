import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { Provider, ProviderRunInput, ProviderRunOutput, Role } from "./types.js";

/** Aliases, not pinned ids, so each new release is picked up. */
export const CLAUDE_MODELS: Record<Role, string> = {
  plan: "opus",
  build: "sonnet",
  review: "sonnet",
  evaluate: "opus",
  advise: "fable",
};

export const claudeProvider: Provider = {
  name: "claude",

  modelFor: (role) => CLAUDE_MODELS[role],

  async run(input: ProviderRunInput): Promise<ProviderRunOutput> {
    const sdkOpts: Options = {
      model: input.model,
      cwd: input.cwd,
      allowedTools: input.allowedTools,
      permissionMode: input.permissionMode as PermissionMode,
      maxTurns: input.maxTurns,
      effort: input.effort,
      // ponytail: one optional per-agent cap; per-run caps when the ledger shows a need
      maxBudgetUsd: input.maxBudgetUsd,
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
      for await (const message of query({ prompt: input.prompt, options: sdkOpts })) {
        messageCount++;

        // Log message types for debugging
        if (process.env.HARNESS_DEBUG) {
          const msg = message as Record<string, unknown>;
          console.error(`  [agent] msg#${messageCount} type=${msg.type}`);
        }

        // Progress indicator for assistant messages
        if (message.type === "assistant" && input.onProgress) {
          input.onProgress(".");
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

    return {
      thrown,
      result,
      sessionId,
      durationMs,
      totalCostUsd,
      isError,
      subtype,
      turns,
      usage: {
        input_tokens: Number(usage?.input_tokens ?? 0),
        output_tokens: Number(usage?.output_tokens ?? 0),
        cache_read_input_tokens: Number(usage?.cache_read_input_tokens ?? 0),
        cache_creation_input_tokens: Number(usage?.cache_creation_input_tokens ?? 0),
      },
      model: input.model,
    };
  },
};
