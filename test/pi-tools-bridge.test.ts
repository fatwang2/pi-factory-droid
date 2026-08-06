import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PiToolsBridgeBoard,
  fingerprintTools,
  mcpLlmId,
  sanitizeToolName,
  selectDisableToolIds,
} from "../src/pi-tools-bridge.js";
import { jsonSchemaToZodShape } from "../src/schema-to-zod.js";
import { extractAllToolResults } from "../src/tool-results.js";

describe("jsonSchemaToZodShape", () => {
  it("maps required/optional object properties", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: {
        cmd: { type: "string", description: "command" },
        timeout: { type: "number" },
      },
      required: ["cmd"],
    });
    assert.equal(Object.keys(shape).sort().join(","), "cmd,timeout");
    assert.equal(shape.cmd.safeParse("echo").success, true);
    assert.equal(shape.timeout.safeParse(undefined).success, true);
  });
});

describe("PiToolsBridgeBoard id matching", () => {
  it("matches handler that starts before stream noteToolCall", async () => {
    const board = new PiToolsBridgeBoard();
    board.registerNameMaps([{ name: "bash", description: "run", parameters: { type: "object", properties: {} } } as any]);

    const pending = board.waitForPiResult("bash");
    board.noteToolCall("call_1", "pi-tools___bash");
    board.deliverResults([
      { toolCallId: "call_1", content: [{ type: "text", text: "ok" }] },
    ]);
    const result = await pending;
    assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", "ok");
  });

  it("matches stream noteToolCall before handler", async () => {
    const board = new PiToolsBridgeBoard();
    board.registerNameMaps([{ name: "bash", description: "run", parameters: { type: "object", properties: {} } } as any]);
    board.noteToolCall("call_2", "bash");
    const pending = board.waitForPiResult("bash");
    board.deliverResults([
      { toolCallId: "call_2", content: [{ type: "text", text: "done" }] },
    ]);
    const result = await pending;
    assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", "done");
  });
});

describe("selectDisableToolIds", () => {
  it("keeps tool-search and pi-tools MCP ids", () => {
    const disabled = selectDisableToolIds(
      [
        { id: "execute-cli", llmId: "Execute" },
        { id: "tool-search-cli", llmId: "ToolSearch" },
        { id: "mcp_pi-tools_bash", llmId: "pi-tools___bash" },
        { id: "mcp_linear_get_issue", llmId: "linear___get_issue" },
      ],
      [{ name: "bash", description: "", parameters: {} } as any],
    );
    assert.ok(disabled.includes("execute-cli"));
    assert.ok(disabled.includes("mcp_linear_get_issue"));
    assert.ok(!disabled.includes("tool-search-cli"));
    assert.ok(!disabled.includes("mcp_pi-tools_bash"));
  });
});

describe("extractAllToolResults", () => {
  it("collects trailing toolResult rows", () => {
    const { results } = extractAllToolResults([
      { role: "user", content: "hi" },
      { role: "assistant", content: [] },
      { role: "toolResult", toolCallId: "a", content: "one" },
      { role: "toolResult", toolCallId: "b", content: "two", isError: true },
    ]);
    assert.equal(results.length, 2);
    assert.equal(results[0].toolCallId, "a");
    assert.equal(results[1].isError, true);
  });
});

describe("helpers", () => {
  it("fingerprints tools stably", () => {
    const a = fingerprintTools([
      { name: "b", description: "", parameters: {} },
      { name: "a", description: "", parameters: {} },
    ] as any);
    const b = fingerprintTools([
      { name: "a", description: "", parameters: {} },
      { name: "b", description: "", parameters: {} },
    ] as any);
    assert.equal(a, b);
  });

  it("builds mcp llm ids", () => {
    assert.equal(mcpLlmId("bash"), "pi-tools___bash");
    assert.equal(sanitizeToolName("read file"), "read_file");
  });
});
