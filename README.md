# pi-factory-droid

A [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent) provider extension that exposes [Factory Droid](https://docs.factory.ai/cli) models through the local `@factory/droid-sdk` runtime, with account-aware model discovery, autonomy-aware permission routing, and offline fallback snapshots.

## Why

Pi's built-in provider list does not include Factory Droid. This extension registers a `droid` provider whose model catalog is fetched live from `session.initResult.availableModels`, so Pi's model picker reflects whatever the authenticated Factory account can actually use (Anthropic, OpenAI, Google, xAI, Factory core models, and BYOK custom models).

## Harness ownership

This is an agent-to-agent bridge, not a raw model provider:

- **Pi owns:** terminal UI, provider/model selection, outer session log, cancellation, and rendering.
- **Factory Droid owns:** its system prompt, internal conversation, tools, permission protocol, file edits, commands, and tool loop.

Pi's built-in tool definitions are never forwarded. **Host context IS forwarded
by default** (`forwardContext`, disable via config or
`PI_DROID_FORWARD_CONTEXT=0`): the working directory's `AGENTS.md`
(persona/long-term memory) and the same skills catalog Pi would inject
(`~/.pi/agent/skills`, `<cwd>/.pi/skills`, and the `.agents/skills` tiers from
cwd up to the git root plus `~/.agents/skills`, closest-wins) ride into the
Droid session as a user-level preamble on its first turn. Skills are plain
files, so Droid reads the referenced `SKILL.md` with its own tools. When the
forwarded context changes (persona edited, memory consolidated, skills added),
the session is transparently recreated so the new context takes effect.

## Session pooling

Droid sessions are pooled **per Pi conversation** (keyed by the Pi session id,
which survives resume), not kept as a process-wide singleton. This matters for
daemon hosts that run many Pi sessions concurrently in one process (several
bots × several chats, e.g. [PIXIU](https://github.com/fatwang2)): each
conversation gets its own Droid subprocess, so histories never bleed across
chats, working directories never mix, and a fresh Pi conversation (`/new`,
idle cutoff) starts a fresh Droid session. Pool bounds: 8 subprocesses max
(LRU-evicted), 15-minute idle TTL, best-effort close on process exit.
`session_shutdown` no longer kills sessions — daemon hosts dispose the Pi
AgentSession after every turn while the conversation continues.

## Features

- Passes Pi's selected model id and reasoning effort to the Factory Droid SDK.
- Live model discovery from `session.initResult.availableModels`, with persistent cache (`~/.pi/agent/models-store.json`) restored on restart when offline.
- Long-lived Droid session reused across turns; model/reasoning changes applied via `session.updateSettings()` without respawning.
- Strict model match verification on session creation (rejects silent model substitution by `auto`).
- Account-aware fallback catalog with per-provider context windows, plus a generated snapshot (`src/catalog.generated.ts`) that tracks the live Factory backend.
- Autonomy-aware permission handler: `autoLevel` maps to `ProceedAutoRunLow/Medium/High` instead of always popping a Pi confirm dialog. `PI_DROID_PROMPT_ALWAYS=1` restores the legacy always-prompt behavior.
- Structured catalog fallback issues (`missing-api-key`, `empty-model-list`, `droid-missing`, `discovery-failed`) with targeted remediation hints in `/droid-status` and session start.
- Droid `askUser` and permission requests routed into Pi's UI.
- Supported image attachments forwarded to Droid.
- Real token usage and cost tracking via `calculateCost`.

## Install

```bash
pi install https://github.com/fatwang2/pi-factory-droid
```

Or from a local checkout:

```bash
pi install ~/repos/pi-factory-droid
```

Requires the [Droid CLI](https://docs.factory.ai/cli/getting-started/quickstart) on PATH:

```bash
curl -fsSL https://app.factory.ai/cli | sh
```

## Authentication

```bash
# Option A: Pi-stored credential (recommended)
/login droid    # paste a Factory API key

# Option B: environment variable
export FACTORY_API_KEY=your-key
```

After login, run `/droid-refresh` to fetch the account-aware model catalog.

## Commands

- `/droid-status` - Show catalog, model, harness, subprocess state, and any catalog fallback issue.
- `/droid-models` - List the account-aware Factory Droid model catalog grouped by provider.
- `/droid-refresh` - Refresh account models from Droid and re-read `~/.pi/agent/droid.json`.
- `/droid-restart` - Close the Droid subprocess; the next turn creates a new session.
- `/droid-harness` - Explain which harness runs when using the Droid provider.

## Configuration

Optional `~/.pi/agent/droid.json`:

```json
{
  "droidBinary": "droid",
  "autoLevel": "low",
  "defaultModel": "auto",
  "strictModelMatch": true,
  "models": {}
}
```

- `autoLevel` (`low` | `medium` | `high`): maps to Droid's `ProceedAutoRunLow/Medium/High` so high autonomy means no permission prompts. Override with `PI_DROID_PROMPT_ALWAYS=1` to force Pi UI confirmation on every action.
- `strictModelMatch`: rejects silent model substitution when Droid resolves `auto` to a different model id.
- `models`: per-model overrides (`name`, `reasoning`, `contextWindow`, `maxTokens`, `cost`, `thinkingLevelMap`, `input`).

## Fallback snapshot

The bundled fallback catalog in `src/catalog.ts` (`FALLBACK_ROWS`) is hand-maintained for offline use. To regenerate a snapshot from the live Factory backend:

```bash
FACTORY_API_KEY=... npm run refresh:snapshots
```

This writes `src/catalog.generated.ts`, which `fallbackModels()` prefers over `FALLBACK_ROWS` when non-empty.

## Development

```bash
npm install
npm run check        # typecheck + tests
npm run typecheck
npm test
```

## Acknowledgments

Based on [`@victormilk/pi-droid`](https://github.com/victormilk/pilks-mono/tree/main/packages/pi-droid) by Victor Leite Costa, released under MIT. The upstream README is preserved as `README.upstream.md` for historical reference.

## License

MIT. See [LICENSE](LICENSE).
