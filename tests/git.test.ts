import { test } from "bun:test";
import assert from "node:assert/strict";
import { generateBranchName, suggestCommitMessage } from "../src/core/git.js";

test("generateBranchName creates feature branch", () => {
  const branch = generateBranchName("GH-123", "feature", "Add login button");
  assert.equal(branch, "feature/GH-123-add-login-button");
});

test("generateBranchName creates bugfix branch", () => {
  const branch = generateBranchName("GH-456", "bugfix", "Fix alignment");
  assert.equal(branch, "bugfix/GH-456-fix-alignment");
});

test("generateBranchName creates hotfix branch", () => {
  const branch = generateBranchName("GH-789", "hotfix", "Critical fix");
  assert.equal(branch, "hotfix/GH-789-critical-fix");
});

test("generateBranchName handles no slug", () => {
  const branch = generateBranchName("GH-100", "feature");
  assert.equal(branch, "feature/GH-100-100");
});

test("suggestCommitMessage with conventional commits", () => {
  const recent = ["feat: add login", "fix: resolve bug", "chore: update deps"];
  const msg = suggestCommitMessage("GH-123", "Add login button", recent);
  assert.equal(msg, "feat: add login button (GH-123)");
});

test("suggestCommitMessage without conventional commits", () => {
  const recent = ["Add login", "Fix bug"];
  const msg = suggestCommitMessage("GH-123", "Add login button", recent);
  assert.equal(msg, "feat: add login button (GH-123)");
});

test("suggestCommitMessage truncates long titles", () => {
  const longTitle = "This is a very long title that should be truncated because it exceeds the maximum length allowed";
  const msg = suggestCommitMessage("GH-123", longTitle, []);
  assert.ok(msg.length <= 70);
  assert.ok(msg.includes("GH-123"));
});
