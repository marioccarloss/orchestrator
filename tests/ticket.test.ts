import { test } from "bun:test";
import assert from "node:assert/strict";
import { GitHubTicketAdapter, JiraTicketAdapter, GitLabTicketAdapter, createTicketAdapter } from "../src/core/ticket.js";
import type { TicketRef } from "../src/core/flow-schema.js";

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
