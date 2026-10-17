// Turn-limit policy: resolution, counting, messages. Pure and SDK-free so outcome.ts and tests can import it.
import type { HarnessConfig, Mode, TurnLimits, TurnPhase } from "./types.js";

export type { TurnLimits, TurnPhase };

export const PLANNER_BASE_TURNS = 60;
export const PLANNER_SCALED_CAP = 150;

/** Distinct path-like tokens in the task text. Inclusive on purpose: over-counting only raises a bounded cap. */
export function countSpecPaths(task: string): number {
  const found = new Set<string>();
  for (const raw of task.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ").split(/\s+/)) {
    const tok = raw
      .replace(/^[("'`[<]+/, "")
      .replace(/[)"'`\]>,;.!?]+$/, "")
      .replace(/:\d+(:\d+)?$/, "")
      .replace(/[.,;]+$/, "");
    if (/[\w.~-]\/[\w.~-]|[\w.~-]\/$/.test(tok) || /\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(tok)) found.add(tok);
  }
  return found.size;
}

function positiveInt(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
}

export function resolveTurnLimits(
  config: Pick<HarnessConfig, "task" | "mode" | "maxTurns" | "turns">,
  env: Record<string, string | undefined> = process.env
): TurnLimits {
  const specPaths = countSpecPaths(config.task ?? "");
  const defaults: Record<TurnPhase, number> = {
    planner: Math.min(PLANNER_SCALED_CAP, PLANNER_BASE_TURNS + specPaths),
    generator: config.mode === "improve" ? 60 : 100,
    evaluator: 40,
    review: 40,
  };
  const pick = (p: TurnPhase): number =>
    config.turns?.[p] ??
    config.maxTurns ??
    positiveInt(env[`HIVEKIT_${p.toUpperCase()}_TURNS`]) ??
    positiveInt(env.HIVEKIT_MAX_TURNS) ??
    defaults[p];
  return { planner: pick("planner"), generator: pick("generator"), evaluator: pick("evaluator"), review: pick("review"), specPaths };
}

export function describeTurnLimits(limits: TurnLimits, mode: Mode): string {
  const mid = mode === "review" ? `review ${limits.review}` : `generator ${limits.generator}`;
  return `planner ${limits.planner} · ${mid} · evaluator ${limits.evaluator} (spec paths: ${limits.specPaths})`;
}

export function turnCapMessage(phase: TurnPhase, cap: number, specPaths?: number): string {
  const base = `${phase} hit its turn cap (${cap} turns). Raise it with --${phase}-turns <N> or HIVEKIT_${phase.toUpperCase()}_TURNS=<N> (or --max-turns <N> for every phase).`;
  return phase === "planner" && specPaths !== undefined
    ? `${base} The spec referenced ${specPaths} file path(s); the planner default is ${PLANNER_BASE_TURNS} + 1 per path, capped at ${PLANNER_SCALED_CAP}.`
    : base;
}
