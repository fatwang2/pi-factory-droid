import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fallbackModels } from "./catalog.js";
import { registerCommands } from "./commands.js";
import { CONFIG_PATH_FOR_DIAGNOSTICS, loadConfig } from "./config.js";
import { bindSessionRuntime, createInstanceRuntime, registerProvider } from "./providers.js";
import { applyPermissionOptionCompat } from "./sdk-compat.js";
import type { RuntimeState } from "./types.js";

export default function piDroid(pi: ExtensionAPI): void {
  if (applyPermissionOptionCompat() === "unavailable") {
    console.warn(
      "[pi-droid] Could not widen the SDK permission-option schema. MCP tool calls may fail with 'Failed to handle permission request'.",
    );
  }
  const cfg = loadConfig();
  const initialModels = fallbackModels(cfg.modelOverrides);
  const state: RuntimeState = {
    cfg,
    lastModels: initialModels,
    catalogSource: "fallback",
  };

  // Per-extension-instance runtime: Pi loads extensions per AgentSession, and
  // daemon hosts (e.g. PIXIU) run many sessions concurrently in one process —
  // cwd/ui/session identity must not live in module-level globals.
  const runtime = createInstanceRuntime();

  const stats = registerProvider(pi, cfg, state, runtime);
  registerCommands(pi, state);

  pi.on("session_start", async (_event, ctx) => {
    runtime.ui = ctx.hasUI ? ctx.ui : null;
    runtime.cwd = ctx.cwd;
    // The Pi conversation id keys the Droid session pool: one Droid session
    // per Pi conversation (survives resume; a fresh Pi session → fresh Droid).
    const sessionId = ctx.sessionManager.getSessionId?.();
    runtime.sessionKey = sessionId ?? ctx.cwd;
    // Pi's provider registry is process-wide and last-registration-wins, so the
    // streamFn that serves this session may be another instance's closure.
    // Publish this session's runtime under its id so streamDroid can resolve
    // the true caller per call (stream options carry the session id).
    if (sessionId) bindSessionRuntime(sessionId, runtime);
    if (ctx.hasUI) {
      const issue = state.catalogIssue;
      if (issue) {
        ctx.ui.notify(`pi-droid: catalog fallback [${issue.reason}]. ${issue.message}`, "warning");
      } else {
        const configHint = cfg.loadedFrom ? "" : `; defaults (no ${CONFIG_PATH_FOR_DIAGNOSTICS})`;
        ctx.ui.notify(
          `pi-droid local: ${stats.totalModels} fallback models; account catalog refreshes after authentication; mode=${state.cfg.mode}; autonomy=${state.cfg.autoLevel}${configHint}.`,
          "info",
        );
      }
    }
  });

  pi.on("model_select", async (event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(
      "pi-droid",
      event.model.provider === "droid" ? `Droid: ${event.model.id}` : undefined,
    );
  });

  pi.on("session_shutdown", async () => {
    // NOTE: deliberately NOT closing Droid sessions here. Daemon hosts dispose
    // the Pi AgentSession after every turn while the CONVERSATION continues
    // (resumed next turn) — closing here gave Droid per-turn amnesia and let
    // concurrent turns kill each other's subprocess. Pooled sessions are
    // reclaimed by idle TTL / LRU eviction / process exit instead.
    runtime.ui = null;
  });
}
