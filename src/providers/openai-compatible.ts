import { randomUUID } from "crypto";
import { z } from "zod";
import { TOOL_DEFS, runTool } from "./tools.js";
import type { Provider, ProviderRunInput, ProviderRunOutput, Role } from "./types.js";

export const OpenAICompatibleConfigSchema = z.object({
  name: z.literal("openai-compatible"),
  baseUrl: z.string().url(),
  apiKeyEnv: z.string().min(1).optional(),
  models: z.object({ frontier: z.string().min(1), workhorse: z.string().min(1) }),
  pricesUsdPerMTok: z
    .record(z.string(), z.object({ input: z.number().nonnegative(), output: z.number().nonnegative() }))
    .optional(),
});
export type OpenAICompatibleConfig = z.infer<typeof OpenAICompatibleConfigSchema>;

/** Mirrors Claude's split: frontier plans/judges/advises, workhorse does the volume. */
export const ROLE_TIER = {
  plan: "frontier",
  evaluate: "frontier",
  advise: "frontier",
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
      const url = `${base}/chat/completions`;
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

      while (turns < input.maxTurns) {
        const res = await fetch(url, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ model: input.model, messages, ...(tools.length ? { tools } : {}) }),
        });
        if (!res.ok) {
          throw new Error(`openai-compatible: POST ${url} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
        }
        const body: any = await res.json();
        const message = body?.choices?.[0]?.message;
        if (!message) throw new Error(`openai-compatible: POST ${url} returned no choices[0].message`);
        turns++;
        input.onProgress?.(".");
        usage.input_tokens += Number(body.usage?.prompt_tokens ?? 0);
        usage.output_tokens += Number(body.usage?.completion_tokens ?? 0);
        messages.push(message);
        last = message.content ?? "";

        if (!message.tool_calls?.length) return out({});

        for (const call of message.tool_calls) {
          const content = await runTool(call.function?.name, call.function?.arguments, {
            cwd: input.cwd,
            allowedTools: input.allowedTools,
          });
          messages.push({ role: "tool", tool_call_id: call.id, content });
        }
        if (input.maxBudgetUsd !== undefined && cost() > input.maxBudgetUsd) {
          return out({ isError: true, subtype: "error_max_budget_usd" });
        }
      }
      return out({ isError: true, subtype: "error_max_turns" });
    },

    async preflight() {
      const url = `${base}/models`;
      let status: number | string;
      try {
        status = (await fetch(url, { headers: headers() })).status;
      } catch (err) {
        status = err instanceof Error ? err.message : String(err);
      }
      if (status !== 200) throw new Error(`openai-compatible preflight: ${url} → ${status}`);
    },
  };
}
