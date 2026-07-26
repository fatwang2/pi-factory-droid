import assert from "node:assert/strict";
import test from "node:test";
import { ModelProvider, ReasoningEffort, type AvailableModelConfig } from "@factory/droid-sdk";
import { accountModels, fallbackModels, thinkingLevelMap } from "../src/catalog.js";
import { SNAPSHOT_MODELS } from "../src/catalog.generated.js";

test("fallback catalog tracks current Factory families", () => {
  const ids = new Set(fallbackModels({}).map((model) => model.piModel.id));
  for (const id of ["auto", "claude-opus-5", "gpt-5.6-sol", "gemini-3.6-flash", "grok-4.5", "glm-5.2"]) {
    assert.equal(ids.has(id), true, `missing ${id}`);
  }
  assert.equal(ids.has("claude-opus-4-7-fast"), false);
});

test("fallback catalog prefers generated snapshot over hand-maintained FALLBACK_ROWS when present", () => {
  if (SNAPSHOT_MODELS.length === 0) {
    // Snapshot not yet generated; skip rather than fail on a clean checkout.
    return;
  }
  const ids = new Set(fallbackModels({}).map((model) => model.piModel.id));
  for (const model of SNAPSHOT_MODELS) {
    assert.equal(ids.has(model.id), true, `snapshot model ${model.id} missing from fallbackModels()`);
  }
});

test("account catalog exposes only models returned for the credential", () => {
  const available: AvailableModelConfig[] = [{
    id: "claude-opus-5",
    modelId: "claude-opus-5",
    displayName: "Claude Opus 5",
    shortDisplayName: "Opus 5",
    modelProvider: ModelProvider.ANTHROPIC,
    supportedReasoningEfforts: [ReasoningEffort.Off, ReasoningEffort.High, ReasoningEffort.Max],
    defaultReasoningEffort: ReasoningEffort.High,
    isCustom: false,
    noImageSupport: false,
    tokenMultiplier: 2,
  }];
  const models = accountModels(available, {});
  assert.equal(models.length, 1);
  assert.equal(models[0]?.piModel.id, "claude-opus-5");
  assert.deepEqual(models[0]?.piModel.input, ["text", "image"]);
  assert.equal(models[0]?.piModel.thinkingLevelMap?.high, "high");
  assert.equal(models[0]?.piModel.thinkingLevelMap?.medium, null);
  assert.equal(models[0]?.tokenMultiplier, 2);
});

test("reasoning map translates OpenAI none into Pi off", () => {
  const map = thinkingLevelMap([ReasoningEffort.None, ReasoningEffort.Low, ReasoningEffort.ExtraHigh]);
  assert.equal(map?.off, "none");
  assert.equal(map?.low, "low");
  assert.equal(map?.xhigh, "xhigh");
  assert.equal(map?.high, null);
});
