import { ToolConfirmationListItemSchema } from "@factory/droid-sdk";

// Compatibility shim for @factory/droid-sdk 0.6.0.
//
// Droid >= 0.180 offers MCP-specific confirmation outcomes
// (`proceed_always_tools`, `proceed_always_server`, `proceed_always_file`) in the
// `options` list of a `droid.request_permission` request. The published SDK
// validates `options[].value` with `z.nativeEnum(ToolConfirmationOutcome)` against
// the stale 12-member enum in `src/schemas/enums.ts`, so parsing the request params
// throws before our permissionHandler ever runs. The SDK turns that into a
// `-32603 Failed to handle permission request` response and Droid cancels the tool
// call — which is why MCP writes (e.g. `linear___save_comment`) silently died while
// read-only calls kept working.
//
// Upstream already fixed this on main (Factory-AI/droid-sdk-typescript, commit
// ee28e4c) by widening the field to `z.union([z.nativeEnum(...), z.string()])`, but
// 0.6.0 is still the latest npm release. Apply the same widening in place until a
// release ships; the probe below makes the shim a no-op on a fixed SDK.

const PROBE_OPTION = { label: "probe", value: "proceed_always_tools" };

export type PermissionOptionCompatResult = "not-needed" | "applied" | "unavailable";

type MutableZodObject = {
  _def?: { shape?: () => Record<string, unknown> };
  _cached?: unknown;
};

let result: PermissionOptionCompatResult | undefined;

export function applyPermissionOptionCompat(): PermissionOptionCompatResult {
  if (result) return result;
  result = patch();
  return result;
}

function patch(): PermissionOptionCompatResult {
  if (ToolConfirmationListItemSchema.safeParse(PROBE_OPTION).success) return "not-needed";

  const schema = ToolConfirmationListItemSchema as unknown as MutableZodObject;
  const originalShape = schema._def?.shape;
  if (typeof originalShape !== "function") return "unavailable";

  // Reuse the sibling `label` validator rather than importing zod ourselves: it is a
  // plain string schema built by the SDK's own zod instance, which is exactly what
  // the upstream union collapses to at runtime.
  const anyString = originalShape().label;
  if (!anyString) return "unavailable";

  schema._def!.shape = () => ({ ...originalShape(), value: anyString });
  schema._cached = null;

  return ToolConfirmationListItemSchema.safeParse(PROBE_OPTION).success ? "applied" : "unavailable";
}

export const __testUtils = { PROBE_OPTION };
