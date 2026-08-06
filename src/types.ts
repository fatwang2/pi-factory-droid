import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { CatalogFallbackIssue } from "./fallback-issue.js";

export type AutoLevel = "low" | "medium" | "high";
export type CatalogSource = "fallback" | "account" | "cache";
/** agent = Droid owns tools (legacy). pi-tools = bridge Pi tools via MCP. */
export type DroidMode = "agent" | "pi-tools";

export interface ModelOverride {
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input?: ReadonlyArray<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

export interface ConfigFile {
  droidBinary?: string;
  autoLevel?: AutoLevel;
  defaultModel?: string;
  strictModelMatch?: boolean;
  /** Forward the host's AGENTS.md + skills catalog into Droid sessions
   *  (default true). Disable to keep Droid fully context-blind. */
  forwardContext?: boolean;
  /**
   * agent (default): Droid runs its own tool loop.
   * pi-tools: disable native tools and bridge Pi tools through SDK MCP so
   * execution happens in Pi (claude-bridge style). Still not a raw LLM API.
   */
  mode?: DroidMode;
  models?: Record<string, ModelOverride>;
}

export interface ResolvedConfig {
  droidBinary: string;
  autoLevel: AutoLevel;
  defaultModel: string;
  strictModelMatch: boolean;
  forwardContext: boolean;
  mode: DroidMode;
  modelOverrides: Record<string, ModelOverride>;
  loadedFrom?: string;
}

export interface ResolvedModel {
  piModel: ProviderModelConfig;
  source: CatalogSource;
  modelProvider?: string;
  tokenMultiplier?: number;
  isCustom?: boolean;
}

export interface RuntimeState {
  cfg: ResolvedConfig;
  lastModels: ReadonlyArray<ResolvedModel>;
  catalogSource: CatalogSource;
  catalogUpdatedAt?: number;
  catalogIssue?: CatalogFallbackIssue;
}
