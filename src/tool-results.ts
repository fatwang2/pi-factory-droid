// Extract the trailing toolResult messages from a Pi context (same turn).
// Mirrors pi-claude-bridge's extractAllToolResults.

export type McpContent = Array<
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
>;

export interface BridgedToolResult {
  content: McpContent;
  isError?: boolean;
  toolCallId?: string;
}

export function toolResultToMcpContent(
  content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): McpContent {
  if (typeof content === "string") return [{ type: "text", text: content || "" }];
  if (!Array.isArray(content)) return [{ type: "text", text: "" }];
  const blocks: McpContent = [];
  for (const block of content) {
    if (block.type === "text" && block.text) blocks.push({ type: "text", text: block.text });
    else if (block.type === "image" && block.data && block.mimeType) {
      blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
    }
  }
  return blocks.length ? blocks : [{ type: "text", text: "" }];
}

export function extractAllToolResults(
  messages: Array<{
    role: string;
    content?: unknown;
    toolCallId?: string;
    isError?: boolean;
    [key: string]: unknown;
  }>,
): { results: BridgedToolResult[]; stopIdx: number } {
  const results: BridgedToolResult[] = [];
  let stopIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "toolResult") {
      results.unshift({
        content: toolResultToMcpContent(
          msg.content as string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
        ),
        isError: msg.isError,
        toolCallId: msg.toolCallId,
      });
    } else if (msg.role === "assistant") {
      stopIdx = i;
      break;
    }
  }
  return { results, stopIdx };
}
