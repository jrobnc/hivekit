import { readFileSync } from "fs";
import { z } from "zod";
import { claudeProvider } from "./claude.js";
import { OpenAICompatibleConfigSchema, createOpenAICompatibleProvider } from "./openai-compatible.js";
import type { Provider } from "./types.js";

/** Selects the provider from env. No caching and no fallback: a bad value is an error. */
export function getProvider(env: NodeJS.ProcessEnv = process.env): Provider {
  const name = env.HIVEKIT_PROVIDER || "claude";
  if (name === "claude") return claudeProvider;
  if (name !== "openai-compatible") {
    throw new Error(`unknown HIVEKIT_PROVIDER "${name}" (expected "claude" or "openai-compatible")`);
  }
  const path = env.HIVEKIT_PROVIDER_CONFIG;
  if (!path) throw new Error("HIVEKIT_PROVIDER=openai-compatible requires HIVEKIT_PROVIDER_CONFIG (path to a JSON provider config)");
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(`cannot read HIVEKIT_PROVIDER_CONFIG ${path}: ${err instanceof Error ? err.message : err}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`HIVEKIT_PROVIDER_CONFIG ${path} is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
  const parsed = OpenAICompatibleConfigSchema.safeParse(json);
  if (!parsed.success) throw new Error(`invalid HIVEKIT_PROVIDER_CONFIG ${path}: ${z.prettifyError(parsed.error)}`);
  const cap = Number(env.HIVEKIT_MAX_USD_PER_AGENT); // same "unset" semantics as positiveNumber (not imported: circular)
  if (Number.isFinite(cap) && cap > 0) {
    for (const model of [parsed.data.models.frontier, parsed.data.models.workhorse]) {
      if (!parsed.data.pricesUsdPerMTok?.[model]) {
        throw new Error(`HIVEKIT_MAX_USD_PER_AGENT is set but ${path} has no pricesUsdPerMTok entry for model "${model}"; add one or unset the cap`);
      }
    }
  }
  return createOpenAICompatibleProvider(parsed.data);
}
