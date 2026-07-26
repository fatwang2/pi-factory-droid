import assert from "node:assert/strict";
import test from "node:test";
import {
  __testUtils,
  discoveryFailedIssue,
  emptyModelListIssue,
  missingApiKeyIssue,
} from "../src/fallback-issue.js";

test("missing-api-key issue carries auth setup hint", () => {
  const issue = missingApiKeyIssue();
  assert.equal(issue.reason, "missing-api-key");
  assert.match(issue.message, /\/login droid/);
  assert.match(issue.message, /FACTORY_API_KEY/);
  assert.equal(issue.errorMessage, undefined);
});

test("empty-model-list issue reason is classified distinctly from discovery-failed", () => {
  const issue = emptyModelListIssue();
  assert.equal(issue.reason, "empty-model-list");
  assert.match(issue.message, /empty availableModels/);
});

test("discovery-failed with ENOENT is classified as droid-missing and points to install URL", () => {
  const issue = discoveryFailedIssue(new Error("spawn ENOENT: droid not found"));
  assert.equal(issue.reason, "droid-missing");
  assert.match(issue.message, new RegExp(__testUtils.DROID_INSTALL_URL));
  assert.equal(issue.errorMessage, "spawn ENOENT: droid not found");
});

test("discovery-failed with 'command not found' is also droid-missing", () => {
  const issue = discoveryFailedIssue("droid: command not found");
  assert.equal(issue.reason, "droid-missing");
});

test("discovery-failed with non-spawn error stays discovery-failed", () => {
  const issue = discoveryFailedIssue(new Error("HTTP 401: unauthorized"));
  assert.equal(issue.reason, "discovery-failed");
  assert.doesNotMatch(issue.message, /docs\.factory\.ai/);
  assert.equal(issue.errorMessage, "HTTP 401: unauthorized");
});

test("isDroidMissingError is case-insensitive and matches multiple phrasings", () => {
  assert.equal(__testUtils.isDroidMissingError("Error: ENOENT no such file"), true);
  assert.equal(__testUtils.isDroidMissingError("Command not found in PATH"), true);
  assert.equal(__testUtils.isDroidMissingError("spawn droid ENOENT"), true);
  assert.equal(__testUtils.isDroidMissingError("network timeout"), false);
  assert.equal(__testUtils.isDroidMissingError("401 unauthorized"), false);
});
