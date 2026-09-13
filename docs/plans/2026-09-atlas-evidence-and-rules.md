# Atlas: evidencia compartida y reglas por repositorio — Guía de implementación one-shot

Estado: propuesto · Fecha: 2026-09-13 · Repositorio: `mr-orchestrator` · Ejecutor: un modelo de razonamiento medio/alto, una sesión por desarrollo

Este documento describe **dos desarrollos independientes** y da a un modelo implementador todo lo necesario para ejecutar cada uno de principio a fin, paso a paso, sin improvisar. Complementa (no sustituye) al programa general `docs/plans/2026-09-flow-reliability-program.md`; aquí se recorta a lo esencial para que cada desarrollo sea abordable en una sola pasada.

- **Desarrollo A — Evidencia compartida.** Atlas deja de fingir frescura, ofrece niveles de contexto con coste creciente y guarda la evidencia una sola vez para que Explore la descubra, Plan la reutilice y los roles posteriores la reciban ya hidratada.
- **Desarrollo B — Reglas por repositorio (`mr atlas init`).** Una subfuncionalidad opcional y developer-friendly del init que perfila cada repositorio del workspace, propone reglas base y el "sabor" del desarrollador, pide como máximo tres decisiones y genera `AGENTS.md` compactos válidos para cualquier editor o agente.

El texto de este documento está en español (para humanos). Todo lo que se cree en código —identificadores, esquemas, prompts, artefactos JSON y `AGENTS.md`— va en **inglés**.

---

## 0. Reglas del juego para el implementador

### 0.1 Antes de empezar

1. Leer completo este documento y la fila de la tarea que se va a ejecutar.
2. Leer **cuerpos completos** de cada símbolo que se vaya a modificar (no solo skeletons).
3. Confirmar que `bun run check` está verde en `main` antes del primer cambio.
4. No tocar `models.json`, el roster de modelos ni la FSM de `/flow` (`src/core/flow-schema.ts`) salvo donde se indique explícitamente.

### 0.2 Restricciones de código (no negociables)

| Regla | Detalle |
|---|---|
| TypeScript estricto | El repo usa `noUncheckedIndexedAccess` y `exactOptionalPropertyTypes`. Nunca `any`, nunca `!` no justificado. |
| Zod | Siempre `z.strictObject`. Esquemas versionados con `schemaVersion: z.literal(n)`. |
| Persistencia | `atomicWrite` + `canonicalJson` de `src/core/files.ts`. Nunca `writeFile` directo para artefactos. |
| Funciones puras | Toda lógica de análisis/render es una función pura testeable; la E/S vive en funciones separadas con prefijo `load*`/`save*`. |
| Markdown | Ningún artefacto interno lo redacta el modelo; lo genera código (`src/core/render.ts` o módulo dedicado). |
| Degradación | Todo lo nuevo es *best-effort*: si falla, el comportamiento anterior sigue funcionando y se emite un aviso. |
| Idioma | Prompts, descripciones de tools, esquemas y artefactos: inglés. Mensajes de CLI/TUI: español (coherente con `src/cli.ts` actual). |
| Tests | En `tests/*.test.ts` con `bun:test` + `node:assert/strict`, fixtures en `mkdtemp`. Cada paso añade o amplía tests. |
| Commits | Un commit por paso: `feat(evidence): ...`, `feat(atlas): ...`, `feat(rules): ...`, `test(...)`, `docs(...)`. |

### 0.3 Definición de "paso terminado"

Un paso está terminado cuando: (1) el criterio "Hecho cuando" de su tabla se cumple, (2) `bun run check` pasa, (3) el commit está creado. Si un paso exige una decisión no cubierta aquí, **detenerse** y anotarla en la sección 4 (Decisiones abiertas) en lugar de improvisar.

### 0.4 Estado actual verificado (punto de partida)

| Elemento | Situación real | Referencia |
|---|---|---|
| Indexador | `AtlasIndexer.indexWorkspace(root, { includePatterns?, excludePatterns? })` → `AtlasGraph` v1 (`nodes`, `edges`, `stats`, `gitStamp?`) | `src/core/atlas.ts:440-536` |
| Caché | `${paths.cacheRoot}/${workspaceId}/atlas-graph.json`; invalidación por `gitStamp = sha256(HEAD + git status --porcelain)`; un archivo ya `M` que cambia de nuevo **no** invalida | `src/core/atlas.ts:71-77, 989-1008`, `src/plugin.ts:154-168` |
| Tools Atlas | `mr_atlas_index`, `mr_atlas_query` (info/deps/dependents/impact/governance), `mr_atlas_skeleton` | `src/plugin.ts:876-1013, 1274-1296` |
| Evidencia | `ResearchCapsulePayload.evidence[] = { claim, file, line?, source }`; sin hash, rango ni símbolo | `src/core/sdd-schema.ts:21-48` |
| Tareas | `SddTask = { id, title, dependsOn, requirements, files, verify, doneWhen, status }` | `src/core/sdd-schema.ts:160-169` |
| Validación | `validateSddArtifacts` comprueba DAG, trazabilidad y "archivo modificado tiene evidencia" (soft) | `src/core/sdd-schema.ts:205-288` |
| Next task | `mr_sdd_get kind=next-task` devuelve `{ implementer, developerNote, task, acceptance }` sin cuerpos de código | `src/plugin.ts:1196-1245` |
| Jueces | `buildJudgePrompt(diff, judge)` solo recibe el diff | `src/core/judgment.ts:242` |
| CLI | No existe `mr atlas`; `src/cli.ts` usa `switch(command)` y helpers `heading/info/success/warning` de `src/tui/index.ts`; TUI interactiva con `@clack/prompts` en `src/tui/models.ts` | `src/cli.ts:222-237` |
| Config generada | `buildOpenCodeConfig` fija `instructions: [join(profile.root, "AGENTS.md"), ...overlay]` | `src/core/config.ts:601` |
| Workspace | `WorkspaceProfile = { id, name, root, contextRoot (= root/.aicontext), ticket? }` | `src/core/schema.ts:7-19`, `src/core/workspace.ts:41-63` |
| Persistencia SDD | `${paths.generatedRoot}/${workspaceId}/sdd/*.json` | `src/core/sdd-schema.ts:324-326` |

---

## 1. Desarrollo A — Evidencia compartida

### 1.1 Objetivo

Que la evidencia se **descubra una vez** (Explore), se **guarde con hash** (EvidenceStore), se **reutilice en el plan** (Plan referencia ids, no redescubre) y se **hidrate por rol** (implementador, jueces y fix reciben exactamente los slices que necesitan, dentro de un presupuesto). Y que Atlas nunca entregue contexto obsoleto ni oculte lo que no cubre.

### 1.2 Principios

1. **Frescura por contenido, no por git.** Cada archivo indexado tiene `contentHash`; la caché solo es válida si ningún hash cambió.
2. **Cobertura honesta.** Toda respuesta de Atlas termina con un recibo: qué no se indexó, qué imports no se resolvieron, si el grafo está fresco.
3. **Niveles de contexto.** El modelo pide el nivel más barato que resuelva su duda: mapa → skeleton → dependencias → slice exacto → tests. Nunca "lee el archivo" como primer recurso.
4. **Evidencia = slice con hash.** Una referencia apunta a `file + range + fileHash + sliceHash`; si el archivo cambia, se detecta y se intenta relocalizar por símbolo.
5. **Hidratación determinista.** Qué recibe cada rol lo decide código, no el orquestador ni el modelo.

### 1.3 Arquitectura

```text
Explore ──mr_atlas_query/skeleton/slice──▶ Atlas (graph v2 + coverage)
   │
   └──mr_evidence_add──▶ EvidenceStore (store.json + slices/*.txt)
                              │
Plan ──mr_sdd_get research──▶ ResearchCapsule v2 (evidenceRefs, coverage, contracts, tests)
   │
   └──mr_sdd_submit tasks──▶ TaskGraph v2 (targetSymbols, evidenceRefs, invariants)
                              │
Implement/Judge/Fix ◀──mr_context_hydrate(role, taskId)── ContextBundle (slices + tests + neighbors + coverage, con presupuesto)
```

### 1.4 Contratos

#### A. `AtlasGraph` v2 (`src/core/atlas.ts`)

```ts
export interface AtlasFileRecord {
  readonly path: string;            // relative to workspace root
  readonly contentHash: string;     // sha256 of file content
  readonly language: "typescript" | "tsx" | "java" | "json" | "yaml" | "unsupported";
  readonly parseStatus: "ok" | "partial" | "error" | "unsupported";
  readonly nodeIds: readonly string[];
}

export interface AtlasCoverage {
  readonly indexerVersion: string;                               // bump on extractor changes, e.g. "2.0.0"
  readonly supportedLanguages: readonly string[];
  readonly unsupportedFiles: readonly string[];                  // matched include patterns but no extractor
  readonly parseErrors: readonly { path: string; line: number; message: string }[];
  readonly unresolvedImports: readonly { from: string; specifier: string }[];
}

export interface AtlasGraph {
  readonly schemaVersion: 2;
  readonly generatedAt: string;
  readonly workspaceRoot: string;
  readonly nodes: readonly AtlasNode[];
  readonly edges: readonly AtlasEdge[];
  readonly files: readonly AtlasFileRecord[];
  readonly coverage: AtlasCoverage;
  readonly stats: { totalFiles: number; totalNodes: number; totalEdges: number; indexDurationMs: number };
  readonly gitStamp?: string;       // informational only, no longer the cache key
}
```

Reglas:
- `loadAtlasGraph` devuelve `undefined` si `schemaVersion !== 2` (fuerza reindexado completo una vez).
- Nueva función pura `isGraphFresh(graph, currentHashes: ReadonlyMap<string,string>): { fresh: boolean; changed: string[]; added: string[]; removed: string[] }`.
- Nueva función `computeFileHashes(root, files)` con atajo: si `mtime+size` coincide con lo guardado en un índice auxiliar `${cacheRoot}/${ws}/atlas-stat.json`, no releer el archivo.
- El indexado incremental **no es obligatorio** en este desarrollo: si `fresh === false`, reindexar completo. Dejar el hueco (`options.previous?: AtlasGraph`) documentado.

#### B. Recibo de cobertura (`src/core/render.ts`)

```ts
export interface CoverageReceiptScope { readonly files?: readonly string[]; readonly nodeIds?: readonly string[] }
export function renderCoverageReceipt(graph: AtlasGraph, fresh: boolean, scope?: CoverageReceiptScope): string;
```

Salida (inglés, ≤ 8 líneas, solo elementos relevantes al `scope` si se pasa):

```text
--- coverage ---
fresh: yes | no (reindexed)
unsupported: 2 files (src/legacy/a.php, src/legacy/b.php)
unresolved imports: 1 (src/x.ts → @acme/ui)
parse errors: 0
```

Se **añade al final** de la salida de `mr_atlas_index`, `mr_atlas_query`, `mr_atlas_skeleton` y de la nueva acción `slice`.

#### C. Niveles de contexto (`src/plugin.ts`, `src/core/atlas.ts`)

| Nivel | Herramienta | Coste | Uso |
|---|---|---|---|
| L0 mapa | `mr_atlas_query action=map` | ~300 tokens | Qué repos/raíces existen, cuántos nodos por kind, lenguajes, cobertura global |
| L1 skeleton | `mr_atlas_skeleton filePath depth=signatures` (actual) | 10–15 % del archivo | Firmas e imports |
| L2 grafo | `mr_atlas_query action=info/deps/dependents/impact` (actual) | pequeño | Relaciones |
| L3 slice | `mr_atlas_query action=slice nodeName|nodeId [context=N]` | solo el cuerpo | Código exacto de un símbolo ± N líneas, con `range` y `fileHash` listos para `mr_evidence_add` |
| L4 tests | `mr_atlas_query action=tests nodeName` | pequeño | Archivos de test que importan el módulo del símbolo (heurística: nombre `*.test.*`/`*.spec.*`/`__tests__/` con arista `import` hacia el archivo) |

Implementación:
- `extractSlice(root, node, context): Promise<{ file, range: [number, number], text, fileHash, sliceHash }>` en `src/core/atlas.ts` (usa `node.line`/`node.endLine`; si `endLine` no existe en `AtlasNode`, añadirlo al extractor TS/Java a partir de `node.endPosition.row`).
- `findTestsFor(graph, node)` en `src/core/atlas.ts` (función pura).
- `renderWorkspaceMap(graph)` en `src/core/render.ts`.

#### D. `EvidenceStore` (`src/core/evidence-store.ts`, nuevo)

```ts
export const EvidenceKindSchema = z.enum(["behavior", "contract", "type", "test", "config", "route", "style", "doc"]);
export const EvidenceSourceSchema = z.enum(["atlas", "lsp", "grep", "read", "memory", "ticket", "user"]);

export const EvidenceRefSchema = z.strictObject({
  id: z.string().regex(/^ev-[a-z0-9]{8}$/u),          // "ev-" + first 8 hex of sliceHash
  file: z.string().min(1),
  symbol: z.string().optional(),
  range: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  fileHash: z.string().length(64),
  sliceHash: z.string().length(64),
  kind: EvidenceKindSchema,
  source: EvidenceSourceSchema,
  supports: z.array(z.string().regex(/^R\d+$/u)).default([]),
  claim: z.string().min(1).max(300),
  createdAt: z.iso.datetime(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const EvidenceStoreSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ticketId: z.string().min(1),
  refs: z.array(EvidenceRefSchema),
});
export type EvidenceStore = z.infer<typeof EvidenceStoreSchema>;

export type FreshnessResult =
  | { status: "fresh" }
  | { status: "relocated"; range: [number, number]; fileHash: string }
  | { status: "stale"; reason: "file-changed" | "file-missing" | "symbol-not-found" };

export interface AddEvidenceInput {
  readonly file: string; readonly startLine: number; readonly endLine: number;
  readonly kind: EvidenceKind; readonly source: EvidenceSource; readonly claim: string;
  readonly supports?: readonly string[]; readonly symbol?: string;
}

export async function addEvidence(paths: MrPaths, workspaceId: string, workspaceRoot: string, ticketId: string, input: AddEvidenceInput): Promise<EvidenceRef>;
export async function loadEvidenceStore(paths: MrPaths, workspaceId: string, ticketId: string): Promise<EvidenceStore | undefined>;
export async function listEvidence(paths: MrPaths, workspaceId: string, ticketId: string, filter?: { kind?: EvidenceKind; supports?: string; file?: string }): Promise<readonly EvidenceRef[]>;
export async function readSlice(paths: MrPaths, workspaceId: string, ticketId: string, ref: EvidenceRef): Promise<string | undefined>;
export async function checkFreshness(workspaceRoot: string, ref: EvidenceRef, graph?: AtlasGraph): Promise<FreshnessResult>;
export function evidenceDir(paths: MrPaths, workspaceId: string, ticketId: string): string; // `${generatedRoot}/${ws}/evidence/${safeTicket}`
```

Reglas:
- `addEvidence` lee el archivo, calcula `fileHash` (contenido completo) y `sliceHash` (líneas `[start,end]` exactas, `\n`-joined), guarda el slice en `slices/${sliceHash}.txt` (idempotente) y añade/actualiza la ref en `store.json`. Si ya existe una ref con el mismo `sliceHash`, se fusionan `supports` y se devuelve la existente.
- `checkFreshness`: si el `fileHash` actual coincide → `fresh`. Si no y hay `symbol` + `graph`, buscar el nodo por nombre en el mismo archivo y devolver `relocated` con su rango nuevo. Si no → `stale`.
- `ticketId` se sanea como en `writeSddMarkdown` (`toLowerCase().replace(/[^a-z0-9]+/gu, "-")`).

#### E. `ResearchCapsule` v2 (`src/core/sdd-schema.ts`)

```ts
export const ResearchCoverageSchema = z.strictObject({
  fresh: z.boolean(),
  unsupportedFiles: z.array(z.string()).default([]),
  unresolvedImports: z.array(z.string()).default([]),
});
export const ContractRefSchema = z.strictObject({
  name: z.string().min(1), file: z.string().min(1),
  kind: z.enum(["dto", "interface", "schema", "route", "event", "federation"]),
});
export const TestRefSchema = z.strictObject({ file: z.string().min(1), covers: z.array(z.string()).default([]) });

export const ResearchCapsulePayloadV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  ticketId: z.string().min(1),
  objective: z.string().min(1).max(300),
  evidenceRefs: z.array(z.string().regex(/^ev-[a-z0-9]{8}$/u)).min(1),
  coverage: ResearchCoverageSchema,
  contracts: z.array(ContractRefSchema).default([]),
  tests: z.array(TestRefSchema).default([]),
  relevantNodes: z.array(z.string()).default([]),
  constraints: z.array(z.string().max(300)).default([]),
  unknowns: z.array(z.string().max(300)).default([]),
});
```

Reglas:
- `ResearchCapsulePayloadSchema` pasa a ser `z.union([V1, V2])` **en la entrada** (`mr_sdd_submit`) y se **persiste siempre v2**. Migración `migrateResearchToV2(v1, store)`: por cada `evidence[]` legado se crea una ref via `addEvidence` con `range = [line ?? 1, line ?? 1]`, `kind: "behavior"`.
- `validateSddArtifacts` recibe además `store?: EvidenceStore` y `freshness?: ReadonlyMap<string, FreshnessResult>`:
  - cada `evidenceRefs` debe existir en el store → `error`;
  - cada ref con `status: "stale"` → `error` en Full, `warning` en Lite;
  - cada requisito `Rn` sin al menos una ref con `supports ∋ Rn` → `error` en Full, `warning` en Lite;
  - se mantiene la comprobación existente "archivo modificado sin evidencia" usando `ref.file`.

#### F. `SddTask` v2 (`src/core/sdd-schema.ts`)

Solo los campos necesarios para hidratar; los límites de edición y gates quedan para el programa general (F3).

```ts
export const SddTaskSchema = z.strictObject({
  id, title, dependsOn, requirements, files, verify, doneWhen, status,     // existentes, sin cambios
  targetSymbols: z.array(z.string().min(1)).default([]),                   // Atlas node names
  evidenceRefs: z.array(z.string().regex(/^ev-[a-z0-9]{8}$/u)).default([]),
  invariants: z.array(z.string().max(300)).default([]),                   // "must keep true" statements
});
export const TaskGraphPayloadSchema = z.strictObject({ schemaVersion: z.literal(2), ticketId, tasks });
```

- Entrada: `z.union([V1, V2])`; persistencia siempre v2; migración v1→v2 rellena `evidenceRefs` con las refs del store cuyo `file` coincide con `task.files[].path`.
- `validateSddArtifacts`: si `task.evidenceRefs` está vacío y alguna `files[].action === "modify"`, `warning` (Lite) / `error` (Full).

#### G. `ContextBundle` e hidratación (`src/core/context-hydrator.ts`, nuevo)

```ts
export const HydrationRoleSchema = z.enum(["plan", "implement", "judge-a", "judge-b", "fix"]);
export type HydrationRole = z.infer<typeof HydrationRoleSchema>;

export interface ContextSlice { readonly ref: string; readonly file: string; readonly range: [number, number]; readonly kind: EvidenceKind; readonly claim: string; readonly text: string; readonly freshness: FreshnessResult["status"] }
export interface ContextNeighbor { readonly file: string; readonly symbol: string; readonly relation: "dependent" | "dependency"; readonly signature?: string }

export interface ContextBundle {
  readonly schemaVersion: 1;
  readonly role: HydrationRole;
  readonly ticketId: string;
  readonly taskId?: string;
  readonly task?: SddTask;
  readonly acceptance?: readonly Requirement[];
  readonly slices: readonly ContextSlice[];
  readonly tests: readonly TestRef[];
  readonly contracts: readonly ContractRef[];
  readonly neighbors: readonly ContextNeighbor[];
  readonly rules: readonly RuleDigest[];              // vacío hasta Desarrollo B
  readonly coverage: ResearchCoverage;
  readonly budget: { readonly requestedChars: number; readonly usedChars: number; readonly truncated: readonly string[] };
}

export const DEFAULT_BUDGET_CHARS: Readonly<Record<HydrationRole, number>> = { plan: 50_000, implement: 60_000, "judge-a": 40_000, "judge-b": 40_000, fix: 30_000 };

export interface HydrateInput {
  readonly role: HydrationRole; readonly ticketId: string; readonly taskId?: string;
  readonly research: ResearchCapsulePayloadV2; readonly spec?: SpecCapsulePayload; readonly tasks?: TaskGraphPayload;
  readonly store: EvidenceStore; readonly graph: AtlasGraph;
  readonly readSlice: (ref: EvidenceRef) => Promise<string | undefined>;
  readonly checkFreshness: (ref: EvidenceRef) => Promise<FreshnessResult>;
  readonly budgetChars?: number;
  readonly diff?: string;                              // judges/fix
  readonly findings?: readonly JudgeFinding[];         // fix
}
export async function hydrateContext(input: HydrateInput): Promise<ContextBundle>;
export function serializeBundle(bundle: ContextBundle): string;   // compact, deterministic, model-facing
```

Política de selección (determinista):

| Rol | Slices | Tests | Neighbors | Extra |
|---|---|---|---|---|
| `implement` | `task.evidenceRefs` completos (texto); si vacío, refs cuyo `file ∈ task.files` | `research.tests` que cubren `task.requirements` | dependents+dependencies directos de `task.targetSymbols` (solo `signature`) | `task`, `acceptance` |
| `judge-a` | refs de la tarea (o de los archivos del diff) con `kind ∈ {contract, route, config, behavior}` | — | dependents de símbolos tocados | `diff` |
| `judge-b` | refs `kind ∈ {test, behavior}` | todos los `research.tests` relevantes al diff | dependents | `diff` |
| `fix` | por cada finding: slice del archivo citado `line ± 20` (leído en caliente, no del store) | tests que fallaron si se conocen | — | `findings`, `diff` |
| `plan` | solo `claim + file + range + signature` (sin texto) salvo `kind: contract` | `research.tests` | — | — |

Presupuesto: orden de prioridad `task slices > contracts > tests > neighbors`; al superar `budgetChars`, se recorta desde el final y se registra el id en `truncated[]`. Nunca se recorta a mitad de un slice.

#### H. Tools nuevas (`src/plugin.ts`)

| Tool | Args | Salida | Quién la usa |
|---|---|---|---|
| `mr_evidence_add` | `file, startLine, endLine, kind, claim, source?, supports?, symbol?` | `EvidenceRef` como JSON compacto (`id, file, range, kind, supports`) | `mr-explore`, `mr-plan` |
| `mr_evidence_list` | `kind?, supports?, file?` | tabla compacta `id · kind · file:range · supports · claim` | todos |
| `mr_context_hydrate` | `role, taskId?, budgetChars?` | `serializeBundle(bundle)` | implementadores, jueces, fix, plan |

El `ticketId` se toma del `FlowState` activo (`flowTicketId(state)`); si no hay flow, de `research.json`; si tampoco, error claro.

#### I. Integración en el flujo

1. `mr_sdd_get kind=next-task` añade `bundle: serializeBundle(await hydrate(implement, taskId))` al JSON devuelto. El implementador recibe todo en una llamada; `mr_context_hydrate` queda para re-hidratar o para otros roles.
2. `mr_flow_judge`: antes de construir el prompt, hidratar `judge-a`/`judge-b` y pasar el bundle a `buildJudgePrompt(diff, judge, bundle?)` (nuevo parámetro opcional; se serializa tras el diff bajo `## Context bundle`).
3. `mr_flow_fix`: hidratar `fix` con `findings` y pasar a `buildFixPrompt(verdict, diff, bundle?)`.
4. `mr_sdd_submit kind=research`: acepta v1 o v2; migra; recalcula `coverage.fresh` con `isGraphFresh`; persiste v2.
5. `mr_sdd_submit kind=tasks`: valida con store + freshness; persiste v2.
6. Prompts (`src/core/config.ts`, inglés):
   - `mr-explore`: "Use context levels in order: `map` → `skeleton` → `deps/impact` → `slice` → `tests`. Register every claim that supports a requirement with `mr_evidence_add` (use the `range` and `symbol` returned by `slice`). Submit `ResearchCapsule` v2 with `evidenceRefs`, `coverage`, `contracts`, `tests`."
   - `mr-plan`: "Plan only over `evidenceRefs`. Each task lists `targetSymbols`, `evidenceRefs`, `invariants`. Never paste code into the plan."
   - `mr-general`/`mr-sdd-apply`: "The `bundle` in your briefing is your context. Read a file only if the bundle marks it `truncated` or `stale`."
   - `mr-judge-a/b`: "Use the context bundle to verify contracts/tests; findings still must cite a visible diff line."
   - `orchestrator`: paso 3 y 5 actualizados para mencionar evidencia e hidratación (una línea cada uno).

### 1.5 Pasos de implementación (orden obligatorio)

| Paso | Título | Archivos | Hecho cuando |
|---|---|---|---|
| A1 | `AtlasGraph` v2: `files[]`, `coverage`, `indexerVersion`; `loadAtlasGraph` rechaza v1; `isGraphFresh`, `computeFileHashes` con `atlas-stat.json` | `src/core/atlas.ts`, `tests/atlas.test.ts` | Grafo persistido tiene `files`+`coverage`; test: archivo ya `M` en git que cambia de nuevo → `isGraphFresh=false` |
| A2 | `getOrIndexGraph` usa hashes (no `gitStamp`); `renderCoverageReceipt`; recibo en `mr_atlas_index/query/skeleton` | `src/plugin.ts`, `src/core/render.ts`, `tests/render.test.ts`, `tests/plugin.test.ts` | Toda salida Atlas termina con `--- coverage ---` |
| A3 | Niveles: `AtlasNode.endLine`, `extractSlice`, `findTestsFor`, `renderWorkspaceMap`; acciones `map`, `slice`, `tests` en `mr_atlas_query` | `src/core/atlas.ts`, `src/core/render.ts`, `src/plugin.ts`, `tests/atlas.test.ts` | `slice` devuelve texto exacto + `range` + `fileHash`; `map` ≤ 40 líneas; `tests` encuentra `*.test.ts` que importa el módulo |
| A4 | `evidence-store.ts` completo (add/list/readSlice/checkFreshness con relocate) | `src/core/evidence-store.ts`, `tests/evidence-store.test.ts` | Test: add → list → editar archivo → `stale`; mover símbolo → `relocated`; misma slice dos veces → una ref con `supports` fusionados |
| A5 | Tools `mr_evidence_add`, `mr_evidence_list` | `src/plugin.ts`, `tests/plugin.test.ts` | Tools registradas; error claro sin ticket; ref devuelta compacta |
| A6 | `ResearchCapsule` v2 + migración v1→v2 + `validateSddArtifacts(store, freshness)` + `renderResearchCapsule` v2 | `src/core/sdd-schema.ts`, `src/core/render.ts`, `src/plugin.ts`, `tests/sdd-schema.test.ts`, `tests/render.test.ts` | v1 enviado → persistido v2 con refs creadas; requisito sin `supports` → error en Full, warning en Lite |
| A7 | `SddTask` v2 (`targetSymbols`, `evidenceRefs`, `invariants`) + migración + `renderTaskGraph` muestra invariantes | `src/core/sdd-schema.ts`, `src/core/render.ts`, `tests/sdd-schema.test.ts` | Tasks v1 migran; tarea `modify` sin refs → warning/error según modo |
| A8 | `context-hydrator.ts` + `mr_context_hydrate` + presupuestos | `src/core/context-hydrator.ts`, `src/plugin.ts`, `tests/context-hydrator.test.ts` | `hydrate(implement, T1)` incluye exactamente las refs de T1; `truncated[]` correcto al bajar `budgetChars`; `fix` lee `line ± 20` en caliente |
| A9 | Integración: `next-task` con `bundle`; `buildJudgePrompt/buildFixPrompt` con bundle; `mr_flow_judge`/`mr_flow_fix` hidratan | `src/plugin.ts`, `src/core/judgment.ts`, `tests/judgment.test.ts`, `tests/plugin.test.ts` | Prompts de jueces y fix contienen `## Context bundle`; `next-task` incluye `bundle` |
| A10 | Prompts v2 en inglés (`mr-explore`, `mr-plan`, `mr-general`, `mr-sdd-apply`, jueces, orchestrator) + tests de invariantes de prompt | `src/core/config.ts`, `tests/config.test.ts` | Tests existentes de prompts pasan; nuevos asserts: `mr-explore` menciona `mr_evidence_add`; `mr-plan` menciona `evidenceRefs` |
| A11 | Documentación y changelog | `docs/USAGE.md`, `CHANGELOG.md`, `README.md` (sección Atlas) | Se documentan niveles, evidencia, hidratación y recibo de cobertura |

### 1.6 Criterios de aceptación globales (A)

- [ ] Ninguna salida de Atlas carece de recibo de cobertura.
- [ ] Editar un archivo ya modificado en git invalida la caché en la siguiente consulta.
- [ ] Un `ResearchCapsule` v1 enviado por un agente antiguo se acepta y se persiste como v2.
- [ ] Con flow Full, un requisito sin evidencia bloquea `mr_sdd_submit kind=tasks`.
- [ ] `mr_sdd_get kind=next-task` entrega un `bundle` cuyo tamaño respeta `DEFAULT_BUDGET_CHARS.implement`.
- [ ] Jueces y fix reciben bundle; los tests de `judgment.ts` existentes siguen pasando.
- [ ] `bun run check` verde; `tests/plugin.test.ts` sigue aislado (usa `paths` temporales, como hoy).

### 1.7 Riesgos y mitigaciones (A)

| Riesgo | Mitigación |
|---|---|
| Reindexado completo lento en repos grandes | Atajo `mtime+size` antes de hashear; `SOURCE_MAX_BYTES = 1_500_000` por archivo; incremental queda como mejora futura |
| Agentes antiguos enviando v1 | Union de esquemas en entrada + migración; nunca romper la entrada |
| Bundle demasiado grande | Presupuesto por rol + `truncated[]` visible; el implementador puede pedir `mr_atlas_query action=slice` para lo recortado |
| Relocalización errónea de evidencia | Relocalizar solo por `symbol` en el **mismo archivo**; en duda → `stale` |

---

## 2. Desarrollo B — Reglas por repositorio (`mr atlas init`)

### 2.1 Objetivo

Que un desarrollador ejecute `mr atlas init` y, **con un Enter**, obtenga reglas base compactas por repositorio (`AGENTS.md`) que cualquier editor o agente pueda leer con poco coste de tokens, y que `/flow` y `/blueprint` consuman automáticamente. Opcionalmente, capturar el "sabor" del desarrollador (estilo de trabajo que quiere de los agentes) con **una sola pantalla** de preferencias.

### 2.2 Principios

1. **Es una subfuncionalidad del init, no del core.** `AtlasIndexer` no cambia; el onboarding consume el grafo y los archivos de configuración.
2. **Hechos primero, preguntas después.** Todo se detecta de forma determinista con `confidence` y `evidence[]`; solo se pregunta cuando la confianza es media y la decisión tiene impacto.
3. **Máximo 3 decisiones.** Agrupadas por tema y globales al workspace cuando sea posible. Nunca una pregunta por repositorio si se puede deducir.
4. **Ruta feliz = 1 Enter.** Sin TTY → acepta la propuesta por defecto, nunca pregunta.
5. **Presente ≠ objetivo.** Las reglas describen convenciones **actuales**. El modo aspiracional ("migrar a hexagonal") está fuera de alcance; solo se captura el estilo de trabajo del desarrollador, no arquitecturas deseadas.
6. **Nunca sobrescribir sin diff.** Si ya existe `AGENTS.md` o `rules.json`, mostrar diferencias y confirmar.
7. **Best-effort.** Cualquier fallo en el perfilado no impide terminar `atlas init`.

### 2.3 Experiencia de usuario (TUI, español)

```text
$ mr atlas init

◇ Atlas inicializado (grafo: 1.284 nodos · 4 repositorios)

◇ Propuesta de reglas para agentes

  web      React SPA · feature-oriented · kebab-case · CSS Modules · Vitest (colocados)
  api      Symfony API · layered · PSR-4 · PHPUnit (tests/)
  auth     Node service · layered · camelCase · Jest (__tests__/)
  sdk      TypeScript library · barrels · Vitest

  Estilo de trabajo sugerido: cambios mínimos · tipado estricto · tests para cambios de comportamiento

  2 decisiones pendientes (convenciones mixtas detectadas)

◆ ¿Qué quieres hacer?
│ ● Aceptar propuesta (Enter)
│ ○ Revisar decisiones (2)
│ ○ Ajustar estilo de trabajo
│ ○ Ver diagnóstico
│ ○ Saltar por ahora
```

Si elige "Revisar decisiones":

```text
◆ web: se detectaron barrels (index.ts) en 6 de 14 features
│ ● Mantener barrels solo donde ya existen (recomendado)
│ ○ Usar barrels en todas las features
│ ○ No usar barrels
```

Si elige "Ajustar estilo de trabajo" (una única pantalla multi-select, preseleccionada con lo detectado):

```text
◆ ¿Cómo quieres que trabajen los agentes en este workspace?
│ ◼ Cambios mínimos y reversibles
│ ◼ Tipado estricto, sin any
│ ◼ Tests junto a cada cambio de comportamiento
│ ◻ Refactors locales permitidos si están justificados
│ ◻ Evitar nuevas dependencias sin justificación
│ ◻ Código explícito antes que abstracciones
│ ◻ Preguntar antes de cambios arquitectónicos
```

Al aceptar:

```text
◇ Reglas guardadas
  .aicontext/atlas/profile.json
  .aicontext/atlas/rules.json
  .aicontext/atlas/AGENTS.md        ← añadido a instructions de OpenCode
  Para escribir AGENTS.md dentro de cada repo: mr atlas rules --write-repo-agents
```

### 2.4 Contratos

#### A. Descubrimiento de repositorios (`src/core/rules/discover.ts`)

```ts
export interface DiscoveredRepository { readonly name: string; readonly root: string /* relative */; readonly markers: readonly string[] /* package.json, composer.json, pom.xml, .git */ }
export async function discoverRepositories(workspaceRoot: string): Promise<readonly DiscoveredRepository[]>;
```

Reglas: si `repos/*` existe, cada subdirectorio con marcador es un repo (aceptando el layout `repos/<name>/code`); si no, el propio `workspaceRoot` es el único repo (`name = basename`). Ignorar `node_modules`, `vendor`, `dist`, `build`, `.git`.

#### B. `RepositoryProfile` (`src/core/rules/profiler.ts`)

```ts
export const FactSchema = z.strictObject({
  id: z.string().min(1),                        // "naming.files", "styles.approach", ...
  statement: z.string().min(1).max(200),        // English
  value: z.string().min(1).max(100),            // machine value: "kebab-case", "css-modules", ...
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string().max(200)).max(5), // "src/features/user/user-card.tsx", "package.json#scripts.test"
});
export type Fact = z.infer<typeof FactSchema>;

export const RepositoryProfileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  repo: z.string().min(1),
  root: z.string().min(1),
  generatedFromIndex: z.string().length(64),    // sha256 over sorted file contentHashes of this repo
  kind: z.enum(["spa", "mfe-host", "mfe-remote", "api", "bff", "service", "monorepo", "design-system", "library", "cli", "unknown"]),
  stack: z.strictObject({
    languages: z.array(z.string()), frameworks: z.array(z.string()),
    packageManager: z.string().optional(), runtime: z.string().optional(),
  }),
  layout: z.strictObject({ style: z.enum(["feature", "layered", "hexagonal", "ddd", "atomic", "flat", "mixed"]), roots: z.array(z.string()) }),
  commands: z.strictObject({ install: z.string().optional(), test: z.string().optional(), lint: z.string().optional(), typecheck: z.string().optional(), build: z.string().optional(), format: z.string().optional() }),
  criticalAreas: z.array(z.string()),           // "auth", "payment", "persistence", "public-api", "federation-contract"
  facts: z.array(FactSchema),                   // confidence >= 0.85
  inferences: z.array(FactSchema),              // 0.55 <= confidence < 0.85
  gaps: z.array(z.string().max(200)),           // could not determine
});
export type RepositoryProfile = z.infer<typeof RepositoryProfileSchema>;

export interface ProfilerInput { readonly repo: DiscoveredRepository; readonly workspaceRoot: string; readonly graph: AtlasGraph; readonly files: readonly string[] /* repo-relative, from graph.files */; readonly readText: (relPath: string) => Promise<string | undefined> }
export async function profileRepository(input: ProfilerInput): Promise<RepositoryProfile>;
```

Detectores (`src/core/rules/detectors/*.ts`, cada uno `detect(ctx): Promise<readonly Fact[]>`, puros salvo `readText`):

| Detector | Qué mide | Cómo (determinista) | Ids de fact |
|---|---|---|---|
| `stack` | lenguajes, frameworks, package manager, comandos | `package.json` (deps + scripts), `composer.json`, `pom.xml`, lockfiles, `tsconfig`, `vite/webpack/next/astro.config.*` | `stack.*`, `commands.*` |
| `kind` | tipo de repo | frameworks + presencia de `exposes/remotes` (federation), `bin` en package.json, `src/pages|app` | `repo.kind` |
| `layout` | estilo de carpetas | ratio de archivos bajo `features/|modules/` vs `components/|services/|controllers/` vs `domain/|application/|infrastructure/` | `layout.style`, `layout.roots` |
| `naming` | casing de archivos por categoría | contar kebab/camel/Pascal/snake por tipo (componentes `.tsx`, hooks `use*`, tests, clases PHP) | `naming.files`, `naming.components`, `naming.hooks`, `naming.tests` |
| `modules` | barrels, alias, default vs named | `index.ts` reexportando (aristas `export`), `tsconfig.paths`, ratio `export default` | `modules.barrels`, `modules.aliases`, `modules.exports` |
| `styles` | enfoque CSS | `*.module.css/scss`, `tailwind.config`, `styled-components/@emotion` en deps, clases BEM (`block__el--mod`) | `styles.approach`, `styles.tokens` |
| `testing` | framework, ubicación, patrón de nombre | deps (`vitest/jest/phpunit/junit`), rutas `__tests__/`, `tests/`, colocados; `*.test.*` vs `*.spec.*` | `testing.framework`, `testing.location`, `testing.pattern` |
| `quality` | formateo/lint/estrictez | `prettier`, `eslint`, `php-cs-fixer`, `phpstan.neon` nivel, `tsconfig.strict`, `noUncheckedIndexedAccess` | `quality.*` |
| `boundaries` | qué capas importan a cuáles | aristas `import` agrupadas por `layout.roots`; áreas críticas por nombre de carpeta (`auth`, `payment`, `security`, `persistence`, `migrations`) | `boundaries.*`, `critical.*` |

Confianza: cada detector calcula `confidence = dominant / total` cuando aplica; con menos de 5 muestras se limita a 0.6 como máximo.

#### C. `RepositoryRules` y decisiones (`src/core/rules/generator.ts`)

```ts
export const RuleSchema = z.strictObject({
  id: z.string().min(1),                        // same id space as facts: "naming.files"
  value: z.string().min(1).max(100),
  statement: z.string().min(1).max(200),        // English, imperative: "Name files in kebab-case."
  kind: z.enum(["fact", "inferred", "confirmed"]),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string().max(200)).max(5),
  appliesTo: z.array(z.string()).default([]),   // globs relative to repo root; empty = whole repo
  severity: z.enum(["info", "warn", "block"]).default("warn"),
});
export type Rule = z.infer<typeof RuleSchema>;

export const DeveloperPreferenceSchema = z.enum([
  "minimal-reversible-changes", "strict-typing", "tests-with-behavior-changes", "allow-justified-local-refactors",
  "no-new-dependencies-without-reason", "explicit-over-abstract", "ask-before-architecture-changes",
]);

export const RepositoryRulesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  repo: z.string().min(1),
  mode: z.literal("baseline"),
  generatedFromIndex: z.string().length(64),
  confirmedAt: z.iso.datetime().optional(),
  rules: z.array(RuleSchema),
});
export const WorkspaceRulesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  generatedAt: z.iso.datetime(),
  preferences: z.array(DeveloperPreferenceSchema),
  repositories: z.array(RepositoryRulesSchema),
});
export type WorkspaceRules = z.infer<typeof WorkspaceRulesSchema>;

export const DecisionSchema = z.strictObject({
  id: z.string().regex(/^D\d+$/u),
  ruleId: z.string().min(1),
  repos: z.array(z.string()).min(1),            // grouped across repos when the same ambiguity repeats
  question: z.string().min(1).max(200),          // Spanish (shown to the user)
  options: z.array(z.strictObject({ value: z.string(), label: z.string().max(80), recommended: z.boolean().default(false) })).min(2).max(4),
});
export type Decision = z.infer<typeof DecisionSchema>;

export interface Proposal { readonly rules: WorkspaceRules; readonly decisions: readonly Decision[]; readonly preferences: readonly DeveloperPreference[] }

export function buildProposal(profiles: readonly RepositoryProfile[]): Proposal;
export function applyDecisions(proposal: Proposal, answers: ReadonlyMap<string, string>, preferences: readonly DeveloperPreference[]): WorkspaceRules;
export function rulesDigest(rules: WorkspaceRules, repo: string, files?: readonly string[]): readonly RuleDigest[];  // for hydration
export interface RuleDigest { readonly id: string; readonly statement: string; readonly severity: Rule["severity"] }
```

Clasificación en `buildProposal`:
- `fact` (≥ 0.85) → regla `kind: "fact"`, sin preguntar.
- `inferred` (0.55–0.85) con `id` en el conjunto de impacto `{ naming.files, modules.barrels, styles.approach, testing.location, layout.style }` → genera una `Decision`; el mismo `ruleId` con la misma ambigüedad en varios repos se agrupa en **una** decisión. Máximo 3 decisiones; si hay más, se conservan las 3 de mayor impacto (orden del conjunto anterior) y el resto queda `inferred` con opción recomendada aplicada.
- `inferred` fuera del conjunto de impacto → regla `kind: "inferred"` con la opción dominante.
- `< 0.55` → `gaps`, no se genera regla.
- Preferencias por defecto propuestas: `minimal-reversible-changes`, `strict-typing` (si `quality.strict`), `tests-with-behavior-changes` (si hay framework de tests).

#### D. Proyección `AGENTS.md` (`src/core/rules/render.ts`)

```ts
export function renderWorkspaceAgentsMarkdown(rules: WorkspaceRules, profiles: readonly RepositoryProfile[]): string; // root file
export function renderRepositoryAgentsMarkdown(rules: RepositoryRules, profile: RepositoryProfile, preferences: readonly DeveloperPreference[]): string;
export function renderRulesDiff(previous: string | undefined, next: string): string;  // unified-ish, for the TUI
```

Plantilla raíz (inglés, objetivo ≤ 400 tokens):

```md
# Workspace Rules

Generated by mr-orchestrator (`mr atlas init`). Source of truth: `.aicontext/atlas/rules.json`.

## How agents should work here
- Make the smallest coherent, reversible change.
- Keep strict typing; never introduce `any`.
- Add or update tests with every behavior change.

## Repositories
| Repo | Role | Stack | Rules |
|---|---|---|---|
| web | React SPA (B2B client) | React 18, Vite, TS | `.aicontext/atlas/repos/web/AGENTS.md` |
| api | Symfony API | PHP 8.4, Symfony 7 | `.aicontext/atlas/repos/api/AGENTS.md` |
```

Plantilla por repositorio (inglés, objetivo ≤ 600 tokens; secciones vacías se omiten):

```md
# web — Agent Rules

## Role
React SPA. Feature-oriented layout under `src/features/*`.

## Commands
- test: `pnpm test` · lint: `pnpm lint` · typecheck: `pnpm typecheck` · build: `pnpm build`

## Conventions (current state)
- Files: kebab-case. Components: PascalCase. Hooks: `use*.ts`.
- Modules: barrels only where they already exist. Named exports.
- Styles: CSS Modules; no inline styles.
- Tests: Vitest, colocated `*.test.tsx`.

## Boundaries
- `features/*` may import `shared/*`; never the reverse.
- Critical areas (review carefully): `src/features/auth/**`.

## Do not
- Edit generated files under `src/generated/**`.
- Add dependencies without stating why.

## Unknown
- State management approach not detected.
```

Reglas de render: frases imperativas cortas, sin ejemplos de código, sin listas de dependencias completas, sin explicaciones. Cada regla `inferred` no confirmada se marca con `(inferred)`.

#### E. Persistencia (`src/core/rules/store.ts`)

```text
${profile.contextRoot}/atlas/
  profile.json                 # RepositoryProfile[] (WorkspaceProfilesFile { schemaVersion, generatedAt, profiles })
  rules.json                   # WorkspaceRules
  AGENTS.md                    # root projection
  repos/<repo>/AGENTS.md       # per-repo projection
```

```ts
export async function saveWorkspaceRules(profile: WorkspaceProfile, rules: WorkspaceRules, profiles: readonly RepositoryProfile[]): Promise<readonly string[]>; // paths written
export async function loadWorkspaceRules(profile: WorkspaceProfile): Promise<WorkspaceRules | undefined>;
export async function loadRepositoryProfiles(profile: WorkspaceProfile): Promise<readonly RepositoryProfile[] | undefined>;
export function isRulesStale(rules: WorkspaceRules, profiles: readonly RepositoryProfile[]): readonly string[]; // repos whose generatedFromIndex differs
```

- `--write-repo-agents`: además escribe `<repoRoot>/AGENTS.md` **solo** tras mostrar `renderRulesDiff` y confirmar (`approve`). Con `--yes` se confirma automáticamente. Nunca sobrescribe silenciosamente.
- `src/core/config.ts:601`: `instructions` añade `join(profile.contextRoot, "atlas", "AGENTS.md")` **solo si el archivo existe** (comprobación síncrona con `existsSync`, o pasar `existingFiles` calculado en `syncWorkspace`).

#### F. CLI (`src/cli.ts`) y TUI (`src/tui/atlas.ts`)

```text
mr atlas init  [--guided] [--no-rules] [--write-repo-agents] [--yes] [ID]
mr atlas rules [--guided] [--diff] [--write-repo-agents] [--yes] [ID]
mr atlas index [ID]
```

Comportamiento:
- `atlas index`: indexa con `AtlasIndexer` y guarda en caché (equivalente a `mr_atlas_index`). Imprime resumen + recibo de cobertura.
- `atlas init`: `atlas index` + (si no `--no-rules`) onboarding de reglas. Cualquier excepción del onboarding se captura, se muestra con `warning` y el comando termina con éxito.
- `atlas rules`: solo onboarding (usa la caché si está fresca; si no, reindexa). `--diff` muestra diferencias contra `rules.json` y `AGENTS.md` existentes sin escribir.
- Sin TTY: acepta la propuesta por defecto (opciones `recommended`) y preferencias por defecto; no pregunta nunca. Con `--guided` sin TTY → aviso y comportamiento por defecto.
- `--guided`: fuerza la pantalla de decisiones y de estilo aunque no haya ambigüedades.
- Resolución de workspace: `detectWorkspace(registry, process.cwd())` o `ID` explícito (mismo patrón que `commandSync`).
- `usage()` se actualiza con las tres subórdenes.
- `src/tui/atlas.ts` expone `runAtlasOnboarding(proposal, profiles, options): Promise<{ action: "accept" | "skip"; rules?: WorkspaceRules }>` usando `@clack/prompts` (`select`, `multiselect`, `note`, `isCancel`), con el flujo de la sección 2.3.

#### G. `mr doctor` (`src/core/doctor.ts`)

Nueva comprobación por workspace: si existe `rules.json` y `isRulesStale` devuelve repos → `✗ atlas rules: stale for web, api (run mr atlas rules)`; si no existe → `info` sugiriendo `mr atlas init`.

#### H. Integración con `/flow` y `/blueprint`

- `mr_context_hydrate` (Desarrollo A) rellena `bundle.rules` con `rulesDigest(rules, repoOf(task.files), task.files)`. Si A no está implementado aún, se crea `loadWorkspaceRules` y se expone la nueva tool `mr_rules_get({ repo?, files? })` que devuelve el digest compacto; los prompts la citan.
- `mr-plan` (prompt): "Read the rules digest for the touched repository and turn the relevant ones into task `invariants`."
- `mr-judge-a/b` (prompt): "Rules with `severity: block` are critical when violated; `warn` are warnings."
- `bp-architect` (prompt): "Read `mr_rules_get` before proposing structure; do not contradict confirmed rules."

### 2.5 Pasos de implementación (orden obligatorio)

| Paso | Título | Archivos | Hecho cuando |
|---|---|---|---|
| B1 | `discoverRepositories` + esquemas `Fact`, `RepositoryProfile` + detectores `stack`, `kind`, `layout`, `naming` | `src/core/rules/discover.ts`, `src/core/rules/profiler.ts`, `src/core/rules/detectors/{stack,kind,layout,naming}.ts`, `tests/rules-profiler.test.ts` | Fixture `repos/web` + `repos/api` descubiertos; fixture con 9/10 kebab → `naming.files` fact ≥ 0.85; 6/10 → inferred |
| B2 | Detectores `modules`, `styles`, `testing`, `quality`, `boundaries` | `src/core/rules/detectors/*.ts`, `tests/rules-profiler.test.ts` | Fixture con `*.module.css` → `styles.approach=css-modules`; `__tests__/` → `testing.location`; carpeta `auth/` → `critical.auth` |
| B3 | `buildProposal`, `applyDecisions`, `rulesDigest`, preferencias | `src/core/rules/generator.ts`, `tests/rules-generator.test.ts` | Barrels mixtos en 2 repos → **una** decisión agrupada; > 3 ambigüedades → exactamente 3 decisiones; respuestas → reglas `confirmed` |
| B4 | Render `AGENTS.md` raíz y por repo + `renderRulesDiff` | `src/core/rules/render.ts`, `tests/rules-render.test.ts` | Snapshot estable; raíz ≤ 1.600 chars por 4 repos; repo ≤ 2.400 chars; `(inferred)` marcado; secciones vacías omitidas |
| B5 | Persistencia `store.ts` + `instructions` condicional en `config.ts` + check en `doctor.ts` | `src/core/rules/store.ts`, `src/core/config.ts`, `src/core/doctor.ts`, `tests/config.test.ts`, `tests/rules-store.test.ts` | `instructions` incluye `atlas/AGENTS.md` solo si existe; `isRulesStale` detecta cambio de hash; doctor avisa |
| B6 | CLI `mr atlas init|rules|index` + TUI `src/tui/atlas.ts` | `src/cli.ts`, `src/tui/atlas.ts`, `tests/cli-atlas.test.ts` | `--no-rules` no crea `rules.json`; sin TTY acepta por defecto; fallo simulado del profiler → init termina OK con warning; `--write-repo-agents` sin `--yes` y sin TTY → no escribe en el repo |
| B7 | Integración: `bundle.rules` en hidratación (o `mr_rules_get` si A no existe) + prompts `mr-plan`, jueces, `bp-architect` | `src/core/context-hydrator.ts` o `src/plugin.ts`, `src/core/config.ts`, `tests/context-hydrator.test.ts` / `tests/plugin.test.ts`, `tests/config.test.ts` | Digest filtrado por repo y `appliesTo`; prompts mencionan reglas |
| B8 | Documentación y changelog | `docs/USAGE.md`, `README.md`, `CHANGELOG.md` | Se documenta `mr atlas init|rules|index`, ubicación de artefactos, flags y cómo editar reglas a mano |

### 2.6 Criterios de aceptación globales (B)

- [ ] `mr atlas init` en un workspace de fixture termina con un solo Enter y genera `profile.json`, `rules.json`, `AGENTS.md` y `repos/<repo>/AGENTS.md` bajo `.aicontext/atlas/`.
- [ ] Nunca se hacen más de 3 preguntas de decisión; la pantalla de estilo es una sola y opcional.
- [ ] Sin TTY no se pregunta nada y el resultado es el recomendado.
- [ ] `--no-rules` deja el init exactamente como antes de este desarrollo.
- [ ] Un fallo en cualquier detector no impide terminar el init.
- [ ] Nunca se sobrescribe un `AGENTS.md` de repositorio sin mostrar diff y confirmar.
- [ ] `AtlasIndexer` y las tools `mr_atlas_*` no cambian su API por este desarrollo.
- [ ] `bun run check` verde.

### 2.7 Riesgos y mitigaciones (B)

| Riesgo | Mitigación |
|---|---|
| Reglas incorrectas por muestras pequeñas | tope de confianza 0.6 con < 5 muestras → nunca `fact`; se marca `(inferred)` |
| Interrogatorio | tope duro de 3 decisiones + agrupación entre repos + ruta sin TTY |
| Ruido de tokens en `AGENTS.md` | presupuestos de caracteres verificados por test; sin ejemplos de código; secciones vacías omitidas |
| Contaminar el árbol git | por defecto se escribe en `.aicontext/atlas/`; repo root solo con flag + diff + confirmación |
| Acoplar el core | todo vive en `src/core/rules/*` y `src/tui/atlas.ts`; `atlas.ts` solo se lee |

---

## 3. Orden recomendado y dependencias entre desarrollos

```text
A1 → A2 → A3 → A4 → A5 → A6 → A7 → A8 → A9 → A10 → A11
B1 → B2 → B3 → B4 → B5 → B6 → B7 → B8
```

- A y B son **independientes** hasta B7. B1–B6 pueden implementarse antes o en paralelo a A.
- B7 tiene dos variantes: si A8 existe, integrar en `hydrateContext`; si no, exponer `mr_rules_get`. Implementar ambas si ambos desarrollos se completan.
- B1 y B5 dependen de `AtlasGraph.files[].contentHash` para `generatedFromIndex`. Si A1 no está hecho, calcular el hash en B1 con `sha256` sobre los contenidos de los archivos del repo (mismo resultado; se sustituye luego por el del grafo).

Protocolo por sesión one-shot:

```text
Implement development <A|B> from docs/plans/2026-09-atlas-evidence-and-rules.md, steps <X1..Xn> in order.
For each step: read the listed files fully, implement, add tests, run `bun run check`, commit `type(scope): summary`.
Constraints: section 0.2. Stop and record in section 4 if a decision is missing.
Return a compact receipt per step: files changed, tests added, verification tail.
```

---

## 4. Decisiones abiertas y valores por defecto {#open-decisions}

| # | Decisión | Valor por defecto adoptado | Revisar en |
|---|---|---|---|
| D1 | Indexado incremental en A1 | No; reindexado completo si algún hash cambia | Programa general F1-A |
| D2 | Relocalización de evidencia | Solo por `symbol` en el mismo archivo | A4 |
| D3 | Presupuestos por rol | plan 50k, implement 60k, judge 40k, fix 30k chars | A8 |
| D4 | Idioma de `AGENTS.md` | Inglés siempre (universal para agentes y editores); TUI en español | B4 |
| D5 | Ubicación por defecto de `AGENTS.md` | `.aicontext/atlas/` + `instructions`; repo root solo con `--write-repo-agents` | B5 |
| D6 | Conjunto de decisiones con impacto | `naming.files`, `modules.barrels`, `styles.approach`, `testing.location`, `layout.style` | B3 |
| D7 | Preferencias de desarrollador | 7 valores fijos (enum); sin texto libre | B3 |
| D8 | Modo aspiracional (arquitectura objetivo) | Fuera de alcance; solo estado actual + estilo de trabajo | Futuro |

---

## 5. Definición de "desarrollo terminado"

**A:** A1–A11 con commits individuales, `bun run check` verde, criterios de 1.6 marcados, `docs/USAGE.md` y `CHANGELOG.md` actualizados.

**B:** B1–B8 con commits individuales, `bun run check` verde, criterios de 2.6 marcados, `docs/USAGE.md` y `CHANGELOG.md` actualizados, y una ejecución manual de `mr atlas init` sobre un workspace real documentada en el PR (captura de la pantalla de propuesta y ruta de los artefactos).
