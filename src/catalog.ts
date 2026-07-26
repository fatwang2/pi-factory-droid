import type { Api, Model, ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { ReasoningEffort, type AvailableModelConfig } from "@factory/droid-sdk";
import { SNAPSHOT_MODELS } from "./catalog.generated.js";
import type { CatalogSource, ModelOverride, ResolvedModel } from "./types.js";

export const PROVIDER_ID = "droid";
export const PROVIDER_API = "droid-exec" as Api;
export const PROVIDER_BASE_URL = "droid-exec://local";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

interface FallbackRow {
  id: string;
  name: string;
  provider: string;
  efforts?: ReasoningEffort[];
  image?: boolean;
}

// Current Factory/Droid catalog fallback. Authenticated SDK discovery replaces this list.
const FALLBACK_ROWS: FallbackRow[] = [
  { id: "auto", name: "Auto Model", provider: "factory", efforts: [ReasoningEffort.Dynamic], image: true },
  { id: "claude-fable-5", name: "Claude Fable 5", provider: "anthropic", efforts: allEfforts(), image: true },
  { id: "claude-opus-5", name: "Claude Opus 5", provider: "anthropic", efforts: allEfforts(), image: true },
  { id: "claude-opus-5-fast", name: "Claude Opus 5 Fast", provider: "anthropic", efforts: allEfforts(), image: true },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", provider: "anthropic", efforts: allEfforts(), image: true },
  { id: "claude-opus-4-8-fast", name: "Claude Opus 4.8 Fast", provider: "anthropic", efforts: allEfforts(), image: true },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7", provider: "anthropic", efforts: allEfforts(), image: true },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic", efforts: standardEfforts(true), image: true },
  { id: "claude-opus-4-5-20251101", name: "Claude Opus 4.5", provider: "anthropic", efforts: standardEfforts(), image: true },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", provider: "anthropic", efforts: allEfforts(), image: true },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic", efforts: standardEfforts(true), image: true },
  { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5", provider: "anthropic", efforts: standardEfforts(), image: true },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "anthropic", efforts: standardEfforts(), image: true },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai", efforts: openAIEfforts(), image: true },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "openai", efforts: openAIEfforts(), image: true },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai", efforts: openAIEfforts(), image: true },
  { id: "gpt-5.5", name: "GPT-5.5", provider: "openai", efforts: openAIEfforts(), image: true },
  { id: "gpt-5.5-fast", name: "GPT-5.5 Fast", provider: "openai", efforts: openAIEfforts(), image: true },
  { id: "gpt-5.5-pro", name: "GPT-5.5 Pro", provider: "openai", efforts: openAIEfforts(), image: true },
  { id: "gpt-5.4", name: "GPT-5.4", provider: "openai", efforts: openAIEfforts(), image: true },
  { id: "gpt-5.4-fast", name: "GPT-5.4 Fast", provider: "openai", efforts: openAIEfforts(), image: true },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", provider: "openai", efforts: openAIEfforts(), image: true },
  { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", provider: "openai", efforts: openAIEfforts(), image: true },
  { id: "gpt-5.3-codex-fast", name: "GPT-5.3 Codex Fast", provider: "openai", efforts: openAIEfforts(), image: true },
  { id: "gpt-5.2", name: "GPT-5.2", provider: "openai", efforts: openAIEfforts(), image: true },
  { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro", provider: "google", efforts: [ReasoningEffort.Low, ReasoningEffort.Medium, ReasoningEffort.High], image: true },
  { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash", provider: "google", efforts: [ReasoningEffort.Minimal, ReasoningEffort.Low, ReasoningEffort.Medium, ReasoningEffort.High], image: true },
  { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash", provider: "google", efforts: [ReasoningEffort.Minimal, ReasoningEffort.Low, ReasoningEffort.Medium, ReasoningEffort.High], image: true },
  { id: "gemini-3-flash-preview", name: "Gemini 3 Flash", provider: "google", efforts: [ReasoningEffort.Minimal, ReasoningEffort.Low, ReasoningEffort.Medium, ReasoningEffort.High], image: true },
  { id: "grok-4.5", name: "Grok 4.5", provider: "xai", efforts: [ReasoningEffort.Low, ReasoningEffort.Medium, ReasoningEffort.High] },
  { id: "glm-5.2", name: "GLM-5.2", provider: "factory", efforts: [ReasoningEffort.Off, ReasoningEffort.High, ReasoningEffort.Max] },
  { id: "glm-5.2-fast", name: "GLM-5.2 Fast", provider: "factory", efforts: [ReasoningEffort.Off, ReasoningEffort.High, ReasoningEffort.Max] },
  { id: "glm-5.1", name: "GLM-5.1", provider: "factory", efforts: [ReasoningEffort.Off, ReasoningEffort.High] },
  { id: "nemotron-3-ultra", name: "Nemotron 3 Ultra", provider: "factory", efforts: [ReasoningEffort.Off, ReasoningEffort.High] },
  { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", provider: "factory", efforts: [ReasoningEffort.Off, ReasoningEffort.High] },
  { id: "kimi-k2.6", name: "Kimi K2.6", provider: "factory", efforts: [ReasoningEffort.Off, ReasoningEffort.High] },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", provider: "factory", efforts: [ReasoningEffort.Off, ReasoningEffort.Low, ReasoningEffort.High, ReasoningEffort.Max] },
  { id: "minimax-m3", name: "MiniMax M3", provider: "factory", efforts: [ReasoningEffort.High] },
  { id: "minimax-m2.7", name: "MiniMax M2.7", provider: "factory", efforts: [ReasoningEffort.High] },
  { id: "minimax-m2.5", name: "MiniMax M2.5", provider: "factory", efforts: [ReasoningEffort.Low, ReasoningEffort.Medium, ReasoningEffort.High] },
];

function standardEfforts(includeMax = false): ReasoningEffort[] {
  return [ReasoningEffort.Off, ReasoningEffort.Low, ReasoningEffort.Medium, ReasoningEffort.High, ...(includeMax ? [ReasoningEffort.Max] : [])];
}
function allEfforts(): ReasoningEffort[] {
  return [...standardEfforts(true), ReasoningEffort.ExtraHigh];
}
function openAIEfforts(): ReasoningEffort[] {
  return [ReasoningEffort.None, ReasoningEffort.Low, ReasoningEffort.Medium, ReasoningEffort.High, ReasoningEffort.ExtraHigh, ReasoningEffort.Max];
}

export function fallbackModels(overrides: Record<string, ModelOverride>): ResolvedModel[] {
  if (SNAPSHOT_MODELS.length > 0) {
    // Snapshot reflects what the authenticated Factory account exposes; prefer
    // it over the hand-maintained FALLBACK_ROWS when present.
    return accountModels(SNAPSHOT_MODELS, overrides, "fallback");
  }
  return FALLBACK_ROWS.map((row) => resolveRow(row, overrides[row.id], "fallback"));
}

export function accountModels(
  available: readonly AvailableModelConfig[],
  overrides: Record<string, ModelOverride>,
  source: CatalogSource = "account",
): ResolvedModel[] {
  return available.map((model) => resolveRow({
    id: model.id,
    name: model.displayName || model.shortDisplayName || model.id,
    provider: model.modelProvider,
    efforts: [...model.supportedReasoningEfforts],
    image: !model.noImageSupport,
  }, overrides[model.id], source, {
    tokenMultiplier: model.tokenMultiplier,
    isCustom: model.isCustom,
  }));
}

function resolveRow(
  row: FallbackRow,
  override: ModelOverride | undefined,
  source: CatalogSource,
  extras: Pick<ResolvedModel, "tokenMultiplier" | "isCustom"> = {},
): ResolvedModel {
  const metadata = metadataFor(row.id, row.provider);
  const map = thinkingLevelMap(row.efforts ?? []);
  const reasoning = row.efforts?.some((effort) => ![ReasoningEffort.None, ReasoningEffort.Off].includes(effort)) ?? false;
  const piModel: ProviderModelConfig = {
    id: row.id,
    name: override?.name ?? row.name,
    reasoning: override?.reasoning ?? reasoning,
    input: [...(override?.input ?? (row.image ? ["text", "image"] : ["text"]))],
    cost: override?.cost ?? { ...ZERO_COST },
    contextWindow: override?.contextWindow ?? metadata.contextWindow,
    maxTokens: override?.maxTokens ?? metadata.maxTokens,
    thinkingLevelMap: override?.thinkingLevelMap ?? map,
  };
  return { piModel, source, modelProvider: row.provider, ...extras };
}

export function thinkingLevelMap(efforts: readonly ReasoningEffort[]): ThinkingLevelMap | undefined {
  if (efforts.length === 0) return undefined;
  const supported = new Set(efforts);
  const map: ThinkingLevelMap = {};
  for (const level of LEVELS) {
    if (level === "off") {
      map.off = supported.has(ReasoningEffort.Off)
        ? ReasoningEffort.Off
        : supported.has(ReasoningEffort.None)
          ? ReasoningEffort.None
          : null;
      continue;
    }
    map[level] = supported.has(level as ReasoningEffort) ? level : null;
  }
  if (supported.has(ReasoningEffort.Dynamic)) map.medium = ReasoningEffort.Dynamic;
  return map;
}

function metadataFor(id: string, provider: string): { contextWindow: number; maxTokens: number } {
  if (id === "auto") return { contextWindow: 1_000_000, maxTokens: 128_000 };
  if (provider === "anthropic") {
    return /(?:-5|-4-[678])(?:-|$)/.test(id)
      ? { contextWindow: 1_000_000, maxTokens: 128_000 }
      : { contextWindow: 200_000, maxTokens: 32_000 };
  }
  if (provider === "openai") return { contextWindow: 400_000, maxTokens: 100_000 };
  if (provider === "google") return { contextWindow: 1_000_000, maxTokens: 64_000 };
  if (provider === "xai") return { contextWindow: 256_000, maxTokens: 64_000 };
  return { contextWindow: 128_000, maxTokens: 16_384 };
}

export function toStoredModels(models: readonly ResolvedModel[]): Model<Api>[] {
  return models.map(({ piModel }) => ({
    ...piModel,
    api: PROVIDER_API,
    provider: PROVIDER_ID,
    baseUrl: PROVIDER_BASE_URL,
  }));
}

export function fromStoredModels(models: readonly Model<Api>[], overrides: Record<string, ModelOverride>): ResolvedModel[] {
  return models
    .filter((model) => model.provider === PROVIDER_ID)
    .map((model) => resolveRow({
      id: model.id,
      name: model.name,
      provider: inferProvider(model.id),
      efforts: effortsFromMap(model.thinkingLevelMap),
      image: model.input.includes("image"),
    }, overrides[model.id] ?? {
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      cost: model.cost,
    }, "cache"));
}

function effortsFromMap(map: ThinkingLevelMap | undefined): ReasoningEffort[] {
  if (!map) return [];
  return Object.values(map).filter((value): value is ReasoningEffort =>
    typeof value === "string" && Object.values(ReasoningEffort).includes(value as ReasoningEffort));
}

function inferProvider(id: string): string {
  if (id.startsWith("claude-")) return "anthropic";
  if (id.startsWith("gpt-")) return "openai";
  if (id.startsWith("gemini-")) return "google";
  if (id.startsWith("grok-")) return "xai";
  return "factory";
}
