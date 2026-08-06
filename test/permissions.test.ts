import assert from "node:assert/strict";
import test from "node:test";
import { ToolConfirmationOutcome } from "@factory/droid-sdk";
import { __testUtils } from "../src/providers.js";
import type { ResolvedConfig } from "../src/types.js";

const { createPermissionHandler, isPromptAlwaysEnabled } = __testUtils;

function makeCfg(autoLevel: "low" | "medium" | "high"): ResolvedConfig {
  return {
    droidBinary: "droid",
    autoLevel,
    defaultModel: "auto",
    strictModelMatch: true,
    forwardContext: true,
    mode: "agent",
    modelOverrides: {},
  };
}

// The handler is called with RequestPermissionRequestParams; we only need
// a shape that satisfies the type for testing the outcome branch.
const fakeParams = { toolUses: [] } as unknown as Parameters<
  ReturnType<typeof createPermissionHandler>
>[0];

test("autoLevel=high returns ProceedAutoRunHigh without consulting UI", async () => {
  const handler = createPermissionHandler(makeCfg("high"));
  const outcome = await handler(fakeParams);
  assert.equal(outcome, ToolConfirmationOutcome.ProceedAutoRunHigh);
});

test("autoLevel=medium returns ProceedAutoRunMedium", async () => {
  const handler = createPermissionHandler(makeCfg("medium"));
  const outcome = await handler(fakeParams);
  assert.equal(outcome, ToolConfirmationOutcome.ProceedAutoRunMedium);
});

test("autoLevel=low returns ProceedAutoRunLow", async () => {
  const handler = createPermissionHandler(makeCfg("low"));
  const outcome = await handler(fakeParams);
  assert.equal(outcome, ToolConfirmationOutcome.ProceedAutoRunLow);
});

test("PI_DROID_PROMPT_ALWAYS=1 forces UI prompt path; with no UI the handler returns Cancel", async () => {
  const previous = process.env.PI_DROID_PROMPT_ALWAYS;
  process.env.PI_DROID_PROMPT_ALWAYS = "1";
  try {
    const handler = createPermissionHandler(makeCfg("high"));
    const outcome = await handler(fakeParams);
    // No uiRef set in this test process, so promptViaUi returns Cancel.
    assert.equal(outcome, ToolConfirmationOutcome.Cancel);
  } finally {
    if (previous === undefined) delete process.env.PI_DROID_PROMPT_ALWAYS;
    else process.env.PI_DROID_PROMPT_ALWAYS = previous;
  }
});

test("isPromptAlwaysEnabled accepts 1/true/yes/on (case-insensitive) and rejects other values", () => {
  assert.equal(isPromptAlwaysEnabled({ PI_DROID_PROMPT_ALWAYS: "1" }), true);
  assert.equal(isPromptAlwaysEnabled({ PI_DROID_PROMPT_ALWAYS: "TRUE" }), true);
  assert.equal(isPromptAlwaysEnabled({ PI_DROID_PROMPT_ALWAYS: "yes" }), true);
  assert.equal(isPromptAlwaysEnabled({ PI_DROID_PROMPT_ALWAYS: "on" }), true);
  assert.equal(isPromptAlwaysEnabled({ PI_DROID_PROMPT_ALWAYS: "0" }), false);
  assert.equal(isPromptAlwaysEnabled({ PI_DROID_PROMPT_ALWAYS: "false" }), false);
  assert.equal(isPromptAlwaysEnabled({}), false);
  assert.equal(isPromptAlwaysEnabled({ PI_DROID_PROMPT_ALWAYS: "" }), false);
});
