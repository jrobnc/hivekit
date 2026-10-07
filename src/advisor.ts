import { readFile, appendFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { join, dirname } from "path";
import { runAgent, TIERS, LEDGER, positiveNumber } from "./sdk-utils.js";

// ── Jev: cheap yes/no forks ─────────────────────────────────────────
// TypeSafe System One answers structured questions in well under a second at
// $0.042/MTok input (output free). Sharp answers stay in code; split answers,
// or no key, return null and the caller escalates to a model.
//
// Jev is a third-party service, so it is opt-in (HIVEKIT_JEV=1), the text is
// masked and capped before it leaves, and spend is capped per key via the ledger.

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = process.env.JEV_MODEL ?? "jev-1.13.0"; // pinned: jev-latest drifts
const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000; // output tokens are free
const JEV_BUDGET_USD = positiveNumber(process.env.HIVEKIT_JEV_BUDGET) ?? 25; // invalid -> default, never NaN
const JEV_MAX_CHARS = 4000;

/** Masks email addresses and phone numbers and caps length; comparing failures never needs them. */
export function maskForJev(text: string): string {
  // ponytail: the phone pattern also eats long digit runs such as dates; harmless for "same failure?"
  return text
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone]")
    .slice(0, JEV_MAX_CHARS);
}

async function jevSpentUsd(): Promise<number> {
  try {
    const raw = await readFile(LEDGER, "utf-8");
    let usd = 0;
    for (const line of raw.split("\n")) {
      if (!line.includes('"label":"jev"')) continue;
      usd += JSON.parse(line).usd ?? 0;
    }
    return usd;
  } catch {
    return 0;
  }
}

async function jevKey(): Promise<string | null> {
  if (process.env.JEV_API_KEY) return process.env.JEV_API_KEY;
  try {
    const raw = await readFile(join(homedir(), ".config", "jev", "credentials"), "utf-8");
    return raw.match(/JEV_API_KEY\s*=\s*["']?([^\s"']+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** true / false when Jev is sharp (>= 0.8 / <= 0.2); null when split or unavailable. */
export async function jevYesNo(state: string, question: string): Promise<boolean | null> {
  if (process.env.HIVEKIT_JEV !== "1") return null;
  const key = await jevKey();
  if (!key) return null;
  if ((await jevSpentUsd()) >= JEV_BUDGET_USD) {
    console.warn(`[jev] budget $${JEV_BUDGET_USD} reached (ledger); escalating instead`);
    return null;
  }
  try {
    const r = await fetch(JEV_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        state: maskForJev(state),
        model: JEV_MODEL,
        questions: { q: { type: "noul", instructions: question } },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const tok = Number(d?.usage?.input_tokens ?? 0);
    await mkdir(dirname(LEDGER), { recursive: true });
    await appendFile(
      LEDGER,
      JSON.stringify({ ts: new Date().toISOString(), label: "jev", model: JEV_MODEL, usd: tok * JEV_USD_PER_INPUT_TOKEN, tokens: tok }) + "\n",
      "utf-8"
    );
    const p = d?.answers?.q?.noul;
    if (typeof p !== "number") return null;
    return p >= 0.8 ? true : p <= 0.2 ? false : null;
  } catch {
    return null;
  }
}

// ── Advisor: Fable at three checkpoints, never writes code ──────────

export type Checkpoint = "plan" | "stuck" | "done";

const ASKS: Record<Checkpoint, string> = {
  plan: "A plan is about to be executed. Is it the right call for the objective? Look for a wrong approach, a missed constraint, or scope creep.",
  stuck: "The evaluator failure has come back. Is the generator going in circles? Name the root cause and the one change that breaks the loop.",
  done: "The evaluator just passed this work. Was anything skipped, faked, or left unverified? Check the actual diff (git diff), not the report's claims.",
};

export interface Advice {
  ok: boolean;
  note: string;
}

export async function advise(checkpoint: Checkpoint, cwd: string, context: string): Promise<Advice> {
  if (process.env.HIVEKIT_ADVISOR === "0") return { ok: true, note: "advisor off" };
  try {
    const { result } = await runAgent({
      ...TIERS.advise,
      label: `advisor-${checkpoint}`,
      cwd,
      allowedTools: ["Read", "Glob", "Grep", "Bash"],
      maxTurns: 15,
      prompt: `You are a silent advisor on a Planner -> Generator -> Evaluator run. ${ASKS[checkpoint]}

You never write or edit files. Speak only if something is actually wrong.
First line: exactly OK or OBJECTION. Then at most five short lines of reasons.

${context}`,
    });
    return { ok: !/^\s*OBJECTION/i.test(result), note: result.trim() };
  } catch (err) {
    // An unavailable advisor must not sink the run; say so and carry on.
    return { ok: true, note: `advisor unavailable: ${err instanceof Error ? err.message : err}` };
  }
}
