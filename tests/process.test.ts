import assert from "node:assert/strict";
import test from "node:test";
import { runCommand } from "../src/core/process.js";

void test("runCommand reports success and failure without invoking a shell", () => {
  const success = runCommand(process.execPath, ["-e", "process.stdout.write('ok')"]);
  const failure = runCommand(process.execPath, ["-e", "process.exit(7)"]);
  assert.equal(success.ok, true);
  assert.equal(success.stdout, "ok");
  assert.equal(failure.ok, false);
  assert.equal(failure.status, 7);
});

void test("runCommand normalizes output when an executable is unavailable", () => {
  const missing = runCommand("mr-orchestrator-command-that-does-not-exist", []);
  assert.equal(missing.ok, false);
  assert.equal(missing.status, null);
  assert.equal(typeof missing.stdout, "string");
  assert.equal(typeof missing.stderr, "string");
});
