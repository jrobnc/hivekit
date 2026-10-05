// Validation tests for the HiveKit Codex plugin.
// Checks plugin.json fields, SKILL.md frontmatter, size limits,
// and that CLI flags referenced in skills exist in --help output.
//
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..");
const PLUGIN_DIR = join(ROOT, "plugins", "hivekit");
const PLUGIN_JSON_PATH = join(PLUGIN_DIR, "plugin.json");
const PKG_JSON_PATH = join(ROOT, "package.json");
const CLI = join(ROOT, "dist", "index.js");
const MAX_SKILL_SIZE = 256 * 1024; // 256 KiB

// ── Helpers ──────────────────────────────────────────────────────────

function readJSON(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

/** Extract YAML frontmatter from a SKILL.md string. Returns { name, description } or null. */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fm = {};
  for (const line of match[1].split("\n")) {
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (m) fm[m[1]] = m[2].trim();
  }
  return fm.name && fm.description ? fm : null;
}

/** Extract --flags from a SKILL.md body (after frontmatter). */
function extractFlags(content) {
  const flags = new Set();
  // Match --word patterns, excluding table header separators
  for (const m of content.matchAll(/`--(\w[\w-]*)`/g)) {
    flags.add(`--${m[1]}`);
  }
  return flags;
}

// ── Load plugin data ─────────────────────────────────────────────────

const plugin = readJSON(PLUGIN_JSON_PATH);
const pkg = readJSON(PKG_JSON_PATH);

const skillsDir = resolve(PLUGIN_DIR, plugin.skills.replace(/^\.\//, ""));
const skillDirs = readdirSync(skillsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

// ── plugin.json tests ────────────────────────────────────────────────

test("plugin.json exists and parses as valid JSON", () => {
  // If we got here, readJSON succeeded
  assert.ok(plugin);
});

test("plugin.json has required fields", () => {
  for (const field of ["name", "version", "description", "skills"]) {
    assert.ok(plugin[field], `missing required field: ${field}`);
  }
});

test("plugin.json name <= 64 chars", () => {
  assert.ok(plugin.name.length <= 64, `name is ${plugin.name.length} chars`);
});

test("plugin.json displayName <= 30 chars", () => {
  if (plugin.displayName) {
    assert.ok(
      plugin.displayName.length <= 30,
      `displayName is ${plugin.displayName.length} chars`,
    );
  }
});

test("plugin.json shortDescription <= 30 chars", () => {
  if (plugin.shortDescription) {
    assert.ok(
      plugin.shortDescription.length <= 30,
      `shortDescription is ${plugin.shortDescription.length} chars`,
    );
  }
});

test("plugin.json version matches package.json version", () => {
  assert.equal(plugin.version, pkg.version);
});

test("plugin.json skills path resolves to a directory with skill subdirs", () => {
  assert.ok(
    skillDirs.length > 0,
    `skills directory has no subdirectories: ${skillsDir}`,
  );
});

// ── SKILL.md tests ───────────────────────────────────────────────────

for (const dir of skillDirs) {
  const skillPath = join(skillsDir, dir, "SKILL.md");

  test(`${dir}/SKILL.md exists`, () => {
    assert.ok(statSync(skillPath).isFile());
  });

  test(`${dir}/SKILL.md has YAML frontmatter with name and description`, () => {
    const content = readFileSync(skillPath, "utf-8");
    const fm = parseFrontmatter(content);
    assert.ok(fm, `${dir}/SKILL.md: missing or invalid YAML frontmatter`);
    assert.ok(fm.name, `${dir}/SKILL.md: frontmatter missing 'name'`);
    assert.ok(fm.description, `${dir}/SKILL.md: frontmatter missing 'description'`);
  });

  test(`${dir}/SKILL.md <= 256 KiB`, () => {
    const size = statSync(skillPath).size;
    assert.ok(size <= MAX_SKILL_SIZE, `${dir}/SKILL.md is ${size} bytes (max ${MAX_SKILL_SIZE})`);
  });
}

// ── CLI flag validation ──────────────────────────────────────────────

test("CLI flags referenced in skills exist in --help output", () => {
  // Get --help output
  const helpText = execFileSync("node", [CLI, "--help"], {
    encoding: "utf-8",
    timeout: 5000,
    env: { ...process.env, NODE_OPTIONS: "" },
  });

  // Extract known flags from help text
  const knownFlags = new Set();
  for (const m of helpText.matchAll(/--(\w[\w-]*)/g)) {
    knownFlags.add(`--${m[1]}`);
  }

  // Collect all flags from all skill files (skip the intent skill — it has no CLI commands)
  const missing = [];
  for (const dir of skillDirs) {
    const skillPath = join(skillsDir, dir, "SKILL.md");
    const content = readFileSync(skillPath, "utf-8");

    // Skip guidance-only skills (no CLI command)
    if (content.includes("does not run a CLI command")) continue;

    const flags = extractFlags(content);
    for (const flag of flags) {
      if (!knownFlags.has(flag)) {
        missing.push(`${dir}: ${flag}`);
      }
    }
  }

  assert.deepEqual(missing, [], `Unknown CLI flags in skills:\n${missing.join("\n")}`);
});

// The npm name "hivekit" belongs to an unrelated third-party package (texthive/hivekit). The plugin must
// never tell anyone to install it, and must point at the real repo.
test('plugin never installs the unrelated npm package "hivekit"', () => {
  const walk = (dir) => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
  const root = resolve(new URL('..', import.meta.url).pathname);
  const files = [...walk(join(root, 'plugins/hivekit')), join(root, 'docs/codex-plugin.md')];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    assert.doesNotMatch(text, /npm (install|i)( -g)? hivekit\b/, `${f} installs the unrelated npm package`);
    assert.doesNotMatch(text, /github\.com\/anthropics\/hivekit/, `${f} points at a non-existent repo`);
  }
});
