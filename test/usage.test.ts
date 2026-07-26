import assert from "node:assert/strict";
import test from "node:test";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { __testUtils } from "../src/providers.js";

const {
  cumulativeToTurnBuckets,
  applyTurnUsage,
  readTokenBuckets,
  resetUsageTracking,
  setUsageBaselineForTest,
  getUsageBaselineForTest,
  setLastCallUsageForTest,
  setContextStatsUsedForTest,
  advanceBaselineFromCumulativeForTest,
} = __testUtils;

function makeModel(contextWindow = 256_000): Model<Api> {
  return {
    id: "grok-4.5",
    name: "Grok 4.5",
    api: "droid-exec" as Api,
    provider: "droid",
    baseUrl: "droid-exec://local",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 64_000,
  };
}

function makeAssistant(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "droid-exec",
    provider: "droid",
    model: "grok-4.5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

test.beforeEach(() => {
  resetUsageTracking();
  setLastCallUsageForTest(null);
  setContextStatsUsedForTest(undefined);
});

test("cumulativeToTurnBuckets subtracts session baseline", () => {
  setUsageBaselineForTest({ input: 100_000, output: 5_000, cacheRead: 1_000_000, cacheWrite: 0 });
  const turn = cumulativeToTurnBuckets({
    inputTokens: 130_000,
    outputTokens: 7_000,
    thinkingTokens: 500,
    cacheReadTokens: 1_200_000,
    cacheCreationTokens: 100,
  });
  assert.deepEqual(turn, {
    input: 30_000,
    output: 2_500,
    cacheRead: 200_000,
    cacheWrite: 100,
  });
});

test("applyTurnUsage caps totalTokens to contextWindow when no context stats", () => {
  const output = makeAssistant();
  const model = makeModel(256_000);
  applyTurnUsage(output, {
    input: 790_000,
    output: 110_000,
    cacheRead: 11_800_000,
    cacheWrite: 0,
  }, model, { preferLastCall: false });

  // Per-turn counters keep the deltas...
  assert.equal(output.usage.input, 790_000);
  assert.equal(output.usage.cacheRead, 11_800_000);
  assert.equal(output.usage.output, 110_000);
  // ...but context occupancy must not exceed the window (prevents 4983% compact loops).
  assert.equal(output.usage.totalTokens, 256_000);
});

test("applyTurnUsage prefers getContextStats used for totalTokens", () => {
  const output = makeAssistant();
  const model = makeModel(256_000);
  setContextStatsUsedForTest(42_000);
  applyTurnUsage(output, {
    input: 10_000,
    output: 500,
    cacheRead: 30_000,
    cacheWrite: 0,
  }, model, { preferLastCall: false });
  assert.equal(output.usage.totalTokens, 42_000);
  assert.equal(output.usage.input, 10_000);
  assert.equal(output.usage.cacheRead, 30_000);
});

test("preferLastCall keeps larger streamed output delta", () => {
  const output = makeAssistant();
  output.usage.output = 8_000;
  const model = makeModel();
  applyTurnUsage(output, {
    input: 12_000,
    output: 100,
    cacheRead: 40_000,
    cacheWrite: 0,
  }, model, { preferLastCall: true });
  assert.equal(output.usage.input, 12_000);
  assert.equal(output.usage.cacheRead, 40_000);
  assert.equal(output.usage.output, 8_000);
});

test("readTokenBuckets maps Droid notification fields", () => {
  assert.deepEqual(readTokenBuckets({
    inputTokens: 10,
    outputTokens: 3,
    thinkingTokens: 2,
    cacheReadTokens: 7,
    cacheCreationTokens: 1,
  }), {
    input: 10,
    output: 5,
    cacheRead: 7,
    cacheWrite: 1,
  });
  assert.equal(readTokenBuckets(null), null);
  assert.equal(readTokenBuckets({}), null);
});

test("baseline advances from cumulative snapshot", () => {
  advanceBaselineFromCumulativeForTest({
    input: 50_000,
    output: 2_000,
    cacheRead: 80_000,
    cacheWrite: 0,
  });
  assert.deepEqual(getUsageBaselineForTest(), {
    input: 50_000,
    output: 2_000,
    cacheRead: 80_000,
    cacheWrite: 0,
  });
  const next = cumulativeToTurnBuckets({
    inputTokens: 55_000,
    outputTokens: 2_500,
    cacheReadTokens: 90_000,
    cacheCreationTokens: 0,
  });
  assert.deepEqual(next, {
    input: 5_000,
    output: 500,
    cacheRead: 10_000,
    cacheWrite: 0,
  });
});
