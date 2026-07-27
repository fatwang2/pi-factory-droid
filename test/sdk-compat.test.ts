import assert from "node:assert/strict";
import test from "node:test";
import {
  RequestPermissionRequestParamsSchema,
  RequestPermissionResultSchema,
  ToolConfirmationOutcome,
} from "@factory/droid-sdk";
import { applyPermissionOptionCompat } from "../src/sdk-compat.js";

// Shape of a real Droid >= 0.180 MCP permission request: the option list carries
// outcomes that @factory/droid-sdk 0.6.0 does not know about.
function mcpPermissionParams(extraOptionValue: string): unknown {
  return {
    toolUses: [
      {
        toolUse: { type: "tool_use", id: "t1", name: "linear___save_comment", input: {} },
        confirmationType: "mcp_tool",
        details: { type: "mcp_tool", toolName: "linear___save_comment", impactLevel: "write" },
      },
    ],
    options: [
      { label: "Yes", value: "proceed_once" },
      { label: "Always allow this tool", value: extraOptionValue },
    ],
  };
}

test("unpatched SDK rejects Droid's MCP permission options", () => {
  const parsed = RequestPermissionRequestParamsSchema.safeParse(
    mcpPermissionParams("proceed_always_tools"),
  );
  assert.equal(parsed.success, false);
});

test("compat shim lets MCP permission requests through", () => {
  assert.equal(applyPermissionOptionCompat(), "applied");

  for (const value of ["proceed_always_tools", "proceed_always_server", "proceed_always_file"]) {
    const parsed = RequestPermissionRequestParamsSchema.safeParse(mcpPermissionParams(value));
    assert.equal(parsed.success, true, `expected ${value} to parse`);
  }
});

test("compat shim tolerates outcomes no Droid release has shipped yet", () => {
  applyPermissionOptionCompat();
  const parsed = RequestPermissionRequestParamsSchema.safeParse(
    mcpPermissionParams("proceed_something_not_invented_yet"),
  );
  assert.equal(parsed.success, true);
});

test("compat shim keeps known outcomes and is idempotent", () => {
  assert.equal(applyPermissionOptionCompat(), "applied");
  assert.equal(applyPermissionOptionCompat(), "applied");
  const parsed = RequestPermissionRequestParamsSchema.safeParse(
    mcpPermissionParams(ToolConfirmationOutcome.ProceedOnce),
  );
  assert.equal(parsed.success, true);
});

test("compat shim does not widen the outcome we send back", () => {
  applyPermissionOptionCompat();
  assert.equal(
    RequestPermissionResultSchema.safeParse({
      selectedOption: ToolConfirmationOutcome.ProceedAutoRunLow,
    }).success,
    true,
  );
  assert.equal(
    RequestPermissionResultSchema.safeParse({ selectedOption: "proceed_always_tools" }).success,
    false,
  );
});
