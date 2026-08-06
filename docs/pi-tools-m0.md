# M0 probe results (pi-tools feasibility)

Date: 2026-08-06  
Host: local Factory Droid CLI `0.180.0` + `@factory/droid-sdk@0.6.0`

## Command

```bash
node scripts/m0-probe.mjs
```

## Results

| Check | Result |
|---|---|
| `listTools()` | 113 tools (includes global user MCP: Linear, OpenSEO, etc.) |
| Disable non-probe tools | PASS — only `mcp_pi-probe_ping` + **ToolSearch** remain allowed |
| ToolSearch fully disableable? | **NO** — always stays allowed |
| Tool naming | MCP tool `ping` on server `pi-probe` → `llmId=pi-probe___ping`, catalog id `mcp_pi-probe_ping` |
| Discovery path | Model first calls `ToolSearch` with `select:pi-probe___ping`, then the real tool |
| `tool_call` before hang | PASS |
| MCP handler hang 12s | PASS (`hang observed 12001ms`) |
| Final text | `pong:hello` |

## Implications for `mode=pi-tools`

1. Never disable **our** MCP catalog ids when applying `disabledToolIds`.
2. Always allow **ToolSearch** (Factory hard-keeps it); treat its events as internal.
3. Map Droid llm names `pi-tools___${name}` back to Pi tool names.
4. MCP handlers may suspend across Pi tool execution; stream is notification-based so `tool_call` is visible before/while handler runs.
5. User-global Droid MCP servers (Linear/…) appear in the catalog and must be disabled in pi-tools mode.

## Enable

```json
// ~/.pi/agent/droid.json
{ "mode": "pi-tools" }
```

or `PI_DROID_MODE=pi-tools`, then `/reload` or restart Pi.
