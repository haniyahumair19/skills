import test from "node:test";
import assert from "node:assert/strict";
import { similarity, tokens, validateEvalSpec } from "../evaluate-new-skills.mjs";

test("tokenization ignores common words and normalizes case", () => {
  assert.deepEqual([...tokens("Make A Product Plan")].sort(), ["plan", "product"]);
});

test("similarity finds shared distinctive terms", () => {
  assert.equal(similarity("customer onboarding workflow", "customer onboarding checklist"), 0.5);
  assert.equal(similarity("database migration", "pricing research"), 0);
});

test("prompt eval spec requires three complete cases", () => {
  const valid = { skill_name: "demo", evals: Array.from({ length: 3 }, (_, i) => ({
    prompt: `Prompt ${i}`, expected_output: `Expected ${i}`, assertions: ["check"],
  })) };
  assert.equal(validateEvalSpec(valid), null);
  assert.match(validateEvalSpec({ ...valid, evals: valid.evals.slice(0, 2) }), /at least three/);
  assert.match(validateEvalSpec({ ...valid, evals: [{ prompt: "", expected_output: "", assertions: [] }] }), /at least three/);
});
