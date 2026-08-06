/**
 * Pi-tools bridge helpers for droid mode=pi-tools.
 *
 * Droid still owns the agent session; Pi owns tool execution via SDK MCP
 * handlers that suspend until the next streamSimple delivers toolResult rows.
 */

import { createHash } from "node:crypto";
import type { Tool } from "@earendil-works/pi-ai";
import {
  createSdkMcpServer,
  tool as droidTool,
  type SdkMcpServer,
} from "@factory/droid-sdk";
import { jsonSchemaToZodShape } from "./schema-to-zod.js";
import type { BridgedToolResult } from "./tool-results.js";

export const PI_TOOLS_MCP_SERVER = "pi-tools";

/** llmId pattern observed in M0: `${server}___${toolName}` */
export function mcpLlmId(toolName: string, server = PI_TOOLS_MCP_SERVER): string {
  return `${server}___${toolName}`;
}

export function mcpToolCatalogId(toolName: string, server = PI_TOOLS_MCP_SERVER): string {
  return `mcp_${server}_${toolName}`;
}

export function fingerprintTools(tools: Tool[] | undefined): string {
  const list = (tools ?? []).map((t) => ({
    name: t.name,
    description: t.description ?? "",
    parameters: t.parameters ?? {},
  }));
  list.sort((a, b) => a.name.localeCompare(b.name));
  return createHash("sha256").update(JSON.stringify(list)).digest("hex");
}

export function sanitizeToolName(name: string): string {
  // Droid/MCP tool names: keep alnum, underscore, hyphen.
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned || "tool";
}

export interface PendingMcpCall {
  toolName: string;
  resolve: (result: BridgedToolResult) => void;
}

/**
 * Mutable per-session bridge board. MCP handlers close over this object so a
 * long-lived Droid session can wait for Pi tool results across streamSimple calls.
 */
export class PiToolsBridgeBoard {
  /** toolCallId → resolver waiting inside MCP handler */
  readonly pendingHandlers = new Map<string, PendingMcpCall>();
  /** toolCallId → result already delivered by Pi before handler started */
  readonly earlyResults = new Map<string, BridgedToolResult>();
  /** Handlers that started before the stream emitted tool_call id (keyed by sanitized tool name). */
  private readonly waitingByName = new Map<string, Array<(id: string) => void>>();
  /** tool_call ids seen before the matching MCP handler subscribed (keyed by sanitized name). */
  private readonly unusedIdsByName = new Map<string, string[]>();
  /** Map MCP llm name / sanitized name → original Pi tool name */
  readonly llmNameToPi = new Map<string, string>();
  readonly piNameToSanitized = new Map<string, string>();

  registerNameMaps(tools: Tool[]): void {
    this.llmNameToPi.clear();
    this.piNameToSanitized.clear();
    for (const t of tools) {
      const sanitized = sanitizeToolName(t.name);
      this.piNameToSanitized.set(t.name, sanitized);
      this.llmNameToPi.set(sanitized, t.name);
      this.llmNameToPi.set(sanitized.toLowerCase(), t.name);
      this.llmNameToPi.set(mcpLlmId(sanitized), t.name);
      this.llmNameToPi.set(mcpLlmId(sanitized).toLowerCase(), t.name);
      this.llmNameToPi.set(t.name, t.name);
      this.llmNameToPi.set(t.name.toLowerCase(), t.name);
    }
  }

  resolvePiName(droidToolName: string): string | undefined {
    return (
      this.llmNameToPi.get(droidToolName) ||
      this.llmNameToPi.get(droidToolName.toLowerCase()) ||
      // strip server prefix if present
      this.llmNameToPi.get(droidToolName.split("___").pop() || "") ||
      undefined
    );
  }

  isOurTool(droidToolName: string): boolean {
    return this.resolvePiName(droidToolName) !== undefined;
  }

  /** Stream path: associate a Droid tool_call id with its MCP tool name. */
  noteToolCall(id: string, droidToolName: string): void {
    const piName = this.resolvePiName(droidToolName);
    const sanitized = piName ? sanitizeToolName(piName) : sanitizeToolName(droidToolName.split("___").pop() || droidToolName);
    const waiters = this.waitingByName.get(sanitized);
    if (waiters && waiters.length) {
      const wake = waiters.shift()!;
      if (!waiters.length) this.waitingByName.delete(sanitized);
      wake(id);
      return;
    }
    const queue = this.unusedIdsByName.get(sanitized) ?? [];
    queue.push(id);
    this.unusedIdsByName.set(sanitized, queue);
  }

  waitForPiResult(toolName: string): Promise<BridgedToolResult> {
    const sanitized = sanitizeToolName(toolName);

    const takeId = (): string | undefined => {
      const q = this.unusedIdsByName.get(sanitized);
      if (!q?.length) return undefined;
      const id = q.shift()!;
      if (!q.length) this.unusedIdsByName.delete(sanitized);
      return id;
    };

    const attach = (id: string): Promise<BridgedToolResult> => {
      if (this.earlyResults.has(id)) {
        const result = this.earlyResults.get(id)!;
        this.earlyResults.delete(id);
        return Promise.resolve(result);
      }
      return new Promise<BridgedToolResult>((resolve) => {
        this.pendingHandlers.set(id, { toolName: sanitized, resolve });
      });
    };

    const existing = takeId();
    if (existing) return attach(existing);

    // Handler beat the stream event — wait for noteToolCall to supply the id.
    return new Promise<BridgedToolResult>((resolve) => {
      const list = this.waitingByName.get(sanitized) ?? [];
      list.push((id) => {
        void attach(id).then(resolve);
      });
      this.waitingByName.set(sanitized, list);
    });
  }

  deliverResults(results: BridgedToolResult[]): void {
    for (const result of results) {
      const id = result.toolCallId;
      if (!id) continue;
      const pending = this.pendingHandlers.get(id);
      if (pending) {
        this.pendingHandlers.delete(id);
        pending.resolve(result);
      } else {
        this.earlyResults.set(id, result);
      }
    }
  }

  /** Fail any still-waiting handlers (session teardown / abort). */
  rejectAll(message: string): void {
    for (const [id, pending] of this.pendingHandlers) {
      pending.resolve({
        content: [{ type: "text", text: message }],
        isError: true,
        toolCallId: id,
      });
    }
    this.pendingHandlers.clear();
    this.earlyResults.clear();
    for (const waiters of this.waitingByName.values()) {
      for (const wake of waiters) wake(`orphaned-${Date.now()}`);
    }
    this.waitingByName.clear();
    this.unusedIdsByName.clear();
  }
}

export function buildPiToolsMcpServer(tools: Tool[], board: PiToolsBridgeBoard): SdkMcpServer {
  board.registerNameMaps(tools);
  const mcpTools = tools.map((t) => {
    const name = sanitizeToolName(t.name);
    const shape = jsonSchemaToZodShape(t.parameters);
    const hasShape = Object.keys(shape).length > 0;
    if (hasShape) {
      return droidTool(name, t.description || t.name, shape, async () => {
        const result = await board.waitForPiResult(name);
        return bridgedToDroidResult(result);
      });
    }
    return droidTool(name, t.description || t.name, async () => {
      const result = await board.waitForPiResult(name);
      return bridgedToDroidResult(result);
    });
  });

  return createSdkMcpServer({
    name: PI_TOOLS_MCP_SERVER,
    version: "1.0.0",
    tools: mcpTools,
  });
}

function bridgedToDroidResult(result: BridgedToolResult): {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
} {
  return {
    content: result.content.length ? result.content : [{ type: "text", text: "" }],
    ...(result.isError ? { isError: true } : {}),
  };
}

/** Keep ToolSearch (cannot fully disable) + our MCP tools; drop the rest. */
export function selectDisableToolIds(
  catalog: Array<{ id: string; llmId?: string }>,
  tools: Tool[],
): string[] {
  const keep = new Set<string>();
  keep.add("tool-search-cli");
  for (const t of tools) {
    const sanitized = sanitizeToolName(t.name);
    keep.add(mcpToolCatalogId(sanitized));
    keep.add(mcpLlmId(sanitized));
  }
  return catalog
    .map((t) => t.id)
    .filter((id) => {
      if (!id) return false;
      if (keep.has(id)) return false;
      if (id.startsWith(`mcp_${PI_TOOLS_MCP_SERVER}_`)) return false;
      return true;
    });
}
