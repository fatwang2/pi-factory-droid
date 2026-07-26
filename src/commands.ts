import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { clearLastError, closeSession, getSessionSnapshot } from "./providers.js";
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
      const snapshot = getSessionSnapshot();
      const issue = state.catalogIssue;
      const issueLine = issue
        ? `  catalog issue=${issue.reason}: ${issue.message}${issue.errorMessage ? ` (${issue.errorMessage})` : ""}`
        : "  catalog issue=none";
      const lines = [
        `droid: ${snapshot.sessionId ? `session ${snapshot.sessionId.slice(0, 8)} (${formatAge(snapshot.lastSpawnAt)})` : "no active session"}`,
        `  model=${snapshot.requestedModel ?? "none"} | resolved=${snapshot.resolvedModel ?? "none"} | reasoning=${snapshot.reasoning ?? "default"}`,
        `  catalog=${state.catalogSource} (${state.lastModels.length} models)${state.catalogUpdatedAt ? `, ${formatAge(state.catalogUpdatedAt)}` : ""}`,
        `  autonomy=${state.cfg.autoLevel} | permissions=${resolvePermissionMode(state.cfg.autoLevel)} | binary=${state.cfg.droidBinary} | strictModelMatch=${state.cfg.strictModelMatch}`,
        `  harness=Factory Droid (Pi supplies UI/provider transport; Droid owns system prompt and tools)`,
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
      await closeSession();
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
    description: "Close the Droid subprocess; the next turn creates a new session.",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      await closeSession();
      clearLastError();
      notify(ctx, "Droid subprocess closed. The next Droid turn will create a new session.", "info");
    },
  });

  pi.registerCommand("droid-harness", {
    description: "Explain which harness runs when using the Droid provider.",
    handler: async (_args, ctx) => {
      const text = "Factory Droid owns the model system prompt, conversation state, tool loop, permissions, and file/command execution. Pi is the outer UI, model selector, session log, and provider transport. Pi's system prompt and built-in tools are not forwarded into Droid.";
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
