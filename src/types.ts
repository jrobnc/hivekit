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

export interface EvaluationResult {
  scores: CriterionScore[];
  passed: boolean;
  feedback?: string;
  report: string;
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

/** Review dimensions scaled by depth */
export const REVIEW_DIMENSIONS: Record<Depth, string[]> = {
  quick: ["architecture", "bugs", "security"],
  standard: ["architecture", "bugs", "security", "performance", "ux"],
  deep: [
    "architecture",
    "bugs",
    "security",
    "performance",
    "ux",
    "platform",
    "consistency",
  ],
};
