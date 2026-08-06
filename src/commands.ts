import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { clearLastError, closeAllSessions, getPoolSnapshot } from "./providers.js";
import type { RuntimeState } from "./types.js";

const PROMPT_ALWAYS_ENV = "PI_DROID_PROMPT_ALWAYS";

function resolvePermissionMode(autoLevel: string): string {
  const raw = process.env[PROMPT_ALWAYS_ENV]?.trim().toLowerCase();
  const promptAlways = raw === "1" || raw === "true" || raw === "yes" || raw === "on";
  return promptAlways ? "prompt-always" : `auto-run-${autoLevel}`;
}

export function registerCommands(pi: ExtensionAPI, state: RuntimeState): void {
  pi.registerCommand("droid-status", {
    description: "Show Factory Droid catalog, model, harness, and subprocess state.",
    handler: async (_args, ctx) => {
      const snapshot = getPoolSnapshot();
      const issue = state.catalogIssue;
      const issueLine = issue
        ? `  catalog issue=${issue.reason}: ${issue.message}${issue.errorMessage ? ` (${issue.errorMessage})` : ""}`
        : "  catalog issue=none";
      const sessionLines = snapshot.entries.length
        ? snapshot.entries.map((entry) =>
            `  session ${entry.sessionId.slice(0, 8)} (${formatAge(entry.spawnedAt)}, used ${formatAge(entry.lastUsedAt)}) ` +
            `model=${entry.requestedModel}→${entry.resolvedModel} reasoning=${entry.reasoning ?? "default"} cwd=${entry.cwd}`)
        : ["  no active droid sessions"];
      const lines = [
        `droid: ${snapshot.entries.length} pooled session(s)`,
        ...sessionLines,
        `  catalog=${state.catalogSource} (${state.lastModels.length} models)${state.catalogUpdatedAt ? `, ${formatAge(state.catalogUpdatedAt)}` : ""}`,
        `  mode=${state.cfg.mode} | autonomy=${state.cfg.autoLevel} | permissions=${resolvePermissionMode(state.cfg.autoLevel)} | binary=${state.cfg.droidBinary} | strictModelMatch=${state.cfg.strictModelMatch} | forwardContext=${state.cfg.forwardContext}`,
        `  harness=${state.cfg.mode === "pi-tools"
          ? "hybrid (Droid session + Pi tool execution via MCP bridge; ToolSearch may remain)"
          : "Factory Droid (Pi supplies UI/provider transport; Droid owns tools; host persona/skills forwarded as context when enabled)"}`,
        `  last error=${snapshot.lastError ?? "none"}`,
        issueLine,
        `  config=${state.cfg.loadedFrom ?? "defaults"}`,
      ];
      for (const line of lines) console.log(`[pi-droid] ${line}`);
      if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), issue ? "warning" : "info");
    },
  });

  pi.registerCommand("droid-models", {
    description: "List the account-aware Factory Droid model catalog.",
    handler: async (_args, ctx) => {
      const groups = new Map<string, typeof state.lastModels>();
      for (const model of state.lastModels) {
        const family = model.modelProvider ?? "unknown";
        groups.set(family, [...(groups.get(family) ?? []), model]);
      }
      console.log(`[pi-droid] catalog source: ${state.catalogSource}`);
      for (const [family, models] of groups) {
        console.log(`[pi-droid] ${family}:`);
        for (const model of models) {
          const multiplier = model.tokenMultiplier === undefined ? "" : ` (${model.tokenMultiplier}x)`;
          console.log(`[pi-droid]   ${model.piModel.id} — ${model.piModel.name}${multiplier}`);
        }
      }
      if (ctx.hasUI) ctx.ui.notify(`${state.lastModels.length} Droid models (${state.catalogSource} catalog); see console for details.`, "info");
    },
  });

  pi.registerCommand("droid-refresh", {
    description: "Refresh account models from Droid and re-read ~/.pi/agent/droid.json.",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      state.cfg = loadConfig();
      await closeAllSessions();
      clearLastError();
      await ctx.modelRegistry.refresh();
      const issue = state.catalogIssue;
      const message = issue
        ? `Droid refresh fell back to ${state.catalogSource} catalog (${state.lastModels.length} models): [${issue.reason}] ${issue.message}`
        : `Droid catalog refreshed: ${state.lastModels.length} account models.`;
      notify(ctx, message, issue ? "warning" : "info");
    },
  });

  pi.registerCommand("droid-restart", {
    description: "Close all pooled Droid subprocesses; next turns create fresh sessions.",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      await closeAllSessions();
      clearLastError();
      notify(ctx, "All Droid sessions closed. Next Droid turns will create fresh sessions.", "info");
    },
  });

  pi.registerCommand("droid-harness", {
    description: "Explain which harness runs when using the Droid provider.",
    handler: async (_args, ctx) => {
      const mode = state.cfg.mode;
      const text = mode === "pi-tools"
        ? [
            "mode=pi-tools (experimental hybrid bridge).",
            "Droid still owns the cloud session, system prompt, compaction, and model billing.",
            "Native Droid tools are disabled (ToolSearch may remain); Pi tools are injected as an SDK MCP server.",
            "When Droid calls a pi-tools MCP tool, the MCP handler suspends and Pi executes the tool, then the next streamSimple delivers the result.",
            "This is NOT a raw LLM provider (unlike antigravity): it is claude-bridge-style tool bridging on top of Droid.",
            "Set mode via ~/.pi/agent/droid.json { \"mode\": \"pi-tools\" } or PI_DROID_MODE=pi-tools.",
          ].join(" ")
        : [
            "mode=agent (default).",
            "Factory Droid owns the model system prompt, tool loop, permissions, and file/command execution.",
            "Pi is the outer UI, model selector, session log, and provider transport.",
            "Droid sessions are pooled per Pi conversation. With forwardContext enabled (default), AGENTS.md and skills ride as user-level context; Pi built-in tool definitions are never forwarded.",
            "Switch to hybrid Pi tool execution with { \"mode\": \"pi-tools\" } in ~/.pi/agent/droid.json.",
          ].join(" ");
      console.log(`[pi-droid] ${text}`);
      if (ctx.hasUI) ctx.ui.notify(text, "info");
    },
  });
}

function notify(
  ctx: ExtensionContext | ExtensionCommandContext,
  message: string,
  kind: "info" | "warning" | "error",
): void {
  if (ctx.hasUI) ctx.ui.notify(message, kind);
  else if (kind === "error") console.error(`[pi-droid] ${message}`);
  else console.log(`[pi-droid] ${message}`);
}

function formatAge(timestamp: number | undefined): string {
  if (!timestamp) return "unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
