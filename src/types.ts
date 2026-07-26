import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { CatalogFallbackIssue } from "./fallback-issue.js";

export type AutoLevel = "low" | "medium" | "high";
export type CatalogSource = "fallback" | "account" | "cache";

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
  models?: Record<string, ModelOverride>;
}

export interface ResolvedConfig {
  droidBinary: string;
  autoLevel: AutoLevel;
  defaultModel: string;
  strictModelMatch: boolean;
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
