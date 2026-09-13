import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubTicketAdapter, JiraTicketAdapter, GitLabTicketAdapter, LocalTicketAdapter, createTicketAdapter, inferLocalTicketType, nextLocalTicketId } from "../src/core/ticket.js";
import type { TicketRef } from "../src/core/flow-schema.js";
import { resolvePaths } from "../src/core/paths.js";

const sampleRef: TicketRef = {
  schemaVersion: 1,
  platform: "github",
  id: "123",
};

test("createTicketAdapter returns GitHub adapter for github", () => {
  const adapter = createTicketAdapter("github");
  assert.ok(adapter instanceof GitHubTicketAdapter);
});

test("createTicketAdapter returns Jira adapter for jira", () => {
  const adapter = createTicketAdapter("jira");
  assert.ok(adapter instanceof JiraTicketAdapter);
});

test("createTicketAdapter returns GitLab adapter for gitlab", () => {
  const adapter = createTicketAdapter("gitlab");
  assert.ok(adapter instanceof GitLabTicketAdapter);
});

test("createTicketAdapter returns a user-backed local adapter", async () => {
  const adapter = createTicketAdapter("local", "Fix the broken login flow");
  assert.ok(adapter instanceof LocalTicketAdapter);
  const content = await adapter.fetch({ schemaVersion: 1, platform: "local", id: "LOCAL-20260913-01" });
  assert.equal(content.title, "Fix the broken login flow");
  assert.equal(content.description, "Fix the broken login flow");
  assert.equal(content.type, "bugfix");
  assert.equal(content.source, "user");
});

test("local ticket type inference is deterministic", () => {
  assert.equal(inferLocalTicketType("Production incident hotfix"), "hotfix");
  assert.equal(inferLocalTicketType("Update dependencies"), "chore");
  assert.equal(inferLocalTicketType("Publish release 2"), "release");
  assert.equal(inferLocalTicketType("Add a dashboard"), "feature");
});

test("local ticket ids increment per UTC day", async () => {
  const home = await mkdtemp(join(tmpdir(), "mr-local-ticket-"));
  try {
    const paths = resolvePaths({ HOME: home });
    const now = new Date("2026-09-13T10:00:00.000Z");
    assert.equal(await nextLocalTicketId(paths, "workspace", now), "LOCAL-20260913-01");
    assert.equal(await nextLocalTicketId(paths, "workspace", now), "LOCAL-20260913-02");
    assert.equal(await nextLocalTicketId(paths, "workspace", new Date("2026-09-14T00:00:00.000Z")), "LOCAL-20260914-01");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("GitLabTicketAdapter returns stub content", async () => {
  const adapter = new GitLabTicketAdapter();
  const content = await adapter.fetch(sampleRef);
  assert.equal(content.title, "[GitLab 123]");
  assert.equal(content.description, "GitLab adapter not yet implemented");
});

test("JiraTicketAdapter returns MCP placeholder", async () => {
  const adapter = new JiraTicketAdapter();
  const content = await adapter.fetch(sampleRef);
  assert.equal(content.title, "[Jira 123]");
  assert.ok(content.description.includes("atlassian_read"));
});
