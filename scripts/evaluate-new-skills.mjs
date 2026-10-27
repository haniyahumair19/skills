#!/usr/bin/env node

/**
 * Evaluate newly added canonical skills before they merge:
 * - reject exact copies of an existing SKILL.md
 * - report similar skills for a human consolidation decision
 * - require prompt evals and run the skill's own test command when present
 * - require tests for skills that include executable scripts
 *
 * Prompt evals are checked as fixtures here; executing them against a model
 * requires a separately configured agent/model runner and credentials.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildSkillPathMap, parseSkillFrontmatter, REPO_ROOT } from "./lib/marketplace.mjs";

const SKILLS_DIR = path.join(REPO_ROOT, "skills");
const STOP_WORDS = new Set("a an and are as at be by can do for from has have how i in into is it its make of on or our that the their this to use when with you your skill skills help using".split(" "));

export function tokens(text) {
  return new Set((text.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []).filter((word) => !STOP_WORDS.has(word)));
}

export function similarity(left, right) {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}

export function validateEvalSpec(parsed) {
  if (!parsed || typeof parsed.skill_name !== "string" || !Array.isArray(parsed.evals) || parsed.evals.length < 3) {
    return "evals/evals.json must have skill_name and at least three eval cases";
  }
  for (const [index, item] of parsed.evals.entries()) {
    if (!item.prompt?.trim() || !item.expected_output?.trim() || !Array.isArray(item.assertions) || item.assertions.length === 0) {
      return `eval case ${index + 1} needs prompt, expected_output, and at least one assertion`;
    }
  }
  return null;
}

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function addedSkillDirs(base) {
  const output = git(["diff", "--name-only", "--diff-filter=A", `${base}...HEAD`, "--", "skills/**/SKILL.md"]);
  return output ? output.split("\n").map((file) => path.dirname(path.join(REPO_ROOT, file))) : [];
}

function runTestCommand(skillDir, pkg) {
  if (!pkg.scripts?.test) return false;
  console.log(`Running ${path.relative(REPO_ROOT, skillDir)}: npm test --if-present`);
  execFileSync("npm", ["test", "--if-present"], { cwd: skillDir, stdio: "inherit" });
  return true;
}

function main() {
  const baseIndex = process.argv.indexOf("--base");
  let base = (baseIndex >= 0 ? process.argv[baseIndex + 1] : undefined) || process.env.SKILL_EVAL_BASE;
  if (!base) throw new Error("Provide --base <git ref> or SKILL_EVAL_BASE");
  if (/^0+$/.test(base)) base = git(["rev-parse", "HEAD^"]);

  const changed = addedSkillDirs(base);
  if (changed.length === 0) {
    console.log("No newly added canonical skills in this change; skipping skill evaluation.");
    return;
  }

  const current = buildSkillPathMap();
  const additions = new Set(changed.map((dir) => path.resolve(dir)));
  const baseline = [...current.entries()].filter(([, dir]) => !additions.has(path.resolve(dir)));
  let failures = 0;

  for (const skillDir of changed) {
    const skillFile = path.join(skillDir, "SKILL.md");
    const name = path.basename(skillDir);
    if (!fs.existsSync(skillFile)) continue;
    const body = fs.readFileSync(skillFile, "utf8").replace(/\r\n/g, "\n").trim();
    const frontmatter = parseSkillFrontmatter(skillDir);
    console.log(`\nEvaluating new skill: ${path.relative(REPO_ROOT, skillDir)}`);

    const comparisonSet = [...baseline, ...[...current.entries()].filter(([, dir]) =>
      additions.has(path.resolve(dir)) && path.resolve(dir) !== path.resolve(skillDir))];
    for (const [existingName, existingDir] of comparisonSet) {
      const existingBody = fs.readFileSync(path.join(existingDir, "SKILL.md"), "utf8").replace(/\r\n/g, "\n").trim();
      if (body === existingBody) {
        console.error(`FAIL: exact duplicate of ${existingName} (${path.relative(REPO_ROOT, existingDir)})`);
        failures++;
        break;
      }
    }

    const description = frontmatter?.description ?? "";
    const candidates = comparisonSet.map(([existingName, dir]) => {
      const other = parseSkillFrontmatter(dir);
      const otherText = `${other?.description ?? ""} ${fs.readFileSync(path.join(dir, "SKILL.md"), "utf8").split("\n").slice(0, 35).join(" ")}`;
      const score = similarity(`${description} ${body.split("\n").slice(0, 35).join(" ")}`, otherText);
      return { existingName, dir, score };
    }).filter((candidate) => candidate.score >= 0.28).sort((a, b) => b.score - a.score).slice(0, 5);
    if (candidates.length) {
      console.warn("Review possible overlap (heuristic; not an automatic rejection):");
      for (const candidate of candidates) console.warn(`  ${candidate.existingName}: ${(candidate.score * 100).toFixed(0)}% token overlap (${path.relative(REPO_ROOT, candidate.dir)})`);
    }

    const evalFile = path.join(skillDir, "evals/evals.json");
    if (!fs.existsSync(evalFile)) {
      console.error("FAIL: add evals/evals.json with at least three prompt cases and assertions");
      failures++;
    } else {
      try {
        const issue = validateEvalSpec(JSON.parse(fs.readFileSync(evalFile, "utf8")));
        if (issue) { console.error(`FAIL: ${issue}`); failures++; }
        else console.log("PASS: prompt evaluation fixtures are present and structurally complete");
      } catch (error) { console.error(`FAIL: invalid evals/evals.json (${error.message})`); failures++; }
    }

    const pkgFile = path.join(skillDir, "package.json");
    const pkg = fs.existsSync(pkgFile) ? JSON.parse(fs.readFileSync(pkgFile, "utf8")) : {};
    const hasExecutableAssets = ["scripts", "bin"].some((dir) => fs.existsSync(path.join(skillDir, dir)));
    if (hasExecutableAssets && !pkg.scripts?.test) {
      console.error("FAIL: executable skill assets require a package.json test script");
      failures++;
    } else if (pkg.scripts?.test) {
      try { runTestCommand(skillDir, pkg); console.log("PASS: skill test command completed"); }
      catch (error) { console.error(`FAIL: test command failed (${error.message})`); failures++; }
    } else {
      console.log("INFO: instruction-only skill; its prompt cases are fixtures, not model-executed in this CI job");
    }
    console.log(`Completed checks for ${name}`);
  }

  if (failures) process.exitCode = 1;
  else console.log("\nNew-skill evaluation checks passed. Review overlap suggestions before merging.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
