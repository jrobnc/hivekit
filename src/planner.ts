import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { runAgent, fillTemplate, loadPrinciples } from "./sdk-utils.js";
import type { RunContext, PlannerOutput } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runPlanner(ctx: RunContext): Promise<PlannerOutput> {
  const { config, runId, runDir } = ctx;
  const planPath = join(runDir, "plan.md");

  const template = await readFile(
    join(__dirname, "prompts", `planner-${config.mode}.md`),
    "utf-8"
  );

  const prompt = fillTemplate(template, {
    task: config.task,
    focus: config.focus ?? "entire codebase",
    depth: config.depth,
    planPath,
    runId,
    principles: await loadPrinciples(),
  });

  const agentOpts = {
    model: "opus" as const,
    cwd: config.cwd,
    allowedTools: ["Read", "Glob", "Grep", "Bash", "Write"],
    permissionMode: "acceptEdits" as const,
    maxTurns: config.maxTurns ?? 30,
    onProgress: () => process.stdout.write("."),
  };

  console.log(`[planner] Starting ${config.mode} planning...`);
  const { durationMs: firstDuration } = await runAgent({ prompt, ...agentOpts });
  console.log(`\n[planner] First attempt done (${Math.round(firstDuration / 1000)}s)`);

  let planContent: string | undefined;
  try {
    const raw = await readFile(planPath, "utf-8");
    if (raw.trim().length > 0) planContent = raw;
  } catch {
    // plan.md not written — will retry
  }

  if (!planContent) {
    console.warn("[planner] Plan not written — retrying with explicit Write instruction...");
    const retryPrompt = prompt +
      "\n\nCRITICAL: You MUST call the Write tool to write your complete plan to `" +
      planPath + "` before finishing. Do NOT exit without writing the plan file. This is a hard requirement.";
    const { durationMs } = await runAgent({ prompt: retryPrompt, ...agentOpts });
    console.log(`\n[planner] Retry done (${Math.round(durationMs / 1000)}s)`);

    try {
      planContent = await readFile(planPath, "utf-8");
    } catch {
      throw new Error(
        `Planner agent did not write ${planPath} even after retry. Workaround: pass a pre-written plan via --plan <path>.`
      );
    }
    if (planContent.trim().length === 0) {
      throw new Error(
        `Planner wrote an empty plan to ${planPath} even after retry. Workaround: pass a pre-written plan via --plan <path>.`
      );
    }
  }

  console.log(`[planner] Plan: ${planPath}`);
  return { planPath, planContent };
}
