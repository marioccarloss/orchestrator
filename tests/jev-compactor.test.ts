import assert from "node:assert/strict";
import test from "node:test";
import {
  JevCompactor,
  estimateContextTokens,
  loadJevCompactorConfig,
  type CompactionMessage,
  type JevCompactionRunner,
} from "../src/core/jev-compactor.js";

const FAKE_CREDENTIAL = ["vck", "fixtureSecret0123456789"].join("_");

function textMessage(role: string, text: string): CompactionMessage {
  return {
    info: { id: `${role}-message`, sessionID: "session-1", role },
    parts: [{ id: `${role}-part`, type: "text", text }],
  };
}

function toolMessage(id: string, tool: string, output: string, input: Record<string, unknown> = {}): CompactionMessage {
  return {
    info: { id, sessionID: "session-1", role: "assistant" },
    parts: [{
      id: `${id}-part`,
      type: "tool",
      tool,
      callID: `${id}-call`,
      state: {
        status: "completed",
        input,
        output,
        title: tool,
        metadata: {},
        time: { start: 1, end: 2 },
      },
    }],
  };
}

function toolOutput(message: CompactionMessage): string {
  const part = message.parts[0] as { readonly state: { readonly output: string } };
  return part.state.output;
}

function largeTerminalFixture(): {
  readonly messages: readonly CompactionMessage[];
  readonly keepBlock: string;
  readonly activeOutput: string;
} {
  const obsolete = Array.from(
    { length: 14_000 },
    (_, index) => `OBSOLETE npm test progress ${index.toString().padStart(5, "0")} package=web status=passed cache=hit\n`,
  ).join("");
  const keepBlock = "KEEP_BYTE_EXACT ruta=src/core/critical.ts comando=bun-test π\r\n";
  const activeOutput = "$ bun test tests/critical.test.ts\nError: unresolved current failure at src/core/critical.ts:42\n";
  return {
    messages: [
      textMessage("system", "SYSTEM_INSTRUCTIONS_MUST_NEVER_CHANGE"),
      textMessage("user", "Initial objective"),
      toolMessage("old-bash", "bash", `${obsolete}${keepBlock}`, { command: "bun test" }),
      toolMessage("old-grep", "grep", Array.from({ length: 2_000 }, (_, index) => `OBSOLETE grep hit ${index}\n`).join(""), { pattern: "legacy" }),
      toolMessage("active-bash", "bash", activeOutput, { command: "bun test tests/critical.test.ts" }),
      textMessage("user", `Fix the active command without exposing ${FAKE_CREDENTIAL}`),
    ],
    keepBlock,
    activeOutput,
  };
}

test("shouldCompact uses the configured context-budget ratio", () => {
  const compactor = new JevCompactor({ enabled: true, triggerRatio: 0.75 });
  const context = { messages: [textMessage("user", "hello")], contextWindowTokens: 100_000 };
  assert.equal(compactor.shouldCompact({ ...context, tokenCount: 74_999 }), false);
  assert.equal(compactor.shouldCompact({ ...context, tokenCount: 75_000 }), true);
  assert.equal(new JevCompactor({ enabled: false }).shouldCompact({ ...context, tokenCount: 100_000 }), false);
});

test("JevCompactor prunes a 100k+ token terminal fixture and preserves KEEP bytes and message shape", async () => {
  const fixture = largeTerminalFixture();
  assert.ok(estimateContextTokens(fixture.messages) > 100_000);
  let calls = 0;
  const runner: JevCompactionRunner = async (input) => {
    calls += 1;
    assert.equal(input.model, "typesafe-ai/jev");
    assert.ok(!JSON.stringify(input.state).includes(FAKE_CREDENTIAL));
    assert.ok(Object.keys(input.questions).length > 100);
    assert.ok(Object.values(input.questions).every((question) => question.type === "boolean"));
    return {
      answers: Object.fromEntries(Object.entries(input.questions).map(([id, question]) => [
        id,
        {
          type: "boolean",
          probability: JSON.stringify(question).includes("KEEP_BYTE_EXACT") ? 0.01 : 0.99,
        },
      ])),
    };
  };
  const beforeTokens = estimateContextTokens(fixture.messages);
  const compactor = new JevCompactor({
    enabled: true,
    contextWindowTokens: 160_000,
    triggerRatio: 0.7,
    maxLinesPerChunk: 20,
    maxChunkChars: 2_000,
    maxQuestions: 1_000,
    minToolOutputChars: 0,
    protectedRecentToolResults: 1,
  }, runner);
  const compacted = await compactor.compact({
    messages: fixture.messages,
    tokenCount: beforeTokens,
    contextWindowTokens: 160_000,
    state: { flowStatus: "implementing" },
  });

  assert.equal(calls, 1, "all chunk questions must share one Jev request");
  assert.equal(compacted.messages.length, fixture.messages.length);
  assert.deepEqual(compacted.messages[0], fixture.messages[0], "system message changed");
  assert.deepEqual(compacted.messages.at(-1), fixture.messages.at(-1), "last user message changed");
  assert.equal(toolOutput(compacted.messages[4]!), fixture.activeOutput, "current unresolved tool result changed");
  const oldOutput = toolOutput(compacted.messages[2]!);
  assert.ok(oldOutput.includes(fixture.keepBlock), "KEEP block was not byte-identical");
  assert.match(oldOutput, /líneas redundantes podadas/u);
  assert.equal(compacted.lastCompaction?.strategy, "jev");
  assert.ok((compacted.lastCompaction?.prunedLines ?? 0) > 10_000);
  assert.ok((compacted.tokenCount ?? Number.POSITIVE_INFINITY) < beforeTokens);
});

test("provider failure uses deterministic FIFO fallback without touching current errors", async () => {
  const oldOutput = Array.from({ length: 500 }, (_, index) => `old pytest log ${index}: passed\n`).join("");
  const currentOutput = "Traceback: unresolved current error\n";
  const runner: JevCompactionRunner = async () => {
    throw new Error("gateway unavailable");
  };
  const compactor = new JevCompactor({
    enabled: true,
    triggerRatio: 0.7,
    targetRatio: 0.5,
    contextWindowTokens: 10_000,
    minToolOutputChars: 0,
    protectedRecentToolResults: 1,
  }, runner);
  const compacted = await compactor.compact({
    messages: [
      toolMessage("old", "bash", oldOutput),
      toolMessage("current", "bash", currentOutput),
      textMessage("user", "Continue"),
    ],
    tokenCount: 9_000,
    contextWindowTokens: 10_000,
  });
  assert.equal(compacted.lastCompaction?.strategy, "deterministic-fallback");
  assert.match(compacted.lastCompaction?.reason ?? "", /gateway unavailable/u);
  assert.match(toolOutput(compacted.messages[0]!), /líneas redundantes podadas/u);
  assert.equal(toolOutput(compacted.messages[1]!), currentOutput);
});

test("low-confidence DROP decisions enter the safe fallback", async () => {
  const runner: JevCompactionRunner = async (input) => ({
    answers: Object.fromEntries(Object.keys(input.questions).map((id) => [
      id,
      { type: "boolean", probability: 0.7 },
    ])),
  });
  const compactor = new JevCompactor({
    enabled: true,
    minConfidence: 0.5,
    minToolOutputChars: 0,
    protectedRecentToolResults: 0,
  }, runner);
  const compacted = await compactor.compact({
    messages: [
      toolMessage("old", "grep", "old line\n".repeat(100)),
      textMessage("user", "Continue"),
    ],
    tokenCount: 160_000,
    contextWindowTokens: 200_000,
  });
  assert.equal(compacted.lastCompaction?.strategy, "deterministic-fallback");
  assert.match(compacted.lastCompaction?.reason ?? "", /confidence/u);
});

test("timeout is enforced even when a runner ignores AbortSignal", async () => {
  const runner: JevCompactionRunner = async () => new Promise(() => {
    // Deliberately never settles.
  });
  const compactor = new JevCompactor({
    enabled: true,
    timeoutMs: 100,
    minToolOutputChars: 0,
    protectedRecentToolResults: 0,
  }, runner);
  const started = Date.now();
  const compacted = await compactor.compact({
    messages: [
      toolMessage("old", "bash", "old passing log\n".repeat(100)),
      textMessage("user", "Continue"),
    ],
    tokenCount: 160_000,
    contextWindowTokens: 200_000,
  });
  assert.equal(compacted.lastCompaction?.strategy, "deterministic-fallback");
  assert.match(compacted.lastCompaction?.reason ?? "", /timed out/u);
  assert.ok(Date.now() - started < 500);
});

test("environment config is opt-in and enforces the 1500ms timeout ceiling", () => {
  const config = loadJevCompactorConfig({
    MR_CONTEXT_COMPACTION: "jev",
    JEV_COMPACTION_TRIGGER_RATIO: "0.7",
    JEV_COMPACTION_DROP_THRESHOLD: "0.65",
    JEV_COMPACTION_TIMEOUT_MS: "1500",
    JEV_COMPACTION_TOOLS: "bash,grep",
  });
  assert.equal(config.enabled, true);
  assert.equal(config.triggerRatio, 0.7);
  assert.equal(config.dropThreshold, 0.65);
  assert.deepEqual(config.prunableTools, ["bash", "grep"]);
  assert.throws(
    () => loadJevCompactorConfig({ MR_CONTEXT_COMPACTION: "jev", JEV_COMPACTION_TIMEOUT_MS: "1501" }),
    /<=1500/u,
  );
});
