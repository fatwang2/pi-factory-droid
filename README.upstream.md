# @victormilk/pi-droid

Pi Coding Agent extension that registers Factory.AI Droid models as a model provider, backed by a long-lived `droid exec` subprocess managed via [`@factory/droid-sdk`](https://github.com/Factory-AI/droid-sdk-typescript).

## Requirements

- Pi Coding Agent ≥ 0.74
- Node ≥ 20 (pi-droid) / ≥ 18 (droid-sdk)
- `droid` CLI on PATH (or `droidBinary` configured)
- `FACTORY_API_KEY` exported in the environment

## Install

From this monorepo (local checkout):

```bash
pi install ./packages/pi-droid
```

Or one-off without installing:

```bash
pi -e ./packages/pi-droid/src/index.ts
```

## Models

The curated catalog mirrors [`docs.factory.ai/models.md`](https://docs.factory.ai/models.md) — Anthropic, OpenAI, Google, and Droid Core families (~24 entries). Browse with:

```bash
pi --list-models | grep "^droid/"
pi /droid-models
```

## Configuration

Optional `~/.pi/agent/droid.json`:

```json
{
  "droidBinary": "/usr/local/bin/droid",
  "autoLevel": "medium",
  "defaultModel": "claude-sonnet-4-6",
  "models": {
    "claude-opus-4-7": {
      "cost": { "input": 15, "output": 75, "cacheRead": 1.5, "cacheWrite": 18.75 }
    }
  }
}
```

Env vars override the file: `DROID_BINARY`, `DROID_AUTO_LEVEL`.

## Commands

- `/droid-status` — report session + config state
- `/droid-models` — list curated models grouped by family
- `/droid-refresh` — re-register the provider after editing the config file
- `/droid-restart` — close the subprocess; next turn respawns

## Architecture

Single Pi provider `"droid"` with a custom `streamSimple` body. The SDK owns:

- The `droid exec` subprocess via `ProcessTransport`
- JSON-RPC framing + request-id correlation
- Abort → `droid.interrupt_session` wiring
- Turn completion detection via `StreamStateTracker`

pi-droid owns: event translation (`DroidMessage` → `AssistantMessageEvent`), the curated model catalog, the four `/droid-*` commands, and one cached `DroidSession` singleton.

Tool calls are permission-auto-resolved via `permissionHandler: () => ToolConfirmationOutcome.ProceedOnce` — combined with `--auto medium`, this disables interactive confirmation. Set `autoLevel: "low"` if you want Droid's own confirmation gates back.

## License

MIT
