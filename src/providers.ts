import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionUIContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt, loadSkills } from "@earendil-works/pi-coding-agent";
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

/** Cap on concurrently-open Droid subprocesses (LRU-evicted beyond this). */
const MAX_POOL_SESSIONS = 8;
/** Idle Droid sessions are closed after this long without a turn. */
const IDLE_TTL_MS = 15 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

interface TokenBuckets {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function emptyBuckets(): TokenBuckets {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/**
 * Per-conversation runtime context of ONE Pi session (extension instance).
 * Pi loads extensions per AgentSession, and hosts like PIXIU run MANY
 * AgentSessions concurrently in one process (several bots × several chats) —
 * module-level cwd/ui state would race across them, so each instance carries
 * its own.
 */
export interface InstanceRuntime {
  ui: ExtensionUIContext | null;
  cwd: string;
  /**
   * Stable identity of the Pi CONVERSATION (session id, survives resume).
   * Keys the Droid session pool: one Droid conversation per Pi conversation,
   * so a fresh Pi session (/new, idle cutoff) naturally starts a fresh Droid
   * session, and two chats sharing a cwd never share Droid history.
   */
  sessionKey: string;
}

export function createInstanceRuntime(): InstanceRuntime {
  return { ui: null, cwd: process.cwd(), sessionKey: process.cwd() };
}

/**
 * Per-CALL runtime resolution. Pi keeps ONE process-wide provider registry:
 * every AgentSession re-registers this provider on load, and streaming resolves
 * the provider from the registry at request time — so the streamFn that runs
 * may belong to a DIFFERENT session's extension instance than the caller
 * (last registration wins; with concurrent sessions it's effectively random).
 * The instance runtime captured in the closure is therefore untrustworthy.
 *
 * Pi does pass the caller's identity per call: stream options carry
 * `sessionId` (= sessionManager.getSessionId()). Each extension instance
 * binds its runtime here under that id on session_start, and streamDroid
 * resolves the CALLER's runtime from this map instead of trusting its closure.
 */
const sessionRuntimes = new Map<string, InstanceRuntime>();
const MAX_SESSION_RUNTIMES = 256;

export function bindSessionRuntime(sessionId: string, runtime: InstanceRuntime): void {
  // Re-binding the same id replaces the previous instance's runtime — refresh
  // insertion order so active conversations aren't evicted before idle ones.
  sessionRuntimes.delete(sessionId);
  sessionRuntimes.set(sessionId, runtime);
  while (sessionRuntimes.size > MAX_SESSION_RUNTIMES) {
    const oldest = sessionRuntimes.keys().next().value;
    if (oldest === undefined) break;
    sessionRuntimes.delete(oldest);
  }
}

function resolveCallRuntime(
  options: SimpleStreamOptions | undefined,
  fallback: InstanceRuntime,
): InstanceRuntime {
  const sessionId = (options as { sessionId?: unknown } | undefined)?.sessionId;
  if (typeof sessionId !== "string" || !sessionId) return fallback;
  const bound = sessionRuntimes.get(sessionId);
  if (bound) return bound;
  // The caller's session never bound (older host, bootstrap session): still
  // key the pool by the caller's true conversation id so histories don't merge.
  return { ...fallback, sessionKey: sessionId };
}

/**
 * One pooled Droid session bound to one Pi conversation. Everything that used
 * to be a module-level singleton (session handle, model settings, usage
 * tracking) lives here so concurrent conversations can't contaminate each
 * other — cross-cwd, cross-chat, or cross-bot.
 */
interface PoolEntry {
  key: string;
  session: DroidSession;
  cwd: string;
  keyHash: string;
  modelId: string;
  resolvedModelId: string;
  reasoning: ReasoningEffort | undefined;
  /** Hash of the forwarded context block; a change recreates the session so
   *  persona/memory/skill edits take effect mid-conversation. */
  contextHash: string;
  /** Context preamble to prepend to the FIRST turn after (re)creation. */
  pendingPreamble: string | null;
  spawnedAt: number;
  lastUsedAt: number;
  usage: UsageTracker;
}

const pool = new Map<string, PoolEntry>();
let lastError: string | undefined;
let sweeper: ReturnType<typeof setInterval> | undefined;

function ensureSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const cutoff = Date.now() - IDLE_TTL_MS;
    for (const entry of [...pool.values()]) {
      if (entry.lastUsedAt < cutoff) void destroyEntry(entry);
    }
  }, SWEEP_INTERVAL_MS);
  sweeper.unref?.();
  // Best-effort cleanup so a CLI quit doesn't leave droid subprocesses behind.
  process.once("exit", () => {
    for (const entry of pool.values()) {
      try {
        void entry.session.close();
      } catch {
        // exit-time cleanup is best-effort
      }
    }
  });
}

async function destroyEntry(entry: PoolEntry): Promise<void> {
  if (pool.get(entry.key) === entry) pool.delete(entry.key);
  entry.usage.detach();
  try {
    await entry.session.close();
  } catch {
    // Shutdown must be best-effort.
  }
}

export function getPoolSnapshot(): {
  lastError: string | undefined;
  entries: Array<{
    key: string;
    sessionId: string;
    requestedModel: string;
    resolvedModel: string;
    reasoning: ReasoningEffort | undefined;
    cwd: string;
    spawnedAt: number;
    lastUsedAt: number;
  }>;
} {
  return {
    lastError,
    entries: [...pool.values()].map((entry) => ({
      key: entry.key,
      sessionId: entry.session.sessionId ?? "?",
      requestedModel: entry.modelId,
      resolvedModel: entry.resolvedModelId,
      reasoning: entry.reasoning,
      cwd: entry.cwd,
      spawnedAt: entry.spawnedAt,
      lastUsedAt: entry.lastUsedAt,
    })),
  };
}

export function clearLastError(): void {
  lastError = undefined;
}

/** Close every pooled Droid session (droid-restart / droid-refresh / tests). */
export async function closeAllSessions(): Promise<void> {
  const entries = [...pool.values()];
  pool.clear();
  for (const entry of entries) {
    entry.usage.detach();
    try {
      await entry.session.close();
    } catch {
      // Shutdown must be best-effort.
    }
  }
}

export function registerProvider(
  pi: ExtensionAPI,
  cfg: ResolvedConfig,
  state: RuntimeState,
  runtime: InstanceRuntime,
): { totalModels: number } {
  const config: ProviderConfig = {
    name: PROVIDER_DISPLAY_NAME,
    baseUrl: PROVIDER_BASE_URL,
    apiKey: "$FACTORY_API_KEY",
    api: PROVIDER_API,
    models: state.lastModels.map((model) => model.piModel),
    streamSimple: (model, context, options) => streamDroid(model, context, options, state.cfg, runtime),
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
        const models = await discoverAccountModels(apiKey, state.cfg, runtime, context.signal);
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
  runtime: InstanceRuntime,
  signal?: AbortSignal,
): Promise<ResolvedModel[]> {
  const discovery = await createSession({
    apiKey,
    cwd: runtime.cwd,
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

// ---------------------------------------------------------------------------
// Context forwarding (persona / memory / skills)
// ---------------------------------------------------------------------------

/**
 * Build the host-context block forwarded into a Droid session: the working
 * directory's AGENTS.md (persona + long-term memory, regenerated per turn by
 * hosts like PIXIU) and the same skills catalog Pi would inject for this cwd.
 * Droid keeps its OWN harness prompt and tools; this rides as user-level
 * context so the bridged agent still knows who it is and what skills exist
 * (skills are just files — Droid reads SKILL.md with its own tools).
 */
function buildContextBlock(cwd: string, cfg: ResolvedConfig): string {
  if (!cfg.forwardContext) return "";
  const parts: string[] = [];
  const agents = readMaybe(join(cwd, "AGENTS.md"));
  if (agents?.trim()) parts.push(agents.trim());
  try {
    const { skills } = loadSkills({
      cwd,
      agentDir: join(homedir(), ".pi", "agent"),
      // Pi's `.agents/skills` tiers (cwd ancestors + ~/.agents) are discovered
      // by its package-manager layer, NOT by core loadSkills — walk them
      // ourselves, closest first so name collisions resolve member > tenant >
      // global, matching Pi's own precedence.
      skillPaths: agentsSkillDirs(cwd),
      includeDefaults: true,
    });
    const skillsBlock = formatSkillsForPrompt(skills);
    if (skillsBlock.trim()) parts.push(skillsBlock.trim());
  } catch {
    // Skills are additive context; a scan failure must not break the turn.
  }
  return parts.join("\n\n");
}

/** `.agents/skills` dirs from cwd up to the git root (or fs root), closest
 *  first, then the user-level `~/.agents/skills`. Only existing dirs. */
function agentsSkillDirs(cwd: string): string[] {
  const dirs: string[] = [];
  let dir = cwd;
  for (let depth = 0; depth < 32; depth++) {
    dirs.push(join(dir, ".agents", "skills"));
    if (existsSync(join(dir, ".git"))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  dirs.push(join(homedir(), ".agents", "skills"));
  return dirs.filter((candidate) => existsSync(candidate));
}

function renderPreamble(contextBlock: string): string {
  return [
    "[环境桥接说明] 你通过 Pi 桥接在宿主环境中长期运行。以下是宿主提供的角色设定、长期记忆与可用技能清单——它们定义你是谁、如何行事,优先于一般默认行为。技能(skills)是磁盘上的说明文件:需要某项技能时,用你的文件工具读取对应 SKILL.md 并遵照执行。",
    "",
    "<host-context>",
    contextBlock,
    "</host-context>",
    "",
    "[以下是当前对话消息]",
  ].join("\n");
}

function readMaybe(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

function streamDroid(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  cfg: ResolvedConfig,
  instanceRuntime: InstanceRuntime,
): AssistantMessageEventStream {
  // The closure runtime may belong to another session's extension instance
  // (shared provider registry, last registration wins) — resolve the actual
  // caller from the per-call session id.
  const runtime = resolveCallRuntime(options, instanceRuntime);
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
    let entryRef: PoolEntry | undefined;
    const onAbort = () => { aborted = true; };
    options?.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      if (!options?.apiKey) throw new Error("No Factory API key. Run /login droid or set FACTORY_API_KEY.");
      const reasoning = resolveReasoning(model, options.reasoning);
      const contextBlock = buildContextBlock(runtime.cwd, cfg);
      const entry = await getOrCreateEntry(cfg, options.apiKey, model.id, reasoning, runtime, contextBlock);
      entryRef = entry;
      entry.usage.beginTurn(entry.session);
      stream.push({ type: "start", partial: output });

      const turn = extractLatestTurn(context);
      let turnText = turn.text;
      if (entry.pendingPreamble) {
        turnText = `${entry.pendingPreamble}\n\n${turnText}`;
        entry.pendingPreamble = null;
      }
      for await (const event of entry.session.stream(turnText, {
        abortSignal: options.signal,
        includePartialMessages: true,
        ...(turn.images.length ? { images: turn.images } : {}),
      })) {
        translate(event, output, stream, indexOf, openTextKeys, openThinkingKeys, model, entry.usage);
      }

      if (aborted || options.signal?.aborted) throw new Error("Request was aborted");
      await entry.usage.finalize(entry.session, output, model);
      entry.lastUsedAt = Date.now();
      closeOpenBlocks(output, stream, openTextKeys, openThinkingKeys, indexOf);
      stream.push({ type: "done", reason: output.stopReason === "length" ? "length" : "stop", message: output });
      stream.end();
    } catch (error) {
      const reason: "aborted" | "error" = aborted || options?.signal?.aborted ? "aborted" : "error";
      output.stopReason = reason;
      output.errorMessage = error instanceof Error ? error.message : String(error);
      if (reason === "error") {
        lastError = output.errorMessage;
        if (entryRef) void destroyEntry(entryRef);
      }
      stream.push({ type: "error", reason, error: output });
      stream.end();
    } finally {
      options?.signal?.removeEventListener("abort", onAbort);
    }
  })();

  return stream;
}

async function getOrCreateEntry(
  cfg: ResolvedConfig,
  apiKey: string,
  modelId: string,
  reasoning: ReasoningEffort | undefined,
  runtime: InstanceRuntime,
  contextBlock: string,
): Promise<PoolEntry> {
  ensureSweeper();
  const keyHash = createHash("sha256").update(apiKey).digest("hex");
  const key = `${keyHash}:${runtime.sessionKey}`;
  const contextHash = contextBlock ? createHash("sha256").update(contextBlock).digest("hex") : "";

  let entry = pool.get(key);
  // Persona/memory/skills changed mid-conversation → restart the Droid session
  // so the new context takes effect (Droid reads context only at turn input).
  if (entry && entry.contextHash !== contextHash) {
    await destroyEntry(entry);
    entry = undefined;
  }
  if (entry) {
    if (entry.modelId !== modelId || entry.reasoning !== reasoning) {
      try {
        await entry.session.updateSettings({ modelId, ...(reasoning ? { reasoningEffort: reasoning } : {}) });
        entry.modelId = modelId;
        entry.resolvedModelId = modelId;
        entry.reasoning = reasoning;
      } catch {
        await destroyEntry(entry);
        entry = undefined;
      }
    }
  }
  if (entry) {
    entry.lastUsedAt = Date.now();
    return entry;
  }

  // Room for the new subprocess: evict the least-recently-used entry.
  while (pool.size >= MAX_POOL_SESSIONS) {
    const lru = [...pool.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
    if (!lru) break;
    await destroyEntry(lru);
  }

  const created = await createSession({
    apiKey,
    cwd: runtime.cwd,
    execPath: cfg.droidBinary,
    modelId,
    ...(reasoning ? { reasoningEffort: reasoning } : {}),
    autonomyLevel: autonomyFromAutoLevel(cfg.autoLevel),
    permissionHandler: createPermissionHandler(cfg, runtime),
    askUserHandler: (params) => handleAskUser(params, runtime),
    env: environmentWithKey(apiKey),
  });

  const actual = created.initResult.settings.modelId;
  if (cfg.strictModelMatch && modelId !== "auto" && actual !== modelId) {
    await created.close();
    throw new Error(`Droid model mismatch: requested ${modelId}, initialized ${actual}`);
  }

  const now = Date.now();
  const fresh: PoolEntry = {
    key,
    session: created,
    cwd: runtime.cwd,
    keyHash,
    modelId,
    resolvedModelId: actual,
    reasoning: created.initResult.settings.reasoningEffort,
    contextHash,
    pendingPreamble: contextBlock ? renderPreamble(contextBlock) : null,
    spawnedAt: now,
    lastUsedAt: now,
    usage: new UsageTracker(),
  };
  pool.set(key, fresh);
  lastError = undefined;
  return fresh;
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
function createPermissionHandler(cfg: ResolvedConfig, runtime?: InstanceRuntime) {
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
    return promptViaUi(params, runtime);
  };
}

function isPromptAlwaysEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.PI_DROID_PROMPT_ALWAYS?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

async function promptViaUi(
  params: RequestPermissionRequestParams,
  runtime?: InstanceRuntime,
): Promise<ToolConfirmationOutcome> {
  const ui = runtime?.ui ?? null;
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

async function handleAskUser(params: AskUserRequestParams, runtime?: InstanceRuntime): Promise<AskUserResult> {
  const ui = runtime?.ui ?? null;
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
  usage: UsageTracker,
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
      // Streamed values are session-cumulative. Convert to per-turn deltas so
      // Pi footer/context math stays sane mid-turn.
      usage.applyTurnUsage(output, usage.cumulativeToTurnBuckets(event), model, { preferLastCall: false });
      return;
    case DroidMessageType.Result:
      if (event.tokenUsage) {
        usage.applyTurnUsage(output, usage.cumulativeToTurnBuckets(event.tokenUsage), model, { preferLastCall: false });
      }
      if (event.isError) throw new Error(event.errors?.join("; ") || event.error?.message || "Droid execution failed");
      return;
    case DroidMessageType.Error:
      throw new Error(`droid: ${event.errorType}: ${event.message}`);
    default:
      // Droid owns its internal tool loop. Pi receives only assistant text/thinking.
      return;
  }
}

// ---------------------------------------------------------------------------
// Usage tracking (per pool entry)
// ---------------------------------------------------------------------------

/**
 * Droid reports session-cumulative token counters. Pi treats each assistant
 * message usage as a single request and uses it for context % / auto-compact.
 * Track baselines + last-call/context stats PER DROID SESSION so we can report
 * per-turn numbers — concurrent conversations each keep their own meter.
 */
class UsageTracker {
  private baseline: TokenBuckets = emptyBuckets();
  private latestCumulative: TokenBuckets | null = null;
  private lastCallUsage: TokenBuckets | null = null;
  private contextStatsUsed: number | undefined;
  private unsubscribe: (() => void) | undefined;

  reset(): void {
    this.detach();
    this.baseline = emptyBuckets();
    this.latestCumulative = null;
    this.lastCallUsage = null;
    this.contextStatsUsed = undefined;
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private attach(droidSession: DroidSession): void {
    this.detach();
    this.unsubscribe = droidSession.onNotification((notification) => {
      if (notification?.type !== "session_token_usage_changed") return;
      const lastCall = readTokenBuckets(notification.lastCallTokenUsage);
      if (lastCall) this.lastCallUsage = lastCall;
      const cumulative = readTokenBuckets(notification.tokenUsage)
        ?? readTokenBuckets(notification.inclusiveTokenUsage);
      if (cumulative) this.latestCumulative = cumulative;
    }, { type: "session_token_usage_changed" });
  }

  beginTurn(droidSession: DroidSession): void {
    this.lastCallUsage = null;
    this.latestCumulative = null;
    this.contextStatsUsed = undefined;
    this.attach(droidSession);
  }

  async finalize(
    droidSession: DroidSession,
    output: AssistantMessage,
    model: Model<Api>,
  ): Promise<void> {
    // Prefer Droid's compaction-meter last-call numbers when raw notifications expose them.
    if (this.lastCallUsage) {
      this.applyTurnUsage(output, this.lastCallUsage, model, { preferLastCall: true });
    }

    try {
      const stats = await droidSession.getContextStats();
      this.applyContextStats(output, model, stats);
    } catch {
      // getContextStats is best-effort; delta usage and catalog fallback remain available.
    }

    // Advance baseline from the latest session-cumulative counters when available.
    if (this.latestCumulative) {
      this.baseline = { ...this.latestCumulative };
    } else {
      this.baseline = {
        input: this.baseline.input + Math.max(0, output.usage.input),
        output: this.baseline.output + Math.max(0, output.usage.output),
        cacheRead: this.baseline.cacheRead + Math.max(0, output.usage.cacheRead),
        cacheWrite: this.baseline.cacheWrite + Math.max(0, output.usage.cacheWrite),
      };
    }
  }

  applyContextStats(
    output: AssistantMessage,
    model: Model<Api>,
    stats: { used?: unknown; limit?: unknown; [key: string]: unknown },
  ): void {
    const limit = positiveNumberOrUndefined(stats.limit);
    if (limit !== undefined) {
      // Droid's context meter reports the active model's effective max input,
      // including reasoning-effort and regional routing adjustments. Pi compares
      // usage.totalTokens against model.contextWindow for auto-compaction, so the
      // two values must describe the same budget. Mutating the active model here
      // prevents Pi's conservative catalog fallback (for example 128k for GLM)
      // from compacting before Droid's own context manager needs to.
      model.contextWindow = Math.round(limit);
    }

    const used = nonNegativeNumberOrUndefined(stats.used);
    if (used !== undefined) {
      this.contextStatsUsed = used;
      // Pi context % uses usage.totalTokens. Keep input/output/cache as per-turn
      // deltas for the footer counters while reporting real window occupancy.
      output.usage.totalTokens = Math.round(used);
      output.usage.cost = calculateCost(model, output.usage);
    }
  }

  cumulativeToTurnBuckets(
    usage: {
      inputTokens?: number;
      outputTokens?: number;
      thinkingTokens?: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
    },
  ): TokenBuckets {
    const cumulative: TokenBuckets = {
      input: usage.inputTokens ?? 0,
      output: (usage.outputTokens ?? 0) + (usage.thinkingTokens ?? 0),
      cacheRead: usage.cacheReadTokens ?? 0,
      cacheWrite: usage.cacheCreationTokens ?? 0,
    };
    this.latestCumulative = cumulative;
    return {
      input: Math.max(0, cumulative.input - this.baseline.input),
      output: Math.max(0, cumulative.output - this.baseline.output),
      cacheRead: Math.max(0, cumulative.cacheRead - this.baseline.cacheRead),
      cacheWrite: Math.max(0, cumulative.cacheWrite - this.baseline.cacheWrite),
    };
  }

  applyTurnUsage(
    output: AssistantMessage,
    turn: TokenBuckets,
    model: Model<Api>,
    opts: { preferLastCall: boolean },
  ): void {
    // lastCall is authoritative for prompt/cache size when present; keep the
    // larger output delta if stream cumulative saw more generation tokens.
    if (opts.preferLastCall) {
      output.usage.input = turn.input;
      output.usage.cacheRead = turn.cacheRead;
      output.usage.cacheWrite = turn.cacheWrite;
      output.usage.output = Math.max(output.usage.output, turn.output);
    } else {
      output.usage.input = turn.input;
      output.usage.output = turn.output;
      output.usage.cacheRead = turn.cacheRead;
      output.usage.cacheWrite = turn.cacheWrite;
    }

    // Context occupancy for Pi: prefer exact meter, else prompt-side tokens only.
    // Do not sum multi-million cumulative cache reads into totalTokens — that was
    // blowing past contextWindow and forcing auto-compact every turn.
    if (this.contextStatsUsed !== undefined) {
      output.usage.totalTokens = Math.round(this.contextStatsUsed);
    } else {
      const promptTokens = output.usage.input + output.usage.cacheRead + output.usage.cacheWrite;
      const contextCap = model.contextWindow > 0 ? model.contextWindow : Number.POSITIVE_INFINITY;
      output.usage.totalTokens = Math.round(Math.min(promptTokens, contextCap));
    }
    output.usage.cost = calculateCost(model, output.usage);
  }

  // Test hooks (see __testUtils).
  setBaseline(baseline: TokenBuckets): void {
    this.baseline = { ...baseline };
  }
  getBaseline(): TokenBuckets {
    return { ...this.baseline };
  }
  setLastCall(usage: TokenBuckets | null): void {
    this.lastCallUsage = usage ? { ...usage } : null;
  }
  setContextStatsUsed(used: number | undefined): void {
    this.contextStatsUsed = used;
  }
  advanceBaselineFromCumulative(cumulative: TokenBuckets): void {
    this.latestCumulative = { ...cumulative };
    this.baseline = { ...cumulative };
  }
}

function readTokenBuckets(value: unknown): TokenBuckets | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const input = numberOrUndefined(record.inputTokens);
  const cacheRead = numberOrUndefined(record.cacheReadTokens);
  if (input === undefined && cacheRead === undefined
    && numberOrUndefined(record.outputTokens) === undefined
    && numberOrUndefined(record.thinkingTokens) === undefined
    && numberOrUndefined(record.cacheCreationTokens) === undefined) {
    return null;
  }
  const outputTokens = numberOrUndefined(record.outputTokens) ?? 0;
  const thinkingTokens = numberOrUndefined(record.thinkingTokens) ?? 0;
  return {
    input: input ?? 0,
    output: outputTokens + thinkingTokens,
    cacheRead: cacheRead ?? 0,
    cacheWrite: numberOrUndefined(record.cacheCreationTokens) ?? 0,
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeNumberOrUndefined(value: unknown): number | undefined {
  const number = numberOrUndefined(value);
  return number !== undefined && number >= 0 ? number : undefined;
}

function positiveNumberOrUndefined(value: unknown): number | undefined {
  const number = numberOrUndefined(value);
  return number !== undefined && number > 0 ? number : undefined;
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

// ---------------------------------------------------------------------------
// Test utilities — a dedicated tracker instance keeps the historical
// function-shaped API stable for the test suite.
// ---------------------------------------------------------------------------

let testTracker = new UsageTracker();

export const __testUtils = {
  createPermissionHandler,
  isPromptAlwaysEnabled,
  buildContextBlock,
  renderPreamble,
  resolveCallRuntime,
  cumulativeToTurnBuckets: (
    usage: Parameters<UsageTracker["cumulativeToTurnBuckets"]>[0],
  ): TokenBuckets => testTracker.cumulativeToTurnBuckets(usage),
  applyTurnUsage: (
    output: AssistantMessage,
    turn: TokenBuckets,
    model: Model<Api>,
    opts: { preferLastCall: boolean },
  ): void => testTracker.applyTurnUsage(output, turn, model, opts),
  applyContextStats: (
    output: AssistantMessage,
    model: Model<Api>,
    stats: { used?: unknown; limit?: unknown; [key: string]: unknown },
  ): void => testTracker.applyContextStats(output, model, stats),
  readTokenBuckets,
  resetUsageTracking(): void {
    testTracker = new UsageTracker();
  },
  setUsageBaselineForTest(baseline: TokenBuckets): void {
    testTracker.setBaseline(baseline);
  },
  getUsageBaselineForTest(): TokenBuckets {
    return testTracker.getBaseline();
  },
  setLastCallUsageForTest(usage: TokenBuckets | null): void {
    testTracker.setLastCall(usage);
  },
  setContextStatsUsedForTest(used: number | undefined): void {
    testTracker.setContextStatsUsed(used);
  },
  advanceBaselineFromCumulativeForTest(cumulative: TokenBuckets): void {
    testTracker.advanceBaselineFromCumulative(cumulative);
  },
};
