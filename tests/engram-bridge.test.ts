import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFlowMemoryQuery,
  parseEngramSearchOutput,
  renderFlowEngramPrefetch,
  type FlowEngramPrefetch,
} from "../src/core/engram-bridge.js";

void test("buildFlowMemoryQuery merges ticket text and caps length", () => {
  const query = buildFlowMemoryQuery("Fix auth redirect", "Google login fails in WebView", "extra");
  assert.match(query, /Fix auth redirect/u);
  assert.match(query, /Google login/u);
  assert.ok(query.length <= 400);
});

void test("parseEngramSearchOutput extracts structured hits", () => {
  const stdout = `Found 1 memories:

[1] #1369 (bugfix) — Closed Social delegated auth handoff
    **What**: Removed legacy bearer path and duplicate credential UI.
    2026-09-09 09:15:08 | project: root | scope: project
`;
  const hits = parseEngramSearchOutput(stdout);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.id, "#1369");
  assert.equal(hits[0]?.type, "bugfix");
  assert.equal(hits[0]?.title, "Closed Social delegated auth handoff");
  assert.match(hits[0]?.excerpt ?? "", /legacy bearer/u);
  assert.equal(hits[0]?.project, "root");
});

void test("renderFlowEngramPrefetch summarizes stored hits", () => {
  const prefetch: FlowEngramPrefetch = {
    schemaVersion: 1,
    ticketId: "GH-42",
    query: "auth redirect",
    hits: [{
      id: "#1",
      type: "decision",
      title: "Use cookie bridge",
      excerpt: "WebView uses postMessage bridge",
      project: "api",
    }],
    atlasWarmed: true,
    recordedAt: new Date().toISOString(),
  };
  const rendered = renderFlowEngramPrefetch(prefetch);
  assert.match(rendered, /GH-42/u);
  assert.match(rendered, /cookie bridge/u);
});
