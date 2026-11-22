import { readFile } from "fs/promises";
import { extractSection, extractSuccessCriteria } from "./intent.js";
import type { AgentDef } from "./types.js";

// Agent definition = HIVE.md body + strict `key: value` front matter. See docs/AGENT_SPEC.md.
// Pure parsing; loadAgent is the only I/O. intent.ts re-exports this module, so only touch
// its imports inside function bodies (never at module top level).

export type { AgentDef } from "./types.js";
export type AgentParse = { ok: true; agent: AgentDef } | { ok: false; errors: string[] };

const KEYS = ["name", "description", "schedule", "project", "principal", "output", "budget_usd"];
const HHMM = "(?:[01]\\d|2[0-3]):[0-5]\\d";
const SCHEDULE_RE = new RegExp(`^(?:manual|(?:daily|weekdays) ${HHMM}|weekly (?:mon|tue|wed|thu|fri|sat|sun) ${HHMM})$`);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const clip = (s: string): string => (s.length > 60 ? `${s.slice(0, 60)}…` : s);

/** Parse one value (text after `key:`). Returns the string or an error message. */
function parseValue(key: string, rest: string): { value: string } | { error: string } {
  if (rest.startsWith('"')) {
    let out = "";
    let i = 1;
    for (; i < rest.length && rest[i] !== '"'; i++) {
      if (rest[i] === "\\") {
        const n = rest[++i];
        if (n !== '"' && n !== "\\") return { error: "malformed quoted value" };
        out += n;
      } else out += rest[i];
    }
    if (i >= rest.length || !/^\s*(?:\s#.*)?$/.test(rest.slice(i + 1))) return { error: "malformed quoted value" };
    return out ? { value: out } : { error: `empty value for "${key}"` };
  }
  const value = rest.split(/\s#/)[0].trim();
  if (/^[[{|>]/.test(value)) return { error: "lists, maps and multi-line values are not supported" };
  return value ? { value } : { error: `empty value for "${key}"` };
}

/** Parse an agent definition (no I/O). Collects every error, one line each. */
export function parseAgent(raw: string): AgentParse {
  const lines = raw.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0] !== "---") return { ok: false, errors: ['line 1: expected front matter opening "---"'] };
  const close = lines.indexOf("---", 1);
  if (close === -1) return { ok: false, errors: ['front matter: missing closing "---"'] };

  const errors: string[] = [];
  const kv = new Map<string, { value: string; line: number }>();
  for (let i = 1; i < close; i++) {
    const line = i + 1;
    if (!lines[i].trim() || lines[i].startsWith("#")) continue;
    const m = lines[i].match(/^([a-z_]+):(?:\s+(.*))?$/);
    if (!m) { errors.push(`line ${line}: expected "key: value"`); continue; }
    const key = m[1];
    const v = parseValue(key, m[2] ?? "");
    if ("error" in v) { errors.push(`line ${line}: ${v.error}`); continue; }
    if (!KEYS.includes(key)) { errors.push(`line ${line}: unknown key "${key}"`); continue; }
    if (kv.has(key)) { errors.push(`line ${line}: duplicate key "${key}"`); continue; }
    kv.set(key, { value: v.value, line });
  }

  const get = (k: string) => kv.get(k);
  const bad = (k: string, msg: string) => errors.push(`line ${get(k)!.line}: ${k} "${clip(get(k)!.value)}" ${msg}`);

  const name = get("name");
  if (!name) errors.push("name is required");
  else if (!/^[a-z][a-z0-9-]{1,39}$/.test(name.value)) bad("name", "must be 2-40 chars: lowercase letters, digits, hyphens, starting with a letter");
  const description = get("description");
  if (description && description.value.length > 200) errors.push(`line ${description.line}: description must be at most 200 characters`);
  const schedule = get("schedule");
  if (schedule && !SCHEDULE_RE.test(schedule.value)) bad("schedule", "must be manual, daily HH:MM, weekdays HH:MM or weekly <day> HH:MM");
  for (const k of ["project", "principal"]) {
    if (get(k) && !SLUG_RE.test(get(k)!.value)) bad(k, "must be lowercase letters, digits, hyphens (max 64), not starting with a hyphen");
  }
  const output = get("output");
  if (output && output.value !== "pr" && output.value !== "report") bad("output", "must be pr or report");
  const budget = get("budget_usd");
  let budgetUsd: number | undefined;
  if (budget) {
    budgetUsd = /^\d+(\.\d+)?$/.test(budget.value) ? Number(budget.value) : NaN;
    if (!(budgetUsd > 0 && budgetUsd <= 100)) bad("budget_usd", "must be a number > 0 and <= 100");
  }

  const body = lines.slice(close + 1).join("\n");
  const untagged: number[] = [];
  const successCriteria = extractSuccessCriteria(body, (n) => untagged.push(n));
  const objective = extractSection(body, "Objective");
  if (!objective) errors.push("body: ## Objective is required and must not be empty");
  if (!successCriteria.length) errors.push("body: ## Success Criteria needs at least one bullet");
  for (const n of untagged) errors.push(`body: criterion ${n} has no [auto], [judge] or [human] tag`);
  if (successCriteria.length && !successCriteria.some((c) => c.tier !== "human")) {
    errors.push("body: at least one criterion must be [auto] or [judge]");
  }
  successCriteria.forEach((c, i) => {
    if (c.tier === "auto" && !c.command) errors.push(`body: criterion ${i + 1} is [auto] but has no command`);
  });

  if (errors.length) return { ok: false, errors };
  const agent: AgentDef = {
    name: name!.value,
    schedule: schedule?.value ?? "manual",
    output: (output?.value as "pr" | "report" | undefined) ?? "pr",
    intent: { raw: body, objective, successCriteria },
    body,
  };
  if (description) agent.description = description.value;
  if (get("project")) agent.project = get("project")!.value;
  if (get("principal")) agent.principal = get("principal")!.value;
  if (budgetUsd !== undefined) agent.budgetUsd = budgetUsd;
  return { ok: true, agent };
}

export async function loadAgent(path: string): Promise<AgentParse> {
  try {
    return parseAgent(await readFile(path, "utf-8"));
  } catch {
    return { ok: false, errors: [`could not read ${path}`] };
  }
}
