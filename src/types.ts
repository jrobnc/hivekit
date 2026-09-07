export type Mode = "review" | "build" | "improve";
export type Depth = "quick" | "standard" | "deep";

/** A HIVE.md Success Criterion and how it is verified (see docs/HIVE_SPEC.md). */
export type VerifierTier = "auto" | "judge" | "human";
export interface Criterion {
  tier: VerifierTier;
  text: string;
}
export interface IntentDoc {
  raw: string;
  objective: string;
  successCriteria: Criterion[];
}

export interface HarnessConfig {
  task: string;
  mode: Mode;
  depth: Depth;
  focus?: string;
  name?: string;
  cwd: string;
  maxEvalRounds: number;
  evalThreshold: number;
  /** Scope build to a specific sprint number from the plan */
  sprint?: number;
  /** Reuse an existing plan file instead of running the planner */
  planFile?: string;
  /** Path to a HIVE.md / intent.md that drives the run (intent-as-source) */
  intentFile?: string;
  /** Also emit a structured intent.yaml alongside the markdown artifacts */
  emitYaml?: boolean;
  /** Max turns per agent (default: 100 for build, 60 for improve, 40 for review) */
  maxTurns?: number;
  /** Whether --mode was explicitly provided on the command line */
  explicitMode?: boolean;
}

export interface RunContext {
  runId: string;
  runDir: string;
  indexPath: string;
  config: HarnessConfig;
  /** Parsed HIVE.md driving this run, if any (Success Criteria pin the rubric) */
  intent?: IntentDoc;
}

export interface Finding {
  severity: "critical" | "high" | "medium" | "low" | "info";
  file: string;
  line?: number;
  title: string;
  detail: string;
  suggestion: string;
  confidence: number;
}

export interface DimensionFindings {
  dimension: string;
  agent: string;
  runId: string;
  findings: Finding[];
}

export interface CriterionScore {
  criterion: string;
  score: number;
  assessment: string;
}

/**
 * Terminal verdict of one evaluator round.
 *
 * `failed` and `errored` are deliberately distinct: `failed` means the evaluator
 * judged the work and rejected it; `errored` means the evaluator could not
 * produce a usable judgement at all (crash, empty output, unparseable
 * scorecard). Both are non-passing, but callers must be able to tell "the code
 * is bad" from "we never actually verified anything".
 */
export type EvaluationStatus = "passed" | "failed" | "errored";

/** Machine-readable reason behind an EvaluationStatus. */
export type EvaluationReason =
  | "all_scores_above_threshold"
  | "explicit_fail_marker"
  | "below_threshold"
  | "empty_output"
  | "no_parseable_scores"
  | "insufficient_criteria"
  | "missing_criteria"
  | "no_pass_assertion"
  | "malformed_scores"
  | "agent_error";

export interface EvaluationResult {
  scores: CriterionScore[];
  /** Authoritative verdict for this round. */
  status: EvaluationStatus;
  /** Why `status` is what it is. */
  reason: EvaluationReason;
  /** Convenience mirror of `status === "passed"`. Never set independently. */
  passed: boolean;
  feedback?: string;
  report: string;
}

/**
 * Terminal outcome of a whole hivekit run. This is the value the exit code,
 * result.json and the human report are all derived from — there is exactly one
 * source of truth for "did this run verify anything".
 */
export type RunOutcome =
  | "passed"
  | "failed"
  | "errored"
  | "max_rounds_exhausted"
  | "review_completed"
  | "crashed";

/** Machine-readable run result written to {runDir}/result.json. */
export interface RunResult {
  schemaVersion: 1;
  runId: string;
  mode: Mode;
  /** Precise terminal state — the discriminator callers should switch on. */
  outcome: RunOutcome;
  /** Coarse verdict: "PASSED" | "FAILED" | "REVIEW_COMPLETED". Never "PASS". */
  result: string;
  /** True only for outcomes that represent verified success. */
  ok: boolean;
  exitCode: number;
  evaluator: {
    status: EvaluationStatus | "not_reached";
    reason: EvaluationReason | "not_reached";
    roundsRun: number;
    maxRounds: number;
    threshold: number;
    scores: CriterionScore[];
  };
  reportPath: string;
  /** Populated only when outcome === "crashed". */
  error?: string;
  timestamp: string;
}

export interface PlannerOutput {
  planPath: string;
  planContent: string;
}

export interface GeneratorOutput {
  mode: Mode;
  findings?: DimensionFindings[];
  progressPath?: string;
}

