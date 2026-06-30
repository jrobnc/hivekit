import { readFile } from "fs/promises";
import type { Criterion, IntentDoc } from "./types.js";

// HIVE.md — intent-as-source loader. See docs/HIVE_SPEC.md.
// Deliberately lenient: the Planner reads the markdown and compiles it; the ONLY
// structured extraction we need is the Success Criteria + their verifier tiers,
// because those become the Evaluator's pinned rubric.

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Return the body of a `## Heading` section, up to the next h1/h2 or EOF. */
export function extractSection(raw: string, heading: string): string {
  const lines = raw.split(/\r?\n/);
  const headRe = new RegExp(`^##\\s+${escapeRe(heading)}\\s*$`, "i");
  const start = lines.findIndex((l) => headRe.test(l));
  if (start === -1) return "";
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s+/.test(lines[i])) break; // next h1/h2 ends the section
    out.push(lines[i]);
  }
  return out.join("\n").trim();
}

/** Parse the `## Success Criteria` bullets into tagged criteria.
 *  `- [auto|judge|human] text` → that tier; an untagged bullet defaults to
 *  `human` (fail safe — never silently auto-pass an unspecified criterion). */
export function extractSuccessCriteria(raw: string): Criterion[] {
  const section = extractSection(raw, "Success Criteria");
  if (!section) return [];
  const crits: Criterion[] = [];
  for (const line of section.split(/\r?\n/)) {
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (!bullet) continue; // only bullet lines are criteria
    const body = bullet[1].trim();
    const tagged = body.match(/^\[(auto|judge|human)\]\s*(.+)$/i);
    if (tagged) {
      crits.push({ tier: tagged[1].toLowerCase() as Criterion["tier"], text: tagged[2].trim() });
    } else {
      crits.push({ tier: "human", text: body });
    }
  }
  return crits;
}

export async function loadIntent(path: string): Promise<IntentDoc> {
  const raw = await readFile(path, "utf-8");
  return {
    raw,
    objective: extractSection(raw, "Objective"),
    successCriteria: extractSuccessCriteria(raw),
  };
}

/** Build the Planner's task string from an intent doc — the "compile" step.
 *  The whole HIVE.md is handed over so Objective/Constraints/Out-of-scope/Evidence
 *  all reach the Planner; no template change is needed (it fills {{task}}). */
export function intentCompilePreamble(intent: IntentDoc): string {
  return `You are compiling a HIVE.md intent file into a build plan. It states the desired
outcome and how "done" is judged. Read it in full — Objective, Constraints, Out of Scope,
Evidence — and compile it into the plan. The Success Criteria are the pinned acceptance
rubric the evaluator will grade against; design the sprints to satisfy them, and respect
Out of Scope as a hard boundary.

--- HIVE.md ---
${intent.raw}
--- end HIVE.md ---`;
}

// ── Structured (YAML) emit — opt-in machine view via --yaml ──────────
// Markdown stays the source of truth; this is a compiled, machine-readable view
// for downstream tooling. No YAML dependency: block scalars (|) need no escaping,
// and single-line criteria text is double-quoted with \ and " escaped.

function yamlBlock(key: string, value: string): string {
  const body = (value || "")
    .split(/\r?\n/)
    .map((l) => "  " + l) // 2-space indent under the key
    .join("\n");
  return `${key}: |\n${body}`;
}

function yamlQuote(s: string): string {
  const oneLine = s.replace(/\r?\n/g, " ").trim();
  return `"${oneLine.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Compile an IntentDoc into a structured YAML view (the --yaml artifact). */
export function toIntentYaml(intent: IntentDoc): string {
  const out: string[] = [
    "# Compiled from HIVE.md by hivekit — structured view for tooling.",
    "# Markdown remains the source of truth; regenerate with --yaml.",
    yamlBlock("objective", intent.objective),
  ];
  const constraints = extractSection(intent.raw, "Constraints");
  const outOfScope = extractSection(intent.raw, "Out of Scope");
  if (constraints) out.push(yamlBlock("constraints", constraints));
  if (outOfScope) out.push(yamlBlock("out_of_scope", outOfScope));
  if (intent.successCriteria.length === 0) {
    out.push("success_criteria: []");
  } else {
    out.push("success_criteria:");
    for (const c of intent.successCriteria) {
      out.push(`  - tier: ${c.tier}`);
      out.push(`    text: ${yamlQuote(c.text)}`);
    }
  }
  return out.join("\n") + "\n";
}

/** Render the pinned criteria + tier-routing instructions for the Evaluator.
 *  Empty string when there is no intent (preserves the prior bare-task behavior). */
export function formatCriteriaForEvaluator(intent?: IntentDoc): string {
  if (!intent || intent.successCriteria.length === 0) return "";
  const lines = intent.successCriteria
    .map((c, i) => `${i + 1}. [${c.tier}] ${c.text}`)
    .join("\n");
  return `## Pinned Success Criteria — grade against THESE (from HIVE.md)

These are human-authored acceptance criteria. Grade against them verbatim; do not substitute
criteria you infer. Each carries a verifier tier:
- [auto]  → RUN the actual check (test/command) and gate on the real result, not your impression.
- [judge] → score against the criterion; be skeptical, default conservative.
- [human] → you CANNOT pass this. Report it as PENDING HUMAN SIGN-OFF. Never mark a [human]
            criterion done, and do NOT emit EVALUATION: FAIL solely because it is unverified.
            Base pass/fail ONLY on the [auto] and [judge] criteria; list [human] items as gates.

Criteria:
${lines}

If any [human] gates remain, state them explicitly in the report under "Pending human sign-off".
`;
}
