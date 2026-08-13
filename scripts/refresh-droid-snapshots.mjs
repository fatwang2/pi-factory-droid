#!/usr/bin/env node
// Refresh the bundled Factory model fallback snapshot.
//
// Runs a one-shot Droid discovery session using FACTORY_API_KEY (or pi's stored
// Factory credential), reads `availableModels`, and writes
// `src/catalog.generated.ts` so the fallback catalog tracks the live Factory
// backend without hand-maintaining `FALLBACK_ROWS` in catalog.ts.
//
// Usage:
//   FACTORY_API_KEY=... npm run refresh:snapshots
//   # or, if pi auth is already stored:
//   node scripts/refresh-droid-snapshots.mjs
//
// Flags:
//   --out <path>   Output file (default: src/catalog.generated.ts)
//   --binary <p>   Droid binary path (default: from DROID_BINARY env or "droid")
//   --model <id>   Discovery model id (default: "auto")

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AutonomyLevel,
  createSession,
  ReasoningEffort,
  ToolConfirmationOutcome,
} from "@factory/droid-sdk";

// --- Enum value -> enum member name mappings (must be defined before use) ---
const MODEL_PROVIDER_ENUM = {
  anthropic: "ModelProvider.ANTHROPIC",
  openai: "ModelProvider.OPENAI",
  "generic-chat-completion-api": "ModelProvider.GENERIC_CHAT_COMPLETION_API",
  factory: "ModelProvider.FACTORY",
  google: "ModelProvider.GOOGLE",
  xai: "ModelProvider.XAI",
  voyage: "ModelProvider.VOYAGE",
};

const REASONING_EFFORT_ENUM = {
  none: "ReasoningEffort.None",
  dynamic: "ReasoningEffort.Dynamic",
  off: "ReasoningEffort.Off",
  minimal: "ReasoningEffort.Minimal",
  low: "ReasoningEffort.Low",
  medium: "ReasoningEffort.Medium",
  high: "ReasoningEffort.High",
  xhigh: "ReasoningEffort.ExtraHigh",
  max: "ReasoningEffort.Max",
};

function toModelProviderEnum(value) {
  return MODEL_PROVIDER_ENUM[value] ?? JSON.stringify(value);
}

function toReasoningEffortEnum(value) {
  return REASONING_EFFORT_ENUM[value] ?? JSON.stringify(value);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");
const DEFAULT_OUT = join(PKG_ROOT, "src", "catalog.generated.ts");
const PI_AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");

const args = parseArgs(process.argv.slice(2));
const outPath = args.out ?? DEFAULT_OUT;
const droidBinary = args.binary ?? process.env.DROID_BINARY?.trim() ?? "droid";
const discoveryModelId = args.model ?? "auto";

const apiKey = resolveApiKey();
if (!apiKey) {
  console.error(
    "[refresh-snapshots] No Factory API key. Set FACTORY_API_KEY, log in via `/login droid`, or pass --api-key.",
  );
  process.exit(1);
}

console.log(`[refresh-snapshots] discovering via \`${droidBinary}\` (model=${discoveryModelId})...`);
const models = await discoverModels(apiKey);
if (models.length === 0) {
  console.error("[refresh-snapshots] Droid returned an empty availableModels catalog. Snapshot not written.");
  process.exit(2);
}

const takenAt = new Date().toISOString();
writeSnapshot(outPath, models, takenAt);
console.log(
  `[refresh-snapshots] wrote ${models.length} models to ${outPath} (snapshot taken at ${takenAt}).`,
);

async function discoverModels(key) {
  const env = { ...process.env, FACTORY_API_KEY: key };
  const session = await createSession({
    cwd: process.cwd(),
    execPath: droidBinary,
    modelId: discoveryModelId,
    autonomyLevel: AutonomyLevel.Low,
    permissionHandler: () => ToolConfirmationOutcome.Cancel,
    askUserHandler: async () => ({ cancelled: true, answers: [] }),
    env,
  });
  try {
    return session.initResult.availableModels ?? [];
  } finally {
    await session.close();
  }
}

function resolveApiKey() {
  const fromEnv = process.env.FACTORY_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const fromArg = args["api-key"];
  if (fromArg) return fromArg.trim();
  return readPiStoredFactoryKey();
}

function readPiStoredFactoryKey() {
  if (!existsSync(PI_AUTH_PATH)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(PI_AUTH_PATH, "utf8"));
    const roots = [parsed?.providers, parsed];
    // `droid` is this extension's provider id in pi; `factory` covers older stores.
    for (const root of roots) {
      for (const name of ["droid", "factory"]) {
        const entry = root?.[name];
        const key = entry?.apiKey ?? entry?.key;
        if (typeof key === "string" && key.trim()) return key.trim();
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") out.out = argv[++i];
    else if (arg.startsWith("--out=")) out.out = arg.slice("--out=".length);
    else if (arg === "--binary") out.binary = argv[++i];
    else if (arg.startsWith("--binary=")) out.binary = arg.slice("--binary=".length);
    else if (arg === "--model") out.model = argv[++i];
    else if (arg.startsWith("--model=")) out.model = arg.slice("--model=".length);
    else if (arg === "--api-key") out["api-key"] = argv[++i];
    else if (arg.startsWith("--api-key=")) out["api-key"] = arg.slice("--api-key=".length);
  }
  return out;
}

function writeSnapshot(path, models, takenAt) {
  mkdirSync(dirname(path), { recursive: true });
  const body = renderSnapshot(models, takenAt);
  writeFileSync(path, body, "utf8");
}

function renderSnapshot(models, takenAt) {
  const rows = models.map((m) => formatRow(m)).join(",\n  ");
  const fallbackKeyHash = createHash("sha256").update(takenAt).digest("hex").slice(0, 16);
  return `// AUTO-GENERATED by \`npm run refresh:snapshots\`. Do not edit by hand.
// Snapshot taken: ${takenAt}
// Source: Factory account discovery via @factory/droid-sdk
// Regen: \`FACTORY_API_KEY=... npm run refresh:snapshots\`

import { ModelProvider, ReasoningEffort, type AvailableModelConfig } from "@factory/droid-sdk";

export const SNAPSHOT_TAKEN_AT = ${JSON.stringify(takenAt)};
export const SNAPSHOT_KEY = ${JSON.stringify(fallbackKeyHash)};

export const SNAPSHOT_MODELS: readonly AvailableModelConfig[] = [
  ${rows}
];
`;
}

function formatRow(m) {
  // Stable field order, only known fields, no passthrough noise.
  const fields = [];
  fields.push(`id: ${JSON.stringify(m.id)}`);
  if (m.modelId !== undefined) fields.push(`modelId: ${JSON.stringify(m.modelId)}`);
  fields.push(`displayName: ${JSON.stringify(m.displayName)}`);
  fields.push(`shortDisplayName: ${JSON.stringify(m.shortDisplayName)}`);
  fields.push(`modelProvider: ${toModelProviderEnum(m.modelProvider)}`);
  fields.push(
    `supportedReasoningEfforts: [${(m.supportedReasoningEfforts ?? [])
      .map((e) => toReasoningEffortEnum(e))
      .join(", ")}]`,
  );
  fields.push(`defaultReasoningEffort: ${toReasoningEffortEnum(m.defaultReasoningEffort)}`);
  fields.push(`isCustom: ${m.isCustom === true ? "true" : "false"}`);
  if (m.noImageSupport) fields.push(`noImageSupport: true`);
  if (m.supportsPDFs) fields.push(`supportsPDFs: true`);
  if (m.tier) fields.push(`tier: ${JSON.stringify(m.tier)}`);
  if (m.tokenMultiplier !== undefined) fields.push(`tokenMultiplier: ${m.tokenMultiplier}`);
  if (m.promoLabel) fields.push(`promoLabel: ${JSON.stringify(m.promoLabel)}`);
  if (m.usesUSBasedInference) fields.push(`usesUSBasedInference: true`);
  return `    { ${fields.join(", ")} }`;
}
