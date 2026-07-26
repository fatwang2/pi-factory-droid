// Structured catalog fallback reason + human-facing guidance.
// Used by refreshModels/discoverAccountModels when live discovery cannot
// return a usable model list, so /droid-status and session_start can give
// targeted remediation hints instead of a bare error string.

export type CatalogFallbackReason =
  | "missing-api-key"
  | "discovery-failed"
  | "empty-model-list"
  | "droid-missing";

export interface CatalogFallbackIssue {
  reason: CatalogFallbackReason;
  message: string;
  errorMessage?: string;
}

const AUTH_SETUP_HINT =
  "/login droid, FACTORY_API_KEY, or --api-key";
const CATALOG_REFRESH_HINT =
  "After adding auth to an already-started pi session, run /droid-refresh to refresh the live Factory model catalog without restarting pi.";
const DROID_INSTALL_URL = "https://docs.factory.ai/cli/getting-started/quickstart";

export function missingApiKeyIssue(): CatalogFallbackIssue {
  return {
    reason: "missing-api-key",
    message: [
      `Factory model catalog unavailable: set auth via ${AUTH_SETUP_HINT}.`,
      "Using bundled fallback models until auth is configured.",
      CATALOG_REFRESH_HINT,
    ].join(" "),
  };
}

export function emptyModelListIssue(): CatalogFallbackIssue {
  return {
    reason: "empty-model-list",
    message: [
      "Factory returned an empty availableModels catalog. Using bundled fallback models.",
      CATALOG_REFRESH_HINT,
    ].join(" "),
  };
}

export function discoveryFailedIssue(error: unknown): CatalogFallbackIssue {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const reason: CatalogFallbackReason = isDroidMissingError(errorMessage)
    ? "droid-missing"
    : "discovery-failed";
  return {
    reason,
    message:
      reason === "droid-missing"
        ? `Factory model catalog unavailable: \`droid\` CLI not found on PATH. Install it from ${DROID_INSTALL_URL}. ${CATALOG_REFRESH_HINT}`
        : `Factory model catalog discovery failed; using bundled fallback models. ${CATALOG_REFRESH_HINT}`,
    errorMessage,
  };
}

function isDroidMissingError(message: string): boolean {
  const lowered = message.toLowerCase();
  return (
    lowered.includes("enoent") ||
    lowered.includes("spawn") ||
    lowered.includes("not found") ||
    lowered.includes("command not found") ||
    lowered.includes("no such file or directory")
  );
}

export const __testUtils = { isDroidMissingError, DROID_INSTALL_URL };
