import type { Mode } from "../types.js";

export type Role = "plan" | "build" | "review" | "evaluate" | "advise" | "build-escalated" | "advise-escalated";
export type Effort = "low" | "medium" | "high" | "max";

export interface ProviderRunInput {
  prompt: string;
  /** Concrete model id, already resolved by runAgent via provider.modelFor(role) */
  model: string;
  effort?: Effort;
  cwd?: string;
  allowedTools: string[];
  /** PermissionMode-like string; the claude adapter casts it to the SDK type */
  permissionMode: string;
  maxTurns: number;
  maxBudgetUsd?: number;
  /** Review mode must not load the reviewed repo's settings/hooks (claude adapter). Other providers ignore it. */
  mode?: Mode;
  onProgress?: (indicator: string) => void;
}

export interface ProviderRunOutput {
  result: string;
  sessionId: string;
  durationMs: number;
  totalCostUsd: number;
  isError: boolean;
  subtype?: string;
  turns: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  model: string;
  /** Set when the stream threw after (possibly) yielding a result; runAgent rethrows it. */
  thrown?: unknown;
}

export interface Provider {
  /** "claude" | "openai-compatible" */
  readonly name: string;
  modelFor(role: Role): string;
  run(input: ProviderRunInput): Promise<ProviderRunOutput>;
}
