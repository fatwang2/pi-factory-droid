/**
 * mode=pi-tools stream path: Droid session + Pi tool execution via MCP bridge.
 */

import {
  calculateCost,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ModelThinkingLevel,
  type SimpleStreamOptions,
  type Tool,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  DroidMessageType,
  type Base64ImageSource,
  type DroidMessage,
  type DroidSession,
} from "@factory/droid-sdk";
import {
  fingerprintTools,
  type PiToolsBridgeBoard,
} from "./pi-tools-bridge.js";
import { extractAllToolResults } from "./tool-results.js";

export type PiToolsPhase = "idle" | "streaming" | "awaiting-results";

export interface PiToolsTurnState {
  phase: PiToolsPhase;
  piStream: AssistantMessageEventStream | null;
  output: AssistantMessage;
  model: Model<Api>;
  /** open text/thinking keys for partial blocks */
  indexOf: Map<string, number>;
  openTextKeys: Set<string>;
  openThinkingKeys: Set<string>;
  consumerAbort: AbortController;
  consumerDone: Promise<void>;
  error?: string;
}

export function createEmptyOutput(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
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

export function isAwaitingPiTools(turn: PiToolsTurnState | null | undefined): boolean {
  return turn?.phase === "awaiting-results";
}

export function attachPiStream(turn: PiToolsTurnState, stream: AssistantMessageEventStream): void {
  turn.piStream = stream;
  // Fresh assistant message envelope for this Pi stream call; keep usage on turn.output overall?
  // Pi expects each streamSimple response to be one assistant message. After tool results,
  // start a new content array while preserving model identity.
  turn.output = createEmptyOutput(turn.model);
  turn.indexOf = new Map();
  turn.openTextKeys = new Set();
  turn.openThinkingKeys = new Set();
  turn.phase = "streaming";
  stream.push({ type: "start", partial: turn.output });
}

export function deliverPiToolResults(board: PiToolsBridgeBoard, context: Context): void {
  const { results } = extractAllToolResults(
    context.messages as Array<{ role: string; content?: unknown; toolCallId?: string; isError?: boolean }>,
  );
  board.deliverResults(results);
}

export async function runPiToolsConsumer(options: {
  session: DroidSession;
  board: PiToolsBridgeBoard;
  turn: PiToolsTurnState;
  prompt: string;
  images: Base64ImageSource[];
  signal?: AbortSignal;
  onUsage?: (output: AssistantMessage) => void;
}): Promise<void> {
  const { session, board, turn, prompt, images, signal, onUsage } = options;
  const onAbort = () => {
    turn.consumerAbort.abort();
    void session.interrupt().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    turn.phase = "streaming";
    for await (const event of session.stream(prompt, {
      abortSignal: turn.consumerAbort.signal,
      includePartialMessages: true,
      ...(images.length ? { images } : {}),
    })) {
      if (turn.consumerAbort.signal.aborted || signal?.aborted) break;
      await handleDroidEvent(event, turn, board, onUsage);
    }

    if (turn.phase === "streaming" && turn.piStream) {
      closeOpenBlocks(turn);
      turn.output.stopReason = turn.output.stopReason === "length" ? "length" : "stop";
      onUsage?.(turn.output);
      turn.piStream.push({
        type: "done",
        reason: turn.output.stopReason === "length" ? "length" : "stop",
        message: turn.output,
      });
      turn.piStream.end();
      turn.piStream = null;
      turn.phase = "idle";
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    turn.error = message;
    if (turn.piStream) {
      turn.output.stopReason = signal?.aborted || turn.consumerAbort.signal.aborted ? "aborted" : "error";
      turn.output.errorMessage = message;
      turn.piStream.push({ type: "error", reason: turn.output.stopReason as "aborted" | "error", error: turn.output });
      turn.piStream.end();
      turn.piStream = null;
    }
    board.rejectAll(`pi-tools consumer stopped: ${message}`);
    turn.phase = "idle";
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

async function handleDroidEvent(
  event: DroidMessage,
  turn: PiToolsTurnState,
  board: PiToolsBridgeBoard,
  onUsage?: (output: AssistantMessage) => void,
): Promise<void> {
  const stream = turn.piStream;
  switch (event.type) {
    case DroidMessageType.AssistantTextDelta: {
      if (!stream) return;
      ensureText(turn, event.messageId, event.blockIndex, event.text);
      return;
    }
    case DroidMessageType.ThinkingTextDelta: {
      if (!stream) return;
      ensureThinking(turn, event.messageId, event.blockIndex, event.text);
      return;
    }
    case DroidMessageType.ToolCallDelta:
      // Partial JSON only — wait for the complete ToolCall event.
      return;
    case DroidMessageType.ToolCall: {
      const toolUse = (event as { toolUse?: { id?: string; name?: string; input?: Record<string, unknown> } }).toolUse;
      if (!toolUse?.name) return;
      const name = toolUse.name;
      const id = toolUse.id || `tool-${Date.now()}`;
      if (!board.isOurTool(name)) {
        // ToolSearch and any residual native tools stay inside Droid.
        return;
      }
      board.noteToolCall(id, name);
      if (!stream || turn.phase !== "streaming") return;

      const piName = board.resolvePiName(name) || name;
      const args = (toolUse.input && typeof toolUse.input === "object") ? toolUse.input : {};

      closeOpenBlocks(turn);
      const toolCall: ToolCall = {
        type: "toolCall",
        id,
        name: piName,
        arguments: args as Record<string, unknown>,
      };
      const contentIndex = turn.output.content.length;
      turn.output.content.push(toolCall);
      turn.output.stopReason = "toolUse";
      stream.push({ type: "toolcall_start", contentIndex, partial: turn.output });
      stream.push({
        type: "toolcall_end",
        contentIndex,
        toolCall,
        partial: turn.output,
      });
      onUsage?.(turn.output);
      stream.push({ type: "done", reason: "toolUse", message: turn.output });
      stream.end();
      turn.piStream = null;
      turn.phase = "awaiting-results";
      return;
    }
    case DroidMessageType.Result: {
      if (event.isError) {
        throw new Error(event.errors?.join("; ") || event.error?.message || "Droid execution failed");
      }
      return;
    }
    case DroidMessageType.Error:
      throw new Error(`droid: ${event.errorType}: ${event.message}`);
    default:
      return;
  }
}

function ensureText(
  turn: PiToolsTurnState,
  messageId: string,
  blockIndex: number,
  delta: string,
): void {
  const stream = turn.piStream;
  if (!stream) return;
  const key = `text:${messageId}:${blockIndex}`;
  let index = turn.indexOf.get(key);
  if (index === undefined) {
    index = turn.output.content.length;
    turn.output.content.push({ type: "text", text: "" });
    turn.indexOf.set(key, index);
    turn.openTextKeys.add(key);
    stream.push({ type: "text_start", contentIndex: index, partial: turn.output });
  }
  const block = turn.output.content[index];
  if (block?.type !== "text") return;
  block.text += delta;
  stream.push({ type: "text_delta", contentIndex: index, delta, partial: turn.output });
}

function ensureThinking(
  turn: PiToolsTurnState,
  messageId: string,
  blockIndex: number,
  delta: string,
): void {
  const stream = turn.piStream;
  if (!stream) return;
  const key = `think:${messageId}:${blockIndex}`;
  let index = turn.indexOf.get(key);
  if (index === undefined) {
    index = turn.output.content.length;
    turn.output.content.push({ type: "thinking", thinking: "", thinkingSignature: "" });
    turn.indexOf.set(key, index);
    turn.openThinkingKeys.add(key);
    stream.push({ type: "thinking_start", contentIndex: index, partial: turn.output });
  }
  const block = turn.output.content[index];
  if (block?.type !== "thinking") return;
  block.thinking += delta;
  stream.push({ type: "thinking_delta", contentIndex: index, delta, partial: turn.output });
}

function closeOpenBlocks(turn: PiToolsTurnState): void {
  const stream = turn.piStream;
  if (!stream) return;
  for (const key of [...turn.openTextKeys]) {
    const index = turn.indexOf.get(key);
    if (index === undefined) continue;
    const block = turn.output.content[index];
    if (block?.type === "text") {
      stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: turn.output });
    }
    turn.openTextKeys.delete(key);
  }
  for (const key of [...turn.openThinkingKeys]) {
    const index = turn.indexOf.get(key);
    if (index === undefined) continue;
    const block = turn.output.content[index];
    if (block?.type === "thinking") {
      stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: turn.output });
    }
    turn.openThinkingKeys.delete(key);
  }
}

export function toolsFingerprintOf(context: Context): string {
  return fingerprintTools(context.tools as Tool[] | undefined);
}

export type { ModelThinkingLevel };
