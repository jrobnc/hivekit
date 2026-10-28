import { randomUUID } from "crypto";
import { z } from "zod";
import { TOOL_DEFS, runTool } from "./tools.js";
import type { Provider, ProviderRunInput, ProviderRunOutput, Role } from "./types.js";

export const OpenAICompatibleConfigSchema = z.object({
  name: z.literal("openai-compatible"),
  baseUrl: z.string().url().refine((u) => /^https?:\/\//i.test(u), "baseUrl must be http(s)"),
  apiKeyEnv: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
  models: z.object({ frontier: z.string().min(1), workhorse: z.string().min(1) }).strict(),
  pricesUsdPerMTok: z
    .record(z.string(), z.object({ input: z.number().nonnegative(), output: z.number().nonnegative() }))
    .optional(),
}).strict();
export type OpenAICompatibleConfig = z.infer<typeof OpenAICompatibleConfigSchema>;

/** Mirrors Claude's split: frontier plans/judges/advises, workhorse does the volume. */
export const ROLE_TIER = {
  plan: "frontier",
  evaluate: "frontier",
  advise: "frontier",
  "build-escalated": "frontier",
  "advise-escalated": "frontier",
  build: "workhorse",
  review: "workhorse",
} as const satisfies Record<Role, "frontier" | "workhorse">;

export function createOpenAICompatibleProvider(config: OpenAICompatibleConfig): Provider {
  const base = config.baseUrl.replace(/\/$/, "");

  const headers = (): Record<string, string> => {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (config.apiKeyEnv) {
      const key = process.env[config.apiKeyEnv];
      if (!key) throw new Error(`openai-compatible: env var ${config.apiKeyEnv} (apiKeyEnv) is not set`);
      h.Authorization = `Bearer ${key}`;
    }
    return h;
  };

  return {
    name: "openai-compatible",

    modelFor: (role) => config.models[ROLE_TIER[role]],

    // effort and permissionMode have no equivalent here and are ignored.
    async run(input: ProviderRunInput): Promise<ProviderRunOutput> {
      const started = Date.now();
      const timeoutMs = config.timeoutMs ?? 300_000;
      const url = `${base}/chat/completions`;
      const shown = (() => { const u = new URL(url); return u.origin + u.pathname; })();
      const redact = (s: string) => { const k = config.apiKeyEnv && process.env[config.apiKeyEnv]; return (k ? s.split(k).join("[redacted]") : s).slice(0, 200); };
      const tools = TOOL_DEFS.filter((t) => input.allowedTools.includes(t.function.name));
      const messages: any[] = [{ role: "user", content: input.prompt }];
      const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      const price = config.pricesUsdPerMTok?.[input.model];
      const cost = () => (price ? (usage.input_tokens / 1e6) * price.input + (usage.output_tokens / 1e6) * price.output : 0);
      let turns = 0;
      let last = "";

      const out = (extra: Partial<ProviderRunOutput>): ProviderRunOutput => ({
        result: last,
        sessionId: randomUUID(),
        durationMs: Date.now() - started,
        totalCostUsd: cost(),
        isError: false,
        turns,
        usage,
        model: input.model,
        ...extra,
      });

      try {
        while (turns < input.maxTurns) {
          let body: any;
          try {
            const res = await fetch(url, {
              method: "POST",
              headers: headers(),
              body: JSON.stringify({ model: input.model, messages, ...(tools.length ? { tools } : {}) }),
              signal: AbortSignal.timeout(timeoutMs),
            });
            if (!res.ok) throw new Error(`openai-compatible: POST ${shown} → ${res.status}: ${redact(await res.text())}`);
            body = await res.json();
          } catch (err: any) {
            if (String(err?.message).startsWith("openai-compatible:")) throw err;
            if (err?.name === "TimeoutError") throw new Error(`openai-compatible: POST ${shown} timed out after ${timeoutMs}ms`);
            if (err?.name === "SyntaxError") throw new Error(`openai-compatible: POST ${shown} returned invalid JSON`);
            // Not err.message: undici messages can contain the full URL.
            throw new Error(`openai-compatible: POST ${shown} failed: ${err?.cause?.code ?? err?.name}`);
          }
          const message = body?.choices?.[0]?.message;
          if (!message) {
            throw new Error(`openai-compatible: POST ${shown} returned no choices[0].message${body?.error?.message ? ": " + redact(String(body.error.message)) : ""}`);
          }
          turns++;
          input.onProgress?.(".");
          usage.input_tokens += Number(body.usage?.prompt_tokens ?? 0);
          usage.output_tokens += Number(body.usage?.completion_tokens ?? 0);
          messages.push(message);
          last = message.content ?? "";

          if (!message.tool_calls?.length) {
            const finish = body.choices[0].finish_reason;
            return finish === "length" || finish === "content_filter" ? out({ isError: true, subtype: `finish_${finish}` }) : out({});
          }

          for (const call of message.tool_calls) {
            const content = await runTool(call.function?.name, call.function?.arguments, {
              cwd: input.cwd,
              allowedTools: input.allowedTools,
              apiKeyEnv: config.apiKeyEnv,
            });
            messages.push({ role: "tool", tool_call_id: call.id, content });
          }
          // Checked only after tool turns, so a final no-tool turn can cross the cap.
          if (input.maxBudgetUsd !== undefined && cost() > input.maxBudgetUsd) {
            return out({ isError: true, subtype: "error_max_budget_usd" });
          }
        }
      } catch (err) {
        // Turn-1 failures still reject; later ones return `thrown` so runAgent ledgers the spend already incurred.
        if (turns === 0) throw err;
        return out({ isError: true, thrown: err });
      }
      return out({ isError: true, subtype: "error_max_turns" });
    },
  };
}
