import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { __testUtils } from "../src/providers.js";
import type { ResolvedConfig } from "../src/types.js";

const { buildContextBlock, renderPreamble } = __testUtils;

function makeCfg(forwardContext: boolean): ResolvedConfig {
  return {
    droidBinary: "droid",
    autoLevel: "low",
    defaultModel: "auto",
    strictModelMatch: true,
    forwardContext,
    modelOverrides: {},
  };
}

test("buildContextBlock forwards AGENTS.md and cwd-local skills", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-droid-ctx-"));
  try {
    writeFileSync(join(cwd, "AGENTS.md"), "# 角色\n\n你是测试成员甲。");
    const skillDir = join(cwd, ".agents", "skills", "ctx-probe");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: ctx-probe\ndescription: probe skill for context forwarding test\n---\n\n# probe\n",
    );

    const block = buildContextBlock(cwd, makeCfg(true));
    assert.match(block, /你是测试成员甲/);
    assert.match(block, /ctx-probe/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("buildContextBlock is empty when disabled or nothing to forward", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-droid-ctx-"));
  try {
    writeFileSync(join(cwd, "AGENTS.md"), "# 角色\n\n内容");
    assert.equal(buildContextBlock(cwd, makeCfg(false)), "");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("renderPreamble wraps the block and explains skills usage", () => {
  const preamble = renderPreamble("BLOCK");
  assert.match(preamble, /<host-context>\nBLOCK\n<\/host-context>/);
  assert.match(preamble, /SKILL\.md/);
  assert.match(preamble, /当前对话消息/);
});
