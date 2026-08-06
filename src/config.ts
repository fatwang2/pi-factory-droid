import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AutoLevel, ConfigFile, DroidMode, ModelOverride, ResolvedConfig } from "./types.js";

const DEFAULT_DROID_BINARY = "droid";
const DEFAULT_AUTO_LEVEL: AutoLevel = "low";
const DEFAULT_MODEL = "auto";
const DEFAULT_MODE: DroidMode = "agent";
const CONFIG_PATH = join(homedir(), ".pi", "agent", "droid.json");

export function loadConfig(): ResolvedConfig {
  const fromFile = readConfigFile(CONFIG_PATH);
  const envBinary = process.env.DROID_BINARY?.trim();
  const envAutoLevel = coerceAutoLevel(process.env.DROID_AUTO_LEVEL?.trim());

  const envForward = coerceBooleanEnv(process.env.PI_DROID_FORWARD_CONTEXT);
  const envMode = coerceMode(process.env.PI_DROID_MODE?.trim());

  return {
    droidBinary: envBinary || fromFile.parsed.droidBinary?.trim() || DEFAULT_DROID_BINARY,
    autoLevel: envAutoLevel ?? coerceAutoLevel(fromFile.parsed.autoLevel) ?? DEFAULT_AUTO_LEVEL,
    defaultModel: fromFile.parsed.defaultModel?.trim() || DEFAULT_MODEL,
    strictModelMatch: fromFile.parsed.strictModelMatch ?? true,
    forwardContext: envForward ?? fromFile.parsed.forwardContext ?? true,
    mode: envMode ?? coerceMode(fromFile.parsed.mode) ?? DEFAULT_MODE,
    modelOverrides: normalizeModelOverrides(fromFile.parsed.models),
    loadedFrom: fromFile.exists ? CONFIG_PATH : undefined,
  };
}

function coerceBooleanEnv(raw: string | undefined): boolean | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === "") return undefined;
  if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
  if (value === "0" || value === "false" || value === "no" || value === "off") return false;
  return undefined;
}

function readConfigFile(path: string): { exists: boolean; parsed: ConfigFile } {
  if (!existsSync(path)) return { exists: false, parsed: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return { exists: true, parsed: coerceConfigFile(parsed, path) };
  } catch (error) {
    console.warn(`[pi-droid] Failed to read ${path}: ${(error as Error).message}. Using defaults.`);
    return { exists: true, parsed: {} };
  }
}

function coerceConfigFile(value: unknown, path: string): ConfigFile {
  if (!isPlainObject(value)) {
    console.warn(`[pi-droid] ${path} is not a JSON object. Ignoring contents.`);
    return {};
  }
  const out: ConfigFile = {};
  if (typeof value.droidBinary === "string") out.droidBinary = value.droidBinary;
  const auto = coerceAutoLevel(value.autoLevel);
  if (auto) out.autoLevel = auto;
  if (typeof value.defaultModel === "string") out.defaultModel = value.defaultModel;
  if (typeof value.strictModelMatch === "boolean") out.strictModelMatch = value.strictModelMatch;
  if (typeof value.forwardContext === "boolean") out.forwardContext = value.forwardContext;
  const mode = coerceMode(value.mode);
  if (mode) out.mode = mode;
  if (isPlainObject(value.models)) out.models = value.models as Record<string, ModelOverride>;
  return out;
}

function coerceAutoLevel(value: unknown): AutoLevel | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function coerceMode(value: unknown): DroidMode | undefined {
  return value === "agent" || value === "pi-tools" ? value : undefined;
}

function normalizeModelOverrides(raw: Record<string, ModelOverride> | undefined): Record<string, ModelOverride> {
  if (!raw) return {};
  const out: Record<string, ModelOverride> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isPlainObject(value)) continue;
    const input = value as Record<string, unknown>;
    const override: ModelOverride = {};
    if (typeof input.name === "string") override.name = input.name;
    if (typeof input.reasoning === "boolean") override.reasoning = input.reasoning;
    if (Array.isArray(input.input)) {
      const supported = input.input.filter((item): item is "text" | "image" => item === "text" || item === "image");
      if (supported.length) override.input = supported;
    }
    for (const field of ["contextWindow", "maxTokens"] as const) {
      const number = input[field];
      if (typeof number === "number" && Number.isFinite(number) && number > 0) override[field] = number;
    }
    if (isPlainObject(input.thinkingLevelMap)) {
      override.thinkingLevelMap = input.thinkingLevelMap as ThinkingLevelMapLike;
    }
    if (isPlainObject(input.cost)) {
      const cost = input.cost as Record<string, unknown>;
      if (["input", "output", "cacheRead", "cacheWrite"].every((key) => typeof cost[key] === "number")) {
        override.cost = cost as ModelOverride["cost"];
      }
    }
    out[id] = override;
  }
  return out;
}

type ThinkingLevelMapLike = NonNullable<ModelOverride["thinkingLevelMap"]>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const CONFIG_PATH_FOR_DIAGNOSTICS = CONFIG_PATH;
