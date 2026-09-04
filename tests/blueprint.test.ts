import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BlueprintSpecSchema,
  BlueprintMutationSchema,
  renderBlueprintMarkdown,
  renderBlueprintExecutiveSummary,
  renderSafetyGateDiff,
  saveBlueprintSpec,
  type BlueprintSpec,
} from "../src/core/blueprint-schema.js";

const sampleSpec: BlueprintSpec = {
  schemaVersion: 1,
  slug: "user-feed",
  title: "Red Social - Feed de Publicaciones",
  mode: "idea",
  overview: "Implementación del muro principal con feed algorítmico y paginado por cursor.",
  sdd: {
    entities: [
      {
        name: "Post",
        description: "Publicación de usuario con media y conteos",
        fields: { id: "string", authorId: "string", content: "string" },
      },
    ],
    invariants: ["Un post no puede publicarse sin autor autenticado"],
    contracts: [
      {
        endpointOrFunction: "GET /api/feed",
        input: "{ cursor?: string, limit?: number }",
        output: "{ items: Post[], nextCursor: string | null }",
        errorCases: ["401 Unauthorized"],
      },
    ],
    testConditions: ["GET /api/feed retorna 200 con posts paginados"],
  },
  rpi: {
    requestIntent: "Crear un feed eficiente y escalable para la app móvil y web",
    transversalImpact: ["Afecta al módulo de notificaciones y caché Redis"],
    assumedInferences: ["El cursor se basa en timestamp + id", "Límite máximo 50 posts por página"],
  },
  tasks: [
    {
      id: "T1",
      title: "Diseñar schema de Post y migración",
      description: "Crear tabla posts e índices por autor y timestamp",
      labels: ["backend", "database"],
      priority: "high",
    },
  ],
  createdAt: "2026-09-04T20:00:00.000Z",
};

void test("BlueprintSpecSchema validates full SDD+RPI specification", () => {
  const parsed = BlueprintSpecSchema.parse(sampleSpec);
  assert.equal(parsed.slug, "user-feed");
  assert.equal(parsed.mode, "idea");
  assert.equal(parsed.sdd.entities.length, 1);
  assert.equal(parsed.rpi.assumedInferences.length, 2);
});

void test("BlueprintSpecSchema rejects invalid slugs", () => {
  assert.throws(() => {
    BlueprintSpecSchema.parse({
      ...sampleSpec,
      slug: "Invalid Slug With Spaces",
    });
  });
});

void test("renderBlueprintMarkdown generates structured SDD+RPI document", () => {
  const md = renderBlueprintMarkdown(sampleSpec);
  assert.match(md, /# Blueprint: Red Social - Feed de Publicaciones/u);
  assert.match(md, /### \[Supuestos e Inferencias Asumidas\]/u);
  assert.match(md, /⚠️ El cursor se basa en timestamp \+ id/u);
  assert.match(md, /### Invariantes No Negociables/u);
  assert.match(md, /🔒 Un post no puede publicarse sin autor autenticado/u);
});

void test("renderBlueprintExecutiveSummary produces compact summary under 20 lines", () => {
  const summary = renderBlueprintExecutiveSummary(sampleSpec);
  const lines = summary.split("\n");
  assert.ok(lines.length <= 20, `Summary lines (${lines.length}) should be <= 20`);
  assert.match(summary, /Blueprint Aprobado/u);
  assert.match(summary, /2 inferencias/u);
});

void test("renderSafetyGateDiff formats structured warning banner", () => {
  const mutation = BlueprintMutationSchema.parse({
    action: "delete",
    target: {
      id: "GH-101",
      title: "Eliminar ticket obsoleto",
      repo: "marioccarloss/orchestrator",
    },
  });
  const diff = renderSafetyGateDiff(mutation);
  assert.match(diff, /SAFETY GATE/u);
  assert.match(diff, /🚨 DELETE/u);
  assert.match(diff, /GH-101/u);
});

void test("saveBlueprintSpec persists json and markdown to .blueprint/specs/", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "mr-bp-test-"));
  const result = await saveBlueprintSpec(tmp, sampleSpec);

  assert.ok(result.jsonPath.endsWith("2026-09-04_user-feed.json"));
  assert.ok(result.markdownPath.endsWith("2026-09-04_user-feed.md"));

  const jsonContent = await readFile(result.jsonPath, "utf8");
  const mdContent = await readFile(result.markdownPath, "utf8");

  assert.match(jsonContent, /"slug": "user-feed"/u);
  assert.match(mdContent, /# Blueprint: Red Social - Feed de Publicaciones/u);
});
