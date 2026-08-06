/**
 * M0 probe: can we disable native Droid tools and suspend an SDK MCP handler
 * long enough for a Pi-style tool bridge?
 *
 * Usage:
 *   FACTORY_API_KEY=... node scripts/m0-probe.mjs
 *   # or rely on ~/.pi/agent/auth.json droid.key
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const sdkPath = join(
  new URL("..", import.meta.url).pathname,
  "node_modules/@factory/droid-sdk/dist/index.js",
);
const {
  AutonomyLevel,
  DroidMessageType,
  ToolConfirmationOutcome,
  createSession,
  createSdkMcpServer,
  tool,
} = await import(pathToFileURL(sdkPath).href);

function loadApiKey() {
  if (process.env.FACTORY_API_KEY?.trim()) return process.env.FACTORY_API_KEY.trim();
  try {
    const auth = JSON.parse(readFileSync(join(homedir(), ".pi/agent/auth.json"), "utf8"));
    const key = auth?.droid?.key;
    if (typeof key === "string" && key.trim()) return key.trim();
  } catch {
    // ignore
  }
  throw new Error("No FACTORY_API_KEY / ~/.pi/agent/auth.json droid.key");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const HANG_MS = Number(process.env.M0_HANG_MS || 12_000);
const apiKey = loadApiKey();
const cwd = process.cwd();

console.log("=== M0 pi-tools feasibility probe ===");
console.log(`droid binary: ${(await import("node:child_process")).execSync("which droid", { encoding: "utf8" }).trim()}`);
console.log(`hangMs=${HANG_MS}`);

const handlerState = {
  enteredAt: null,
  resolvedAt: null,
  input: null,
};

const mcp = createSdkMcpServer({
  name: "pi-probe",
  tools: [
    tool(
      "ping",
      "Probe tool. Call this with message='hello'. It deliberately hangs before returning.",
      { message: z.string() },
      async ({ message }) => {
        handlerState.enteredAt = Date.now();
        handlerState.input = message;
        console.log(`[mcp] ping entered message=${JSON.stringify(message)} hang=${HANG_MS}ms`);
        await sleep(HANG_MS);
        handlerState.resolvedAt = Date.now();
        console.log(`[mcp] ping resolved after ${handlerState.resolvedAt - handlerState.enteredAt}ms`);
        return `pong:${message}`;
      },
    ),
  ],
});

const session = await createSession({
  apiKey,
  cwd,
  execPath: "droid",
  modelId: "auto",
  autonomyLevel: AutonomyLevel.High,
  mcpServers: [mcp],
  permissionHandler: (params) => {
    const types = (params.toolUses || []).map((t) => t.details?.type ?? "?");
    console.log(`[permission] auto-approve types=${types.join(",")}`);
    return ToolConfirmationOutcome.ProceedOnce;
  },
  askUserHandler: async () => ({ cancelled: true, answers: [] }),
});

try {
  const listed = await session.listTools();
  const tools = listed.tools || [];
  console.log(`\n[listTools] count=${tools.length}`);
  for (const t of tools) {
    console.log(
      `  - id=${t.id} llmId=${t.llmId} category=${t.category} allowed=${t.currentlyAllowed} default=${t.defaultAllowed}`,
    );
  }
  // Disable everything except our SDK MCP tools. Disabling ALL ids also kills
  // mcp_pi-probe_ping (observed in first probe run).
  const keep = (t) =>
    t.id === "mcp_pi-probe_ping" ||
    t.llmId === "pi-probe___ping" ||
    String(t.id || "").startsWith("mcp_pi-probe_") ||
    String(t.llmId || "").startsWith("pi-probe___");
  const disableIds = tools.map((t) => t.id).filter((id, i) => id && !keep(tools[i]));
  const keepTools = tools.filter(keep);
  console.log(`\n[policy] keep=${keepTools.map((t) => t.id).join(",") || "(none)"}`);
  console.log(`[policy] disable=${disableIds.length} tools`);
  if (disableIds.length) {
    console.log(`\n[updateSettings] disabling non-probe tools...`);
    await session.updateSettings({ disabledToolIds: disableIds });
    const after = await session.listTools();
    const stillAllowed = (after.tools || []).filter((t) => t.currentlyAllowed);
    console.log(`[listTools after disable] stillAllowed=${stillAllowed.length}`);
    for (const t of stillAllowed) {
      console.log(`  allowed: id=${t.id} llmId=${t.llmId}`);
    }
  }

  console.log("\n[stream] asking model to call ping...\n");
  const t0 = Date.now();
  const events = [];
  let firstToolCallAt = null;
  let text = "";

  for await (const event of session.stream(
    "You must call the MCP tool named ping (server pi-probe) exactly once with message='hello'. Do not use any other tools. After the tool returns, reply with only the tool result text.",
    { includePartialMessages: true },
  )) {
    const elapsed = Date.now() - t0;
    events.push({ elapsed, type: event.type });
    if (
      event.type === DroidMessageType.ToolCall ||
      event.type === DroidMessageType.ToolCallDelta
    ) {
      if (firstToolCallAt == null) firstToolCallAt = elapsed;
      const tu = event.toolUse || {};
      console.log(
        `[+${elapsed}ms] ${event.type} name=${tu.name || tu.toolName || "?"} id=${tu.id || tu.toolUseId || "?"}`,
      );
      console.log(`         input=${JSON.stringify(tu.input || tu.toolInput || {})}`);
    } else if (event.type === DroidMessageType.ToolResult) {
      console.log(
        `[+${elapsed}ms] tool_result name=${event.toolName} id=${event.toolUseId} err=${event.isError}`,
      );
      console.log(`         content=${JSON.stringify(event.content).slice(0, 200)}`);
    } else if (event.type === DroidMessageType.AssistantTextDelta) {
      text += event.text || "";
      process.stdout.write(event.text || "");
    } else if (event.type === DroidMessageType.AssistantTextComplete) {
      process.stdout.write("\n");
    } else if (event.type === DroidMessageType.Result) {
      console.log(
        `\n[+${elapsed}ms] result success=${event.success} isError=${event.isError} text=${JSON.stringify(event.text || event.result || "").slice(0, 200)}`,
      );
    } else if (event.type === DroidMessageType.Error) {
      console.log(`[+${elapsed}ms] error ${event.errorType}: ${event.message}`);
    } else if (event.type === DroidMessageType.WorkingStateChanged) {
      console.log(`[+${elapsed}ms] working_state=${event.state}`);
    } else {
      // keep noise low
      if (!String(event.type).includes("token") && !String(event.type).includes("thinking")) {
        console.log(`[+${elapsed}ms] ${event.type}`);
      }
    }
  }

  const total = Date.now() - t0;
  console.log("\n=== summary ===");
  console.log(`totalMs=${total}`);
  console.log(`firstToolCallAtMs=${firstToolCallAt}`);
  console.log(`mcpEntered=${handlerState.enteredAt != null}`);
  console.log(`mcpResolved=${handlerState.resolvedAt != null}`);
  if (handlerState.enteredAt && firstToolCallAt != null) {
    // approximate: tool event before hang completed?
    console.log(`mcpHangObservedMs=${(handlerState.resolvedAt || Date.now()) - handlerState.enteredAt}`);
  }
  console.log(`finalText=${JSON.stringify(text).slice(0, 300)}`);
  console.log(`eventTypes=${[...new Set(events.map((e) => e.type))].join(",")}`);

  const okToolEvent = firstToolCallAt != null;
  const okHang = handlerState.enteredAt != null && handlerState.resolvedAt != null
    && handlerState.resolvedAt - handlerState.enteredAt >= HANG_MS - 500;
  const okNoTimeout = handlerState.resolvedAt != null;
  console.log("\n=== verdict ===");
  console.log(`tool_call_before_or_during_hang: ${okToolEvent ? "PASS" : "FAIL"}`);
  console.log(`mcp_handler_survived_${HANG_MS}ms: ${okHang && okNoTimeout ? "PASS" : "FAIL"}`);
  console.log(`native_tools_disableable: ${disableIds.length ? "PASS(see stillAllowed)" : "UNKNOWN"}`);
  if (!(okToolEvent && okHang && okNoTimeout)) process.exitCode = 2;
} finally {
  await session.close().catch(() => {});
}
