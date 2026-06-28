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

  console.log(`[planner] Starting ${config.mode} planning...`);

  const { durationMs } = await runAgent({
    prompt,
    model: "opus",
    cwd: config.cwd,
    allowedTools: ["Read", "Glob", "Grep", "Bash", "Write"],
    permissionMode: "acceptEdits",
    maxTurns: config.maxTurns ?? 30,
    onProgress: () => process.stdout.write("."),
  });

  console.log(`\n[planner] Done (${Math.round(durationMs / 1000)}s)`);
  console.log(`[planner] Plan: ${planPath}`);

  let planContent: string;
  try {
    planContent = await readFile(planPath, "utf-8");
  } catch {
    throw new Error(
      `Planner agent did not write ${planPath}. The agent may have treated the brief as the spec and exited without calling Write. Workaround: pass a pre-written plan via --plan <path> to skip this phase.`
    );
  }
  if (planContent.trim().length === 0) {
    throw new Error(
      `Planner wrote an empty plan to ${planPath}. The agent called Write but with no content. Workaround: pass a pre-written plan via --plan <path>.`
    );
  }
  return { planPath, planContent };
}
