import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fallbackModels } from "./catalog.js";
import { registerCommands } from "./commands.js";
import { CONFIG_PATH_FOR_DIAGNOSTICS, loadConfig } from "./config.js";
import { registerProvider, setRuntimeContext, wireSessionShutdown } from "./providers.js";
import type { RuntimeState } from "./types.js";

export default function piDroid(pi: ExtensionAPI): void {
  const cfg = loadConfig();
  const initialModels = fallbackModels(cfg.modelOverrides);
  const state: RuntimeState = {
    cfg,
    lastModels: initialModels,
    catalogSource: "fallback",
  };

  const stats = registerProvider(pi, cfg, state);
  wireSessionShutdown(pi);
  registerCommands(pi, state);

  pi.on("session_start", async (_event, ctx) => {
    setRuntimeContext(ctx.hasUI ? ctx.ui : null, ctx.cwd);
    if (ctx.hasUI) {
      const issue = state.catalogIssue;
      if (issue) {
        ctx.ui.notify(`pi-droid: catalog fallback [${issue.reason}]. ${issue.message}`, "warning");
      } else {
        const configHint = cfg.loadedFrom ? "" : `; defaults (no ${CONFIG_PATH_FOR_DIAGNOSTICS})`;
        ctx.ui.notify(
          `pi-droid local: ${stats.totalModels} fallback models; account catalog refreshes after authentication; autonomy=${state.cfg.autoLevel}${configHint}.`,
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
    setRuntimeContext(null);
  });
}
