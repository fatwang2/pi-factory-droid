import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionUIContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
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
} from "@earendil-works/pi-ai";
import {
  AutonomyLevel,
  createSession,
  DroidMessageType,
  ReasoningEffort,
  ToolConfirmationOutcome,
  type AskUserRequestParams,
  type AskUserResult,
  type Base64ImageSource,
  type DroidMessage,
  type DroidSession,
  type RequestPermissionRequestParams,
} from "@factory/droid-sdk";
import {
  PROVIDER_API,
  PROVIDER_BASE_URL,
  PROVIDER_ID,
  accountModels,
  fromStoredModels,
  toStoredModels,
} from "./catalog.js";
import {
  discoveryFailedIssue,
  emptyModelListIssue,
  missingApiKeyIssue,
  type CatalogFallbackIssue,
} from "./fallback-issue.js";
import type { ResolvedConfig, ResolvedModel, RuntimeState } from "./types.js";

const PROVIDER_DISPLAY_NAME = "Factory Droid";

let session: DroidSession | null = null;
let activeModelId: string | undefined;
let resolvedModelId: string | undefined;
let activeReasoning: ReasoningEffort | undefined;
let activeCwd = process.cwd();
let activeKeyHash: string | undefined;
let lastSpawnAt: number | undefined;
let lastError: string | undefined;
let uiRef: ExtensionUIContext | null = null;

export function setRuntimeContext(ui: ExtensionUIContext | null, cwd?: string): void {
  uiRef = ui;
  if (cwd) activeCwd = cwd;
}

export function getSessionSnapshot(): {
  sessionId: string | null;
  lastSpawnAt: number | undefined;
  lastError: string | undefined;
  requestedModel: string | undefined;
  resolvedModel: string | undefined;
  reasoning: ReasoningEffort | undefined;
} {
  return {
    sessionId: session?.sessionId ?? null,
    lastSpawnAt,
    lastError,
    requestedModel: activeModelId,
    resolvedModel: resolvedModelId,
    reasoning: activeReasoning,
  };
}

export function clearLastError(): void {
  lastError = undefined;
}

export async function closeSession(): Promise<void> {
  const current = session;
  session = null;
  activeModelId = undefined;
  resolvedModelId = undefined;
  activeReasoning = undefined;
  activeKeyHash = undefined;
  lastSpawnAt = undefined;
  if (current) {
    try {
      await current.close();
    } catch {
      // Shutdown must be best-effort.
    }
  }
}

export function registerProvider(
  pi: ExtensionAPI,
  cfg: ResolvedConfig,
  state: RuntimeState,
): { totalModels: number } {
  const config: ProviderConfig = {
    name: PROVIDER_DISPLAY_NAME,
    baseUrl: PROVIDER_BASE_URL,
    apiKey: "$FACTORY_API_KEY",
    api: PROVIDER_API,
    models: state.lastModels.map((model) => model.piModel),
    streamSimple: (model, context, options) => streamDroid(model, context, options, state.cfg),
    refreshModels: async (context) => {
      const cached = await context.store.read();
      if (cached?.models?.length) {
        const restored = fromStoredModels(cached.models, state.cfg.modelOverrides);
        if (restored.length) {
          state.lastModels = restored;
          state.catalogSource = "cache";
          state.catalogUpdatedAt = cached.checkedAt;
        }
      }

      if (!context.allowNetwork || context.signal?.aborted) {
        return state.lastModels.map((model) => model.piModel);
      }

      const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
      if (!apiKey) {
        state.catalogIssue = missingApiKeyIssue();
        return state.lastModels.map((model) => model.piModel);
      }

      try {
        const models = await discoverAccountModels(apiKey, state.cfg, context.signal);
        if (!models.length) {
          state.catalogIssue = emptyModelListIssue();
          return state.lastModels.map((model) => model.piModel);
        }
        state.lastModels = models;
        state.catalogSource = "account";
        state.catalogUpdatedAt = Date.now();
        state.catalogIssue = undefined;
        await context.store.write({ models: toStoredModels(models), checkedAt: state.catalogUpdatedAt });
        return models.map((model) => model.piModel);
      } catch (error) {
        state.catalogIssue = discoveryFailedIssue(error);
        return state.lastModels.map((model) => model.piModel);
      }
    },
  };
  pi.registerProvider(PROVIDER_ID, config);
  return { totalModels: state.lastModels.length };
}

async function discoverAccountModels(
  apiKey: string,
  cfg: ResolvedConfig,
  signal?: AbortSignal,
): Promise<ResolvedModel[]> {
  const discovery = await createSession({
    apiKey,
    cwd: activeCwd,
    execPath: cfg.droidBinary,
    modelId: cfg.defaultModel,
    autonomyLevel: AutonomyLevel.Low,
    permissionHandler: () => ToolConfirmationOutcome.Cancel,
    askUserHandler: async () => ({ cancelled: true, answers: [] }),
    env: environmentWithKey(apiKey),
    abortSignal: signal,
  });
  try {
    return accountModels(discovery.initResult.availableModels ?? [], cfg.modelOverrides);
  } finally {
    await discovery.close();
  }
}

export function wireSessionShutdown(pi: ExtensionAPI): void {
  pi.on("session_shutdown", async () => {
    await closeSession();
  });
}

function streamDroid(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  cfg: ResolvedConfig,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  void (async () => {
    const output: AssistantMessage = {
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
    const indexOf = new Map<string, number>();
    const openTextKeys = new Set<string>();
    const openThinkingKeys = new Set<string>();
    let aborted = false;
    const onAbort = () => { aborted = true; };
    options?.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      if (!options?.apiKey) throw new Error("No Factory API key. Run /login droid or set FACTORY_API_KEY.");
      const reasoning = resolveReasoning(model, options.reasoning);
      const droidSession = await getOrCreateSession(cfg, options.apiKey, model.id, reasoning);
      stream.push({ type: "start", partial: output });

      const turn = extractLatestTurn(context);
      for await (const event of droidSession.stream(turn.text, {
        abortSignal: options.signal,
        includePartialMessages: true,
        ...(turn.images.length ? { images: turn.images } : {}),
      })) {
        translate(event, output, stream, indexOf, openTextKeys, openThinkingKeys, model);
      }

      if (aborted || options.signal?.aborted) throw new Error("Request was aborted");
      closeOpenBlocks(output, stream, openTextKeys, openThinkingKeys, indexOf);
      stream.push({ type: "done", reason: output.stopReason === "length" ? "length" : "stop", message: output });
      stream.end();
    } catch (error) {
      const reason: "aborted" | "error" = aborted || options?.signal?.aborted ? "aborted" : "error";
      output.stopReason = reason;
      output.errorMessage = error instanceof Error ? error.message : String(error);
      if (reason === "error") {
        lastError = output.errorMessage;
        void closeSession();
      }
      stream.push({ type: "error", reason, error: output });
      stream.end();
    } finally {
      options?.signal?.removeEventListener("abort", onAbort);
    }
  })();

  return stream;
}

async function getOrCreateSession(
  cfg: ResolvedConfig,
  apiKey: string,
  modelId: string,
  reasoning: ReasoningEffort | undefined,
): Promise<DroidSession> {
  const keyHash = createHash("sha256").update(apiKey).digest("hex");
  if (session && activeKeyHash !== keyHash) await closeSession();

  if (session) {
    if (activeModelId !== modelId || activeReasoning !== reasoning) {
      try {
        await session.updateSettings({ modelId, ...(reasoning ? { reasoningEffort: reasoning } : {}) });
        activeModelId = modelId;
        resolvedModelId = modelId;
        activeReasoning = reasoning;
      } catch {
        await closeSession();
      }
    }
    if (session) return session;
  }

  const created = await createSession({
    apiKey,
    cwd: activeCwd,
    execPath: cfg.droidBinary,
    modelId,
    ...(reasoning ? { reasoningEffort: reasoning } : {}),
    autonomyLevel: autonomyFromAutoLevel(cfg.autoLevel),
    permissionHandler: createPermissionHandler(cfg),
    askUserHandler: handleAskUser,
    env: environmentWithKey(apiKey),
  });

  const actual = created.initResult.settings.modelId;
  if (cfg.strictModelMatch && modelId !== "auto" && actual !== modelId) {
    await created.close();
    throw new Error(`Droid model mismatch: requested ${modelId}, initialized ${actual}`);
  }

  session = created;
  activeModelId = modelId;
  resolvedModelId = actual;
  activeReasoning = created.initResult.settings.reasoningEffort;
  activeKeyHash = keyHash;
  lastSpawnAt = Date.now();
  lastError = undefined;
  return created;
}

function environmentWithKey(apiKey: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env.FACTORY_API_KEY = apiKey;
  return env;
}

function resolveReasoning(model: Model<Api>, level: ModelThinkingLevel | undefined): ReasoningEffort | undefined {
  if (!level) return undefined;
  if (!model.reasoning) return ReasoningEffort.None;
  const mapped = model.thinkingLevelMap?.[level];
  if (mapped === null) return undefined;
  const value = mapped ?? level;
  return Object.values(ReasoningEffort).includes(value as ReasoningEffort)
    ? value as ReasoningEffort
    : undefined;
}

function extractLatestTurn(context: Context): { text: string; images: Base64ImageSource[] } {
  for (let index = context.messages.length - 1; index >= 0; index--) {
    const message = context.messages[index];
    if (!message || message.role !== "user") continue;
    if (typeof message.content === "string") return { text: message.content, images: [] };
    const text = message.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    const images = message.content
      .filter((item): item is Extract<typeof item, { type: "image" }> =>
        item.type === "image" && isSupportedImageType(item.mimeType))
      .map((item) => ({ type: "base64" as const, data: item.data, mediaType: item.mimeType as Base64ImageSource["mediaType"] }));
    return { text: text || (images.length ? "Please inspect the attached image." : ""), images };
  }
  return { text: "", images: [] };
}

function isSupportedImageType(value: string): boolean {
  return value === "image/jpeg" || value === "image/png" || value === "image/gif" || value === "image/webp";
}

// Build a permission handler that respects the configured autonomy level.
//
// Droid already receives `autonomyLevel` via createSession(), so its internal
// logic decides which tool calls warrant a confirmation. When it does call
// the handler, we map autoLevel to the matching ProceedAutoRunXxx outcome
// instead of always popping a Pi confirm dialog. This makes `autoLevel:
// "high"` actually mean "no prompts" rather than "prompt every step".
//
// Set PI_DROID_PROMPT_ALWAYS=1 to force the legacy behavior (always ask via
// Pi UI), useful for users who want to audit every action even at high
// autonomy.
function createPermissionHandler(cfg: ResolvedConfig) {
  return async function handlePermission(
    params: RequestPermissionRequestParams,
  ): Promise<ToolConfirmationOutcome> {
    if (!isPromptAlwaysEnabled()) {
      switch (cfg.autoLevel) {
        case "high":
          return ToolConfirmationOutcome.ProceedAutoRunHigh;
        case "medium":
          return ToolConfirmationOutcome.ProceedAutoRunMedium;
        case "low":
          return ToolConfirmationOutcome.ProceedAutoRunLow;
        default:
          // fall through to UI prompt below
          break;
      }
    }
    return promptViaUi(params);
  };
}

function isPromptAlwaysEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.PI_DROID_PROMPT_ALWAYS?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

async function promptViaUi(params: RequestPermissionRequestParams): Promise<ToolConfirmationOutcome> {
  const ui = uiRef;
  if (!ui) return ToolConfirmationOutcome.Cancel;
  const summary = params.toolUses.map(({ toolUse, details }) => {
    const detail = "fullCommand" in details
      ? details.fullCommand
      : "filePath" in details
        ? details.filePath
        : toolUse.name;
    return `${toolUse.name}: ${detail}`;
  }).join("\n").slice(0, 2000);
  const approved = await ui.confirm("Droid requests permission", summary || "Allow this operation?");
  return approved ? ToolConfirmationOutcome.ProceedOnce : ToolConfirmationOutcome.Cancel;
}

async function handleAskUser(params: AskUserRequestParams): Promise<AskUserResult> {
  const ui = uiRef;
  if (!ui) return { cancelled: true, answers: [] };
  const answers: AskUserResult["answers"] = [];
  for (const question of params.questions) {
    const title = question.topic ? `${question.topic}: ${question.question}` : question.question;
    const answer = question.options?.length
      ? await ui.select(title, [...question.options])
      : await ui.input(title);
    if (answer === undefined) return { cancelled: true, answers: [] };
    answers.push({ index: question.index, question: question.question, answer });
  }
  return { answers };
}

function autonomyFromAutoLevel(level: ResolvedConfig["autoLevel"]): AutonomyLevel {
  if (level === "high") return AutonomyLevel.High;
  if (level === "medium") return AutonomyLevel.Medium;
  return AutonomyLevel.Low;
}

function translate(
  event: DroidMessage,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  indexOf: Map<string, number>,
  openTextKeys: Set<string>,
  openThinkingKeys: Set<string>,
  model: Model<Api>,
): void {
  switch (event.type) {
    case DroidMessageType.AssistantTextDelta: {
      const key = `text:${event.messageId}:${event.blockIndex}`;
      let index = indexOf.get(key);
      if (index === undefined) {
        index = output.content.length;
        output.content.push({ type: "text", text: "" });
        indexOf.set(key, index);
        openTextKeys.add(key);
        stream.push({ type: "text_start", contentIndex: index, partial: output });
      }
      const block = output.content[index];
      if (block?.type !== "text") return;
      block.text += event.text;
      stream.push({ type: "text_delta", contentIndex: index, delta: event.text, partial: output });
      return;
    }
    case DroidMessageType.ThinkingTextDelta: {
      const key = `think:${event.messageId}:${event.blockIndex}`;
      let index = indexOf.get(key);
      if (index === undefined) {
        index = output.content.length;
        output.content.push({ type: "thinking", thinking: "", thinkingSignature: "" });
        indexOf.set(key, index);
        openThinkingKeys.add(key);
        stream.push({ type: "thinking_start", contentIndex: index, partial: output });
      }
      const block = output.content[index];
      if (block?.type !== "thinking") return;
      block.thinking += event.text;
      stream.push({ type: "thinking_delta", contentIndex: index, delta: event.text, partial: output });
      return;
    }
    case DroidMessageType.TokenUsageUpdate:
      updateUsage(output, event, model);
      return;
    case DroidMessageType.Result:
      if (event.tokenUsage) updateUsage(output, event.tokenUsage, model);
      if (event.isError) throw new Error(event.errors?.join("; ") || event.error?.message || "Droid execution failed");
      return;
    case DroidMessageType.Error:
      throw new Error(`droid: ${event.errorType}: ${event.message}`);
    default:
      // Droid owns its internal tool loop. Pi receives only assistant text/thinking.
      return;
  }
}

function updateUsage(
  output: AssistantMessage,
  usage: { inputTokens?: number; outputTokens?: number; thinkingTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number },
  model: Model<Api>,
): void {
  output.usage.input = usage.inputTokens ?? 0;
  output.usage.output = (usage.outputTokens ?? 0) + (usage.thinkingTokens ?? 0);
  output.usage.cacheRead = usage.cacheReadTokens ?? 0;
  output.usage.cacheWrite = usage.cacheCreationTokens ?? 0;
  output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
  output.usage.cost = calculateCost(model, output.usage);
}

function closeOpenBlocks(
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  openTextKeys: Set<string>,
  openThinkingKeys: Set<string>,
  indexOf: Map<string, number>,
): void {
  for (const key of openTextKeys) {
    const index = indexOf.get(key);
    const block = index === undefined ? undefined : output.content[index];
    if (index !== undefined && block?.type === "text") {
      stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
    }
  }
  openTextKeys.clear();
  for (const key of openThinkingKeys) {
    const index = indexOf.get(key);
    const block = index === undefined ? undefined : output.content[index];
    if (index !== undefined && block?.type === "thinking") {
      stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
    }
  }
  openThinkingKeys.clear();
}

export const __testUtils = {
  createPermissionHandler,
  isPromptAlwaysEnabled,
};
