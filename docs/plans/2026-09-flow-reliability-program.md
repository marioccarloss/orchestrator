# Programa de fiabilidad `/flow` + `/blueprint` — Plan de implementación único

Estado: propuesto · Fecha: 2026-09-13 · Ejecutor previsto: GPT-5.6 Sol (high) · Repositorio: `mr-orchestrator`

Este documento es un plan de implementación completo, pensado para ejecutarse tarea a tarea con un modelo de razonamiento medio. Cada tarea es autocontenida: declara archivos, contratos, comandos de verificación y criterio de "hecho". El idioma de este documento es español (destinado a humanos); todos los identificadores, esquemas, prompts y artefactos internos que se crean son en inglés.

---

## 0. Resumen ejecutivo

### Problema
Las tareas ejecutadas con `/flow` fallan con frecuencia aunque se usen modelos frontier. La causa dominante no es el modelo sino el **contexto**: Atlas cubre solo TS/TSX/Java, su grafo solo tiene aristas de import, los skeletons eliminan la lógica ejecutable, la caché puede quedar obsoleta con el árbol sucio, y cada subagente redescubre el contexto porque el plan no transporta evidencia reutilizable.

### Objetivo
Que una tarea (con o sin ticket) se complete en **one shot** con la máxima probabilidad, con **bajo consumo de tokens** de entrada y salida, y que funcione con **cualquier modelo medianamente bueno**, porque el trabajo cognitivo pesado (descubrir, resolver, delimitar, verificar) lo hace código determinista.

### Principio rector
> El modelo no descubre ni deduce lo que el sistema puede calcular. Solo decide dentro de límites ya verificados.

### Resultado esperado al terminar
1. Atlas confiable: caché por hash de contenido, recibo de cobertura, PHP/JS/Astro/SCSS indexados, aliases resueltos.
2. `EvidenceStore` compartido: la evidencia se descubre una vez y se hidrata por rol y por tarea.
3. Planificación quirúrgica: cada tarea trae símbolos objetivo, evidencia, límites de edición, invariantes y verificación; gates deterministas bloquean el avance sin evidencia.
4. Capa semántica y extractores de framework: llamadas, herencia, DI Symfony, Doctrine, Module Federation, TanStack Query, Redux, Server Actions, Zod, tokens SCSS.
5. `mr atlas init` genera reglas base (`RepositoryRules` + `AGENTS.md`) por repositorio con un Enter.
6. Comunicación interna en inglés; salida humana en el idioma de la tarea; presupuestos de tokens por rol y por carril de riesgo.

### Fuera de alcance
- Modo "mejorar arquitectura sin romper tickets" (reglas aspiracionales).
- Cambiar el roster de modelos (ya aplicado en `models.json`).
- Reescribir la FSM de `/flow`; se extiende, no se reemplaza.

---

## 1. Diagnóstico verificado del estado actual

| Área | Hallazgo | Evidencia |
|---|---|---|
| Lenguajes | Solo `typescript`, `tsx`, `java` + JSON/YAML | `src/core/atlas.ts:81-87`, `137-142` |
| Aristas | Solo `import` y `export` (TS relativo, Java por paquete) | `src/core/atlas.ts:441-536`, `863-896` |
| Parseo | Parser nuevo por archivo, sin árbol previo ni caché por archivo | `src/core/atlas.ts:178-195` |
| Caché | `gitStamp = sha256(HEAD + git status --porcelain)`; un archivo ya `M` que vuelve a cambiar puede reutilizar grafo obsoleto | `src/core/atlas.ts:71-77`, `src/plugin.ts:154-168` |
| Cobertura | No se informa de archivos no soportados, errores de parseo ni imports sin resolver | `mr_atlas_query`, `src/plugin.ts:909-1011` |
| Skeleton | Elimina cuerpos, docblocks y decoradores; solo TS/Java | `src/core/atlas.ts:925-985` |
| Evidencia | `ResearchCapsule.evidence` = claim + file + line; sin hash, rango ni símbolo | `src/core/sdd-schema.ts:21-48` |
| Tareas | `SddTask` sin símbolos objetivo, límites de edición ni refs de evidencia | `src/core/sdd-schema.ts:160-169` |
| Next task | Entrega tarea + aceptación; el implementador no recibe cuerpos ni tests | `src/plugin.ts:1196-1245` |
| Jueces | Reciben diff + spec; sin cuerpo anterior/nuevo, consumidores ni tests | `src/core/judgment.ts:242-286` |
| Idioma | Prompts en inglés, descripciones de tools y render mezclados en español | `src/core/config.ts`, `src/plugin.ts`, `src/core/render.ts` |
| CLI Atlas | No existe `mr atlas`; solo la tool `mr_atlas_index` | `src/cli.ts:223-235` |
| WASM | Instalación copia solo 3 gramáticas | `src/core/config.ts:707-717` |

---

## 2. Arquitectura objetivo

```text
Task (with or without ticket)
  │
  ├─ language detection → FlowState.userLanguage
  ├─ synthetic ticket if none
  │
  ▼
Deterministic retrieval staircase (no LLM tokens)
  L0 workspace map      → RepositoryProfile
  L1 Tree-sitter        → skeletons, symbols, imports (TS/TSX/JS/JSX/PHP/Java/Astro/SCSS)
  L2 semantic           → references, calls, types (TS Language Service, PHPStan/Psalm)
  L3 framework          → Symfony DI/routes, Doctrine, Federation, Query, Redux, Server Actions, Zod, tokens
  L4 focused bodies     → exact symbol slices + direct callers/callees
  L5 auxiliary          → tests, config, git history
  │
  ▼
EvidenceStore (content-addressed, per workspace + ticket)
  │
  ▼
Explore → ResearchCapsule v2 (evidenceRefs, coverage, contracts, tests, unresolved)
Plan    → SpecCapsule + TaskGraph v2 (targetSymbols, editBoundaries, invariants, verification)
  │
  ▼
Deterministic gates (evidence, boundaries, freshness, verification receipts)
  │
  ▼
Role hydration (mr_context_hydrate) → minimal bundle per role/task
  │
  ▼
Implement → delta reindex → Judges (risk lane) → Fix → Finish
  │
  ▼
render.ts → user language output
```

Decisiones de diseño fijas:
- Toda comunicación entre agentes, artefactos persistidos y prompts: **inglés**.
- Toda salida al humano: idioma detectado de la tarea inicial (por defecto `es`).
- Nada de lo nuevo bloquea el funcionamiento actual si falla: degradación a comportamiento previo con aviso.
- Cada afirmación del sistema se etiqueta como `fact`, `inference` o `preference`.

---

## 3. Métricas de éxito (se miden en Fase 0 y al cierre)

| Métrica | Definición | Objetivo |
|---|---|---|
| `one_shot_rate` | % de journeys del corpus que terminan con verificación verde sin intervención humana | ≥ 85% Lite, ≥ 70% Full |
| `insufficient_evidence_precision` | % de paradas `INSUFFICIENT_EVIDENCE` que eran realmente necesarias | ≥ 90% |
| `stale_context_incidents` | Tareas donde se usó evidencia con hash distinto al archivo real | 0 |
| `tokens_per_accepted_delivery` | Tokens in+out totales / entregas aceptadas | −40% vs. baseline |
| `rediscovery_ratio` | Lecturas de archivo por roles downstream ya cubiertas por evidencia | ≤ 10% |
| `coverage_honesty` | Consultas Atlas que declaran archivos no soportados cuando existen | 100% |
| `language_compliance` | Artefactos internos en inglés / salidas humanas en idioma del usuario | 100% |

---

## 4. Fases y workstreams

Orden obligatorio: **F0 → F1 → F2 → F3 → F4 → F5 → F6**, con la excepción de F6-A (detección de idioma), que puede adelantarse tras F1 porque es barata y de bajo riesgo.

Cada fase declara: objetivo, cambios, nuevos contratos, criterios de aceptación y riesgos.

---

### Fase 0 — Línea base y banco de journeys

**Objetivo:** medir antes de cambiar.

**Cambios**
- Nuevo directorio `bench/` con:
  - `bench/corpus.json`: 15–25 journeys reales anonimizados, con `id`, `repoProfile` (inditex-mfe | prensa-ds | prensa-monorepo | prensa-api | openreferences-api | openreferences-next | openreferences-spa | openreferences-auth), `difficulty`, `hasTicket`, `taskText`, `language`, `expectedFiles`, `expectedVerify`.
  - `bench/README.md`: cómo ejecutar y cómo añadir journeys.
- Nuevo `src/core/bench.ts`: esquema `JourneyRecord`, `JourneyOutcome`, `BenchReport` y función `summarizeBench(outcomes)`.
- Nuevo `scripts/bench-report.ts`: agrega `flow-metrics` + `events.jsonl` de una ejecución y produce `BenchReport` (tokens por rol, éxito, causa de fallo).
- Extender `src/core/flow-metrics.ts` para etiquetar uso por `role` y `taskId` cuando esté disponible.

**Contratos**
```ts
// src/core/bench.ts
export const FailureCauseSchema = z.enum([
  "missing_context", "stale_context", "wrong_plan", "implementation", "verification", "judge_false_positive", "none",
]);
export const JourneyOutcomeSchema = z.strictObject({
  journeyId: z.string(), oneShot: z.boolean(), failureCause: FailureCauseSchema,
  tokens: z.object({ input: z.number(), output: z.number(), byRole: z.record(z.string(), z.object({ input: z.number(), output: z.number() })) }),
  insufficientEvidenceStops: z.number().int(), filesReadUnnecessarily: z.number().int(),
});
```

**Aceptación**
- `bun test tests/bench.test.ts` valida corpus y agregación.
- Existe un `BenchReport` baseline guardado en `bench/baselines/2026-09-baseline.json` (puede generarse manualmente con las journeys de los últimos fallos).

**Riesgos:** corpus sesgado → incluir al menos 3 journeys por ecosistema prioritario (Inditex, Prensa Ibérica, OpenReferences).

---

### Fase 1 — Atlas confiable

**Objetivo:** Atlas nunca entrega contexto obsoleto ni finge cobertura completa; cubre los lenguajes del portfolio.

#### F1-A Caché por contenido e indexado incremental
- `AtlasGraph.schemaVersion: 2` con:
  ```ts
  interface AtlasFileRecord { path: string; contentHash: string; language: string; parseStatus: "ok" | "partial" | "error" | "unsupported"; nodeIds: string[]; errorRanges?: [number, number][] }
  interface AtlasCoverage { supportedLanguages: string[]; unsupportedFiles: string[]; parseErrors: { path: string; line: number }[]; unresolvedImports: { from: string; specifier: string }[]; indexerVersion: string }
  interface AtlasGraph { ...; files: AtlasFileRecord[]; coverage: AtlasCoverage; gitStamp?: string }
  ```
- `AtlasIndexer.indexWorkspace(root, { previous?: AtlasGraph })`: reutiliza nodos/aristas de archivos cuyo `contentHash` no cambió; reparsea solo el delta; recalcula aristas de archivos afectados (los que importan a un archivo cambiado o cambiaron).
- `getOrIndexGraph()` en `src/plugin.ts`: en lugar de comparar `gitStamp`, calcula hashes de archivos candidatos (`stat` mtime+size → hash solo si difiere) y reindexa el delta. Mantener `gitStamp` como metadato informativo.
- Migración: si el grafo persistido es `schemaVersion: 1`, reindexar completo una vez.

#### F1-B Recibo de cobertura en todas las consultas
- `mr_atlas_query`, `mr_atlas_skeleton` e `mr_atlas_index` añaden bloque `coverage` al final (`fresh`, `unsupportedFiles` relevantes al resultado, `unresolvedImports` del nodo consultado, `parseStatus`).
- Nueva función pura `renderCoverageReceipt(coverage, scope)` en `src/core/render.ts`.

#### F1-C Nuevas gramáticas Tree-sitter
- Dependencias: `tree-sitter-php`, `tree-sitter-javascript`, `tree-sitter-css`, `tree-sitter-scss` (o `tree-sitter-css` con modo scss si no hay wasm estable), `tree-sitter-astro` (si no hay wasm fiable: extraer frontmatter `---` como TS y template como HTML light con regex para `import`/componentes; marcar `parseStatus: "partial"`).
- `WASM_SOURCES` y `langForFile` ampliados: `.php`, `.js/.jsx/.mjs/.cjs`, `.css/.scss`, `.astro`.
- `src/core/config.ts:707-717` (`syncWorkspace`): copiar todos los wasm nuevos. `install.sh`/`install.ts`: sin cambios si los paquetes están en `dependencies`.
- Extractores por lenguaje:
  - `extractPhp`: `namespace_definition`, `use_declaration` (imports), `class_declaration`, `interface_declaration`, `trait_declaration`, `enum_declaration`, `method_declaration`, `function_definition`, atributos `#[...]`, `extends`/`implements` → aristas `extends`/`implements`.
  - `extractJavaScript`: reutiliza la lógica TS con nodos JS; `require()` como import.
  - `extractStyles`: `@use`/`@import`/`@forward`, variables `$token`, mixins, selectores raíz (BEM block detection).
  - `extractAstro`: frontmatter TS + imports de componentes.
- `DEFAULT_INCLUDE_PATTERNS` ampliado: `src/**/*.{js,jsx,mjs,cjs,php,scss,css,astro}`, `app/**`, `packages/**/src/**`, `apps/**/src/**`, `config/**/*.{yaml,yml,php}` (Symfony), `composer.json`, `pnpm-workspace.yaml`, `vite.config.*`, `webpack.config.*`, `tsconfig*.json`, `astro.config.*`, `app.json`/`app.config.*` (Expo).
- `EXCLUDED_DIRS` añade `vendor`, `var`, `.astro`, `.expo`, `storybook-static`, `public/build`.

#### F1-D Resolución de aliases y workspaces
- Nuevo `src/core/atlas-resolve.ts`:
  - `tsconfig` `paths`/`baseUrl` (incluye `extends`).
  - `pnpm-workspace.yaml` + `package.json#name` de cada paquete → import `@scope/pkg` a ruta local.
  - `composer.json#autoload.psr-4` → `App\Domain\X` a `src/Domain/X.php`.
  - Java: sin cambios.
- `resolveSpecifier` delega en el resolver; lo no resuelto va a `coverage.unresolvedImports`.

#### F1-E Skeleton v2
- Conserva docblocks/JSDoc/PHPDoc tags (`@param`, `@return`, `@throws`, `@deprecated`, `@template`) y descarta texto libre.
- Conserva decoradores/atributos (`@Component`, `#[Route]`, `#[ORM\Entity]`).
- Soporta PHP, JS, Astro y SCSS (para SCSS: `@use`, variables, mixins, bloques raíz).
- Nuevo argumento `depth: "signatures" | "signatures+calls"` (el segundo lista las llamadas externas por método, sin cuerpos) — base para hidratación adaptativa en F2.

**Aceptación F1**
- Test: modificar un archivo ya modificado en git → segunda consulta refleja el cambio.
- Test: repo PHP de ejemplo genera nodos clase/método y aristas `extends`/`implements`.
- Test: alias `@/x` y PSR-4 se resuelven; specifier externo aparece en `unresolvedImports`.
- Test: skeleton PHP conserva `#[Route]` y `@throws`.
- `mr_atlas_query` nunca devuelve resumen sin bloque `coverage`.

**Riesgos:** disponibilidad de wasm para Astro/SCSS → degradar a `partial` con regex; tiempo de indexación en repos de 5k archivos → incremental + límite por bytes (`CONFIG_MAX_BYTES` ya existe; añadir `SOURCE_MAX_BYTES = 1_500_000`).

---

### Fase 2 — EvidenceStore compartido e hidratación por rol

**Objetivo:** la evidencia se descubre una vez, se guarda por hash y se materializa justo antes de cada rol en el tamaño mínimo.

#### F2-A Módulo `src/core/evidence-store.ts`
```ts
export const EvidenceKindSchema = z.enum(["behavior", "contract", "type", "test", "config", "route", "style", "doc"]);
export const EvidenceSourceSchema = z.enum(["atlas", "lsp", "grep", "read", "memory", "ticket", "user"]);
export const EvidenceRefSchema = z.strictObject({
  id: z.string().regex(/^ev-[a-z0-9-]+$/u),
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
export interface EvidenceStore { schemaVersion: 1; ticketId: string; refs: EvidenceRef[]; }
```
- Persistencia: `${paths.generatedRoot}/${workspaceId}/evidence/${ticketId}/store.json` y slices en `.../slices/${sliceHash}.txt` (texto exacto del rango en el momento de captura).
- API: `addEvidence(paths, ws, ticketId, input)` (lee el archivo, calcula hashes, guarda slice), `listEvidence`, `checkFreshness(ref)` (compara `fileHash` actual; si cambia, intenta relocalizar por `symbol` vía Atlas y marca `relocated` o `stale`), `pruneEvidence`.

#### F2-B Tools nuevas en `src/plugin.ts`
- `mr_evidence_add({ file, startLine, endLine, kind, claim, supports?, symbol? })` → devuelve `EvidenceRef` compacto. Solo `mr-explore` y `mr-plan` deben usarla.
- `mr_evidence_list({ ticketId?, kind?, supports? })`.
- `mr_context_hydrate({ role, taskId?, budgetChars? })` → `ContextBundle` (ver F2-D).

#### F2-C `ResearchCapsule` v2
- `schemaVersion: 2`, campos nuevos: `evidenceRefs: string[]` (ids del store, mínimo 1), `coverage: { fresh: boolean; unsupportedFiles: string[]; unresolvedImports: string[] }`, `contracts: { name: string; file: string; kind: "dto"|"interface"|"schema"|"route"|"event"|"federation" }[]`, `tests: { file: string; covers: string[] }[]`, `unknowns` (existente).
- `validateSddArtifacts`: todo `evidenceRefs` debe existir en el store y estar `fresh`; cada requisito de la spec debe tener ≥1 ref con `supports` incluyéndolo (error en Full, warning en Lite).
- Mantener aceptación de `schemaVersion: 1` con migración a 2 (refs creadas a partir de `evidence[]` legado con `range = [line, line]`).

#### F2-D `ContextBundle` e hidratación
```ts
export interface ContextBundle {
  schemaVersion: 1; role: "plan" | "implement" | "judge-a" | "judge-b" | "fix"; taskId?: string;
  task?: SddTask; acceptance?: Requirement[];
  slices: { ref: string; file: string; range: [number, number]; kind: EvidenceKind; text: string }[];
  contracts: ContractRef[]; tests: TestRef[]; rules: RuleDigest[]; // rules se llena en F5
  neighbors: { file: string; symbol: string; relation: "caller" | "callee" | "dependent" | "dependency" }[];
  coverage: AtlasCoverageSubset; budget: { requestedChars: number; usedChars: number; truncated: string[] };
}
```
- Política de selección por rol (determinista, en `src/core/context-hydrator.ts`):
  - `implement`: slices de `task.evidenceRefs` (cuerpos completos), tests que cubren sus requisitos, contratos referenciados, vecinos directos como `signatures+calls`.
  - `judge-a`: diff, cuerpo anterior (slice guardado) y nuevo (rango relocalizado), contratos, rutas/persistencia/seguridad, dependientes de los símbolos tocados.
  - `judge-b`: diff, tests existentes y nuevos, consumidores, compatibilidad, casos límite (slices de tests).
  - `fix`: hallazgos validados, slice de cada línea citada ± 20 líneas, tests que fallaron.
  - `plan`: resumen de refs (claim + firma) sin cuerpos completos salvo `kind: contract`.
- Presupuesto: `budgetChars` por defecto por rol (implement 60k, judge 40k, fix 30k, plan 50k); truncado por prioridad `target > contract > test > neighbor`, registrando `truncated[]`.

#### F2-E Integración en el flujo
- `mr_sdd_get kind=next-task` devuelve además `bundleHint: { role, taskId }`; el orquestador invoca al implementador pasando `mr_context_hydrate` como primera acción obligatoria (prompt de `mr-general`/`mr-sdd-apply` actualizado).
- `buildJudgePrompt` recibe `ContextBundle` y lo serializa compacto.
- `mr_flow_fix` hidrata `role: fix`.

**Aceptación F2**
- Test: `addEvidence` guarda slice y detecta stale al modificar el archivo.
- Test: `hydrate(implement, T1)` incluye exactamente los slices referenciados por T1 y respeta presupuesto.
- Test: `ResearchCapsule` v1 migra a v2 sin pérdida.
- Test: `validateSddArtifacts` marca error cuando un requisito no tiene evidencia en Full.

**Riesgos:** explosión de slices → deduplicación por `sliceHash`; tamaño de bundle → presupuestos y `truncated[]` visibles.

---

### Fase 3 — Planificación quirúrgica, gates y carriles de riesgo

**Objetivo:** que un modelo medio implemente sin interpretar intención; que el sistema bloquee cuando falte evidencia.

#### F3-A `TaskGraph` v2 (`src/core/sdd-schema.ts`)
```ts
export const EditBoundariesSchema = z.strictObject({
  allowedFiles: z.array(z.string().min(1)).min(1),
  forbiddenGlobs: z.array(z.string()).default([]),
});
export const ExpectedDiffSchema = z.strictObject({
  adds: z.array(z.string().max(200)).default([]),
  removes: z.array(z.string().max(200)).default([]),
  touchedTests: z.array(z.string()).default([]),
});
export const SddTaskSchema = z.strictObject({
  id, title, dependsOn, requirements, files, verify, doneWhen, status, // existentes
  targetSymbols: z.array(z.string().min(1)).default([]),
  evidenceRefs: z.array(z.string().regex(/^ev-/u)).min(1),
  changeIntent: z.string().min(1).max(300),
  editBoundaries: EditBoundariesSchema,
  invariants: z.array(z.string().max(300)).default([]),
  expectedDiff: ExpectedDiffSchema.default({}),
  verification: z.strictObject({ commands: z.array(z.string()).min(1), mustPass: z.boolean().default(true) }),
});
```
- `verify` legado se mapea a `verification.commands` en migración v1→v2.
- `TaskFileSchema` añade `evidenced: boolean` (derivado: existe ref en ese archivo) y, si `false`, exige `reason` ≥ 40 caracteres.

#### F3-B Gates deterministas
- Nuevo `src/core/gates.ts` con funciones puras que devuelven `GateResult { ok: boolean; violations: { code: string; message: string; severity: "block" | "warn" }[] }`:
  - `gatePlan(spec, tasks, research, store)`: requisitos sin evidencia; archivos sin evidencia sin razón; ciclos; `allowedFiles ⊇ files.path`.
  - `gateBeforeImplement(task, store, atlas)`: evidencia fresca (relocalizar o bloquear); `allowedFiles` existen o `action: create`.
  - `gateAfterImplement(task, gitDiffNames, verificationReceipt)`: `diff ⊆ allowedFiles`; ningún `forbiddenGlobs`; `verificationReceipt.commands` == `task.verification.commands` y todos `exitCode === 0` cuando `mustPass`.
  - `gateBeforeJudgment(atlasDelta)`: reindexado del delta hecho; `coverage.fresh`.
- Nueva tool `mr_sdd_verify({ taskId, results: { command, exitCode, durationMs, outputTail }[] })` → persiste `VerificationReceipt` en `.../sdd/verify/${taskId}.json`. `mr_sdd_task_status done` exige recibo válido y `gateAfterImplement.ok`.
- Modo de despliegue: variable `MR_GATES_MODE = warn | block` (por defecto `warn` durante F3; `block` al cerrar F3 tras pasar el corpus).

#### F3-C Carril de riesgo (`src/core/risk.ts`)
- `classifyRiskLane({ difficulty, evidence, atlasImpact, touchedAreas, rules? }) → "fast" | "standard" | "full" | "critical"`.
- Áreas críticas por defecto (en inglés, ampliables por reglas F5): `auth`, `security`, `payment`, `persistence`, `migration`, `federation-contract`, `public-api`, `cache-concurrency`.
- Reglas: `fast` si difficulty ≤ 3, ≤ 2 archivos, sin áreas críticas, impacto ≤ 3 nodos; `critical` si toca áreas críticas o impacto ≥ 15 nodos; `full` si difficulty ≥ 5; resto `standard`.
- Efecto en FSM (`flow-schema.ts`): `requiresJudgment(lane)` reemplaza a `requiresJudgment(difficulty)` manteniendo compatibilidad (`difficulty` sigue siendo entrada). `fast` omite jueces; `critical` fuerza jueces + revisión humana antes de `finish`.
- `mr_flow_status` muestra el carril y por qué.

#### F3-D Ticket sintético
- En `mr_flow_start`, si `ticketId` ausente: generar `LOCAL-YYYYMMDD-NN` y `TicketContent` desde `taskText` con `type` inferido y `source: "user"`. `ticket.ts` añade adaptador `local`.

#### F3-E Prompts de agentes (inglés, `src/core/config.ts`)
- `mr-explore`: obligación de registrar evidencia con `mr_evidence_add` para cada claim que respalde un requisito; declarar `coverage`.
- `mr-plan`: producir `TaskGraph` v2; prohibido incluir código en el plan; usar refs.
- `mr-general`/`mr-sdd-apply`: primera acción `mr_context_hydrate`; editar solo `allowedFiles`; ejecutar `verification.commands`; reportar mediante `mr_sdd_verify`; receipt compacto.
- `mr-judge-*`: consumir `ContextBundle`; hallazgos solo con línea de diff visible (ya existe) + referencia a slice cuando aplique.

**Aceptación F3**
- Test: plan con requisito sin evidencia → `gatePlan` bloquea en Full.
- Test: diff fuera de `allowedFiles` → `gateAfterImplement` bloquea y `task_status done` se rechaza.
- Test: `classifyRiskLane` devuelve `critical` para cambio en `src/Auth/*` aunque difficulty = 1.
- Test: `mr_flow_start` sin ticket crea `LOCAL-*` y el flujo avanza.
- Corpus F0 ejecutado en `MR_GATES_MODE=warn` sin falsos bloqueos > 10%.

---

### Fase 4 — Capa semántica y extractores de framework

**Objetivo:** ver lo que Tree-sitter no ve: referencias reales, tipos, DI, ORM, contratos federados.

#### F4-A Aristas nuevas en Atlas
- `AtlasEdge.type` amplía a: `import | export | calls | extends | implements | exposes | consumes | route | entity | event | query-key | style-use`.
- `getImpactAnalysis` pondera por tipo (`calls`/`implements`/`consumes` cuentan como impacto fuerte).

#### F4-B TypeScript Language Service (`src/core/semantic/typescript.ts`)
- Dependencia runtime `typescript` (mover de dev a `dependencies`).
- Servicio bajo demanda y acotado: `createProjectService(tsconfigPath)`, `findReferences(file, symbol)`, `getCallers(file, symbol)`, `getTypeAtSymbol`. Nunca analizar todo el repo: solo símbolos objetivo y vecinos a profundidad ≤ 2.
- Resultados se registran como aristas `calls` y como evidencia `kind: "type"` cuando el plan lo solicite.
- Cache por `program` con invalidación por hash de archivos tocados.

#### F4-C PHP semántico (`src/core/semantic/php.ts`)
- Si el workspace tiene `vendor/bin/phpstan` o `vendor/bin/psalm`: ejecutar con `--error-format=json` sobre archivos objetivo (timeout 60 s) para tipos y errores; parsear y adjuntar a `coverage`.
- Si hay `bin/console`: `debug:container --format=json` y `debug:router --format=json` (opt-in por regla `symfony.consoleIntrospection: true`; timeout 60 s) → aristas `route` y DI.
- Sin herramientas disponibles: Tree-sitter PHP + resolución PSR-4 y marca `semantic: "syntactic-only"` en coverage.

#### F4-D Extractores de framework (`src/core/extractors/*.ts`, cada uno función pura `extract(graph, files) → { nodes, edges, contracts }`)
| Extractor | Fuente | Salida |
|---|---|---|
| `module-federation.ts` | `vite.config.*`, `webpack.config.*` (`federation({ exposes, remotes, shared })`) | nodos `federation-contract`, aristas `exposes`/`consumes` host↔remote |
| `symfony.ts` | `config/services.yaml`, atributos `#[Route]`, `#[AsMessageHandler]`, `#[AsEventListener]` | aristas `route`, `event`, DI bindings |
| `doctrine.ts` | `#[ORM\Entity]`, `#[ODM\Document]`, repositorios, mappings XML/YAML | nodos `entity`, aristas `entity` |
| `cqrs.ts` | `*Command`, `*Query`, `*Handler`, buses | aristas `calls` handler↔command |
| `tanstack-query.ts` | `useQuery/useMutation({ queryKey })`, `invalidateQueries` | nodos `query-key`, aristas `query-key` |
| `redux.ts` | `createSlice`, `createAsyncThunk`, selectors | nodos `slice`, aristas `calls` |
| `nextjs.ts` | `"use server"`, `app/**/route.ts`, `page.tsx`, `layout.tsx` | nodos `route`/`server-action` |
| `zod.ts` | `z.object(...)` exportados | nodos `contract` (kind `schema`) |
| `scss.ts` | `@use`, `$token`, mixins, bloques BEM | aristas `style-use`, nodos `token` |
| `astro-expo.ts` | rutas Astro `src/pages/**`, Expo Router `app/**` | nodos `route` |

- Registro: `EXTRACTORS: readonly Extractor[]` en `src/core/extractors/index.ts`; `indexWorkspace` los ejecuta tras el segundo pase y mezcla resultados; fallo de un extractor → aviso en `coverage.extractorErrors[]`, no aborta.

#### F4-E Contratos cross-repo
- Cuando el workspace contiene varios repos (`repos/*`), `src/core/contracts.ts` empareja: endpoints Symfony (`#[Route('/api/x')]`) ↔ llamadas `fetch('/api/x')`/clientes TS; `exposes` ↔ `remotes`; schemas Zod compartidos por paquete. Produce aristas `consumes` inter-repo y `contracts[]` para `ResearchCapsule`.

**Aceptación F4**
- Test: fixture TS con `a()` llamando `b()` produce arista `calls` vía Language Service.
- Test: fixture PHP con `#[Route]` y `#[ORM\Entity]` produce nodos `route` y `entity`.
- Test: fixture Vite Federation host/remote produce `exposes`/`consumes`.
- Test: `getImpactAnalysis` sobre handler Symfony incluye su test y su consumidor TS.

**Riesgos:** latencia de Language Service en repos grandes → limitar a vecindario, cachear `program`; ausencia de phpstan → degradar declarado.

---

### Fase 5 — `mr atlas init`: reglas base por repositorio

**Objetivo:** capturar una vez las convenciones reales de cada repositorio y que `/flow` y `/blueprint` las consuman automáticamente.

#### F5-A `RepositoryProfiler` (`src/core/rules/profiler.ts`)
- Entrada: `AtlasGraph` v2 + archivos de configuración del repo. Salida `RepositoryProfile`:
```ts
interface RepositoryProfile {
  schemaVersion: 1; repo: string; root: string; generatedFromIndex: string;
  stack: { languages: string[]; frameworks: string[]; packageManager?: string; build?: string };
  kind: "spa" | "mfe-host" | "mfe-remote" | "api" | "bff" | "monorepo" | "design-system" | "library" | "unknown";
  layout: { style: "feature" | "layered" | "hexagonal" | "ddd" | "atomic" | "mixed"; roots: string[] };
  commands: { test?: string; lint?: string; typecheck?: string; build?: string; format?: string };
  criticalAreas: string[]; // auth, payment, persistence, federation-contract...
  facts: Fact[]; inferences: Inference[]; // { id, statement, confidence, evidence[] }
}
```
- Detectores (`src/core/rules/detectors/*.ts`, funciones puras con `confidence` y `evidence[]`):
  - `naming`: kebab/camel/Pascal/snake por tipo de archivo (componentes, hooks, servicios, tests, PHP clases).
  - `modules`: barrels (`index.ts` reexportando), aliases, named vs default exports, orden de imports (desde ESLint config).
  - `styles`: BEM, CSS Modules, Tailwind, Emotion, styled-components, MUI/Joy, Sewing DS; ubicación de tokens; prohibiciones detectadas (`!important`, inline styles).
  - `state-data`: TanStack Query, Redux Toolkit, Server Actions, Zod en fronteras, adapters.
  - `backend`: Aggregate/VO/DomainEvent, Command Bus, CQRS, Doctrine ORM/ODM, Redis cache-aside, state machines, JWT/PKCE/voters.
  - `testing`: framework, ubicación (`__tests__`, `tests/`, colocados), nomenclatura, MSW, Storybook, PHPUnit groups.
  - `quality`: Prettier/ESLint/PHP-CS-Fixer/PHPStan nivel, TS strict flags, `readonly`, discriminated unions.
  - `git`: convención de ramas/commits (desde `.github`, `commitlint`, historial reciente), PR template, checks.
  - `boundaries`: qué capas importan a cuáles (derivado del grafo), archivos generados/prohibidos.

#### F5-B `RulesGenerator` (`src/core/rules/generator.ts`)
- `RepositoryRules` (inglés, JSON):
```ts
interface Rule { id: string; value: string; kind: "fact" | "inferred" | "confirmed"; confidence: number; evidence: string[]; appliesTo?: string[] /* globs */ }
interface RepositoryRules { schemaVersion: 1; repo: string; mode: "baseline"; generatedFromIndex: string; confirmedAt?: string; rules: Rule[] }
```
- Clasificación: `fact` → sin preguntar; inferencia ≥ 0.85 → aceptar con Enter; 0.55–0.85 con impacto (naming, barrels, css, layout, testing) → agrupar en 1–3 decisiones; < 0.55 → registrar como `gap`, no como regla.
- Proyección `AGENTS.md` (idioma del usuario para texto; identificadores en inglés) generada por `renderAgentsMarkdown(profile, rules, language)` en `src/core/render.ts`.

#### F5-C CLI y TUI
- `src/cli.ts`: `mr atlas init [--guided] [--no-rules] [--write-repo-agents]`, `mr atlas rules [--diff] [--guided]`, `mr atlas index`.
- `src/tui/atlas.ts` (clack): pantalla única "N repositorios analizados → propuesta → [Enter] Aceptar · [E] Editar decisiones · [S] Saltar · [D] Diagnóstico".
- Persistencia por defecto fuera del árbol git: `${contextRoot}/atlas/profile.json`, `${contextRoot}/atlas/rules.json`, `${contextRoot}/atlas/AGENTS.md`; se añade a `instructions` del config generado (`src/core/config.ts:601`). Con `--write-repo-agents` se escribe `<repo>/AGENTS.md` solo tras mostrar diff y confirmar; nunca sobrescribe sin diff.
- Frescura: `rules.stale = generatedFromIndex !== currentIndexHash && stackChanged`; `mr doctor` avisa.
- Best-effort: cualquier fallo en profiler/generator no impide `atlas init`; se registra en salida.

#### F5-D Integración en `/flow` y `/blueprint`
- `mr_context_hydrate` incluye `rules: RuleDigest[]` filtradas por `appliesTo` contra los archivos de la tarea.
- `mr-plan` convierte reglas relevantes en `invariants` de tarea.
- `gates.ts` añade verificaciones deterministas cuando la regla lo permite: naming de archivos nuevos, barrels prohibidos, imports que cruzan capas prohibidas, `!important` si la regla lo veta.
- Jueces reciben `rules` y reportan violaciones como `warning` (o `critical` si la regla es `confirmed` y `severity: block`).
- `bp-architect` recibe `RepositoryProfile` + `rules` en su extracción inicial.

**Aceptación F5**
- Test: fixture con 90% kebab-case → regla `files.naming = kebab-case`, `kind: inferred`, `confidence ≥ 0.85`.
- Test: fixture mixto barrels → una única decisión agrupada.
- Test: `mr atlas init --no-rules` no crea `rules.json`; `atlas init` con fallo simulado del profiler termina OK.
- Test: `hydrate(implement)` incluye solo reglas con `appliesTo` que matchea `allowedFiles`.
- Test: AGENTS.md proyectado en `es` cuando `userLanguage = es`.

---

### Fase 6 — Idioma y economía de tokens

#### F6-A Idioma (puede adelantarse tras F1)
- `src/core/language.ts`: `detectLanguage(text) → "es" | "en" | "pt" | "ca" | "fr"` por stopwords y diacríticos; fallback `es`. Test con frases cortas.
- `FlowState` (todas las fases) añade `userLanguage?: string` (opcional para compatibilidad); `mr_flow_start` lo fija desde `taskText`/ticket; `bp` idem.
- `src/core/render.ts`: diccionario `MESSAGES[lang]` para plantillas (status, plan, verdict, notas de tarea, recibos de cobertura, AGENTS.md). Toda función de render recibe `lang`.
- `src/plugin.ts`: outputs dirigidos al usuario pasan por render con `lang`; descripciones de tools en inglés (las lee el modelo).
- `src/core/config.ts`: prompts 100% inglés; instrucción al `orchestrator`: "Explain to the user in `FlowState.userLanguage`; never in English unless the task arrived in English".
- Test de cumplimiento: grep sobre `src/core/config.ts` y capsules de tests: cero literales españoles en prompts/esquemas.

#### F6-B Presupuestos y router económico
- `src/core/budgets.ts`: presupuesto de chars por rol × carril (`fast`, `standard`, `full`, `critical`); `mr_context_hydrate` los aplica; `mr_flow_status` muestra uso vs. presupuesto.
- Carril `fast` reutiliza el mismo agente para plan breve + implementación (una sesión) cuando `lane = fast` y `hasTicket = false`, aprovechando caché de prefijo.
- Reindexado del delta tras cada tarea (F1-A) y bundle de jueces solo con delta + vecindario (F2-D).

**Aceptación F6**
- Corpus F0 re-ejecutado: `tokens_per_accepted_delivery` −40% vs. baseline; `language_compliance` 100%.

---

## 5. Lista de tareas SDD (orden de ejecución)

Convenciones: un commit por tarea (`feat(atlas): ...`, `feat(evidence): ...`, etc.), `bun run check` verde en cada una, tests nuevos en `tests/`. Los identificadores de código son en inglés.

| ID | Fase | Tarea | Depende de | Archivos principales | Verificar | Hecho cuando |
|---|---|---|---|---|---|---|
| T01 | F0 | Esquemas `bench.ts` + corpus inicial + README | — | `src/core/bench.ts`, `bench/corpus.json`, `bench/README.md`, `tests/bench.test.ts` | `bun run check` | Corpus válido con ≥ 15 journeys (≥ 3 por ecosistema) |
| T02 | F0 | `scripts/bench-report.ts` y etiquetado por rol en `flow-metrics.ts` | T01 | `scripts/bench-report.ts`, `src/core/flow-metrics.ts`, `tests/flow-metrics.test.ts` | `bun run check`, `bun scripts/bench-report.ts --help` | Genera `BenchReport` desde `events.jsonl` + métricas |
| T03 | F1-A | `AtlasGraph` v2: `files[]`, `coverage`, hashes por archivo; migración v1→v2 | — | `src/core/atlas.ts`, `tests/atlas.test.ts` | `bun run check` | Grafo persistido incluye `files` y `coverage`; carga v1 reindexa |
| T04 | F1-A | Indexado incremental por hash y `getOrIndexGraph` sin `gitStamp` como llave | T03 | `src/core/atlas.ts`, `src/plugin.ts`, `tests/atlas.test.ts`, `tests/plugin.test.ts` | `bun run check` | Test "modificar archivo ya sucio" refleja el cambio |
| T05 | F1-B | Recibo de cobertura en `mr_atlas_query/skeleton/index` + `renderCoverageReceipt` | T03 | `src/plugin.ts`, `src/core/render.ts`, `tests/render.test.ts` | `bun run check` | Todas las salidas Atlas incluyen bloque coverage |
| T06 | F1-C | Gramáticas PHP y JS: deps, `WASM_SOURCES`, `langForFile`, `extractPhp`, `extractJavaScript`, copia wasm en `syncWorkspace` | T03 | `package.json`, `src/core/atlas.ts`, `src/core/config.ts`, `tests/atlas.test.ts` | `bun install`, `bun run check` | Fixture PHP genera clases/métodos/`extends`/`implements`; JS genera funciones/imports |
| T07 | F1-C | Gramáticas CSS/SCSS y Astro (o modo `partial` con regex) + patrones de inclusión ampliados | T06 | `src/core/atlas.ts`, `src/core/config.ts`, `tests/atlas.test.ts` | `bun run check` | Fixture SCSS produce `@use`/tokens; Astro produce imports; `parseStatus` correcto |
| T08 | F1-D | `atlas-resolve.ts`: tsconfig paths, pnpm workspaces, PSR-4; `unresolvedImports` | T06 | `src/core/atlas-resolve.ts`, `src/core/atlas.ts`, `tests/atlas-resolve.test.ts` | `bun run check` | Alias `@/x`, `@scope/pkg`, `App\X` se resuelven; externos en coverage |
| T09 | F1-E | Skeleton v2: docblock tags, decoradores/atributos, PHP/JS/Astro/SCSS, `depth` | T06, T07 | `src/core/atlas.ts`, `src/plugin.ts`, `tests/atlas.test.ts` | `bun run check` | Skeleton PHP conserva `#[Route]`/`@throws`; `signatures+calls` lista llamadas |
| T10 | F6-A | `language.ts` + `FlowState.userLanguage` + fijación en `mr_flow_start` | — | `src/core/language.ts`, `src/core/flow-schema.ts`, `src/plugin.ts`, `tests/language.test.ts`, `tests/flow-schema.test.ts` | `bun run check` | Detección correcta es/en en 20 frases; estado persiste idioma |
| T11 | F2-A | `evidence-store.ts`: esquemas, persistencia, slices, freshness/relocate | T03 | `src/core/evidence-store.ts`, `tests/evidence-store.test.ts` | `bun run check` | Add/list/check funcionan; stale detectado tras editar |
| T12 | F2-B | Tools `mr_evidence_add`, `mr_evidence_list` | T11 | `src/plugin.ts`, `tests/plugin.test.ts` | `bun run check` | Tools registradas y probadas con contexto mock |
| T13 | F2-C | `ResearchCapsule` v2 + migración + validación de refs en `validateSddArtifacts` | T11 | `src/core/sdd-schema.ts`, `src/core/render.ts`, `tests/sdd-schema.test.ts` | `bun run check` | v1 migra; requisito sin ref → error en Full |
| T14 | F2-D | `context-hydrator.ts` + `ContextBundle` + tool `mr_context_hydrate` con presupuestos | T11, T13 | `src/core/context-hydrator.ts`, `src/plugin.ts`, `tests/context-hydrator.test.ts` | `bun run check` | Bundle por rol contiene solo refs de la tarea; `truncated[]` correcto |
| T15 | F2-E | Integrar hidratación en `next-task`, `buildJudgePrompt`, `mr_flow_fix` | T14 | `src/plugin.ts`, `src/core/judgment.ts`, `tests/judgment.test.ts`, `tests/plugin.test.ts` | `bun run check` | Prompts de jueces y fix incluyen bundle serializado |
| T16 | F3-A | `TaskGraph` v2 (`targetSymbols`, `evidenceRefs`, `editBoundaries`, `invariants`, `expectedDiff`, `verification`) + migración | T13 | `src/core/sdd-schema.ts`, `src/core/render.ts`, `tests/sdd-schema.test.ts` | `bun run check` | Tasks v1 migran; render muestra límites e invariantes |
| T17 | F3-B | `gates.ts` (`gatePlan`, `gateBeforeImplement`, `gateAfterImplement`, `gateBeforeJudgment`) + `MR_GATES_MODE` | T16, T14 | `src/core/gates.ts`, `tests/gates.test.ts` | `bun run check` | Cada gate probado en `warn` y `block` |
| T18 | F3-B | Tool `mr_sdd_verify` + `VerificationReceipt`; `task_status done` exige recibo y gate | T17 | `src/plugin.ts`, `src/core/sdd-schema.ts`, `tests/plugin.test.ts` | `bun run check` | `done` rechazado sin recibo o con diff fuera de límites |
| T19 | F3-C | `risk.ts` + `requiresJudgment(lane)` + carril en `mr_flow_status` | T16 | `src/core/risk.ts`, `src/core/flow-schema.ts`, `src/plugin.ts`, `tests/risk.test.ts`, `tests/flow-schema.test.ts` | `bun run check` | `critical` para `src/Auth/*` con difficulty 1; `fast` omite jueces |
| T20 | F3-D | Ticket sintético `LOCAL-*` y adaptador `local` | T10 | `src/core/ticket.ts`, `src/plugin.ts`, `tests/ticket.test.ts` | `bun run check` | Flow sin ticket avanza hasta `finish` en test |
| T21 | F3-E | Prompts de agentes v2 (inglés) con hidratación obligatoria, evidencia y límites | T12, T14, T18 | `src/core/config.ts`, `tests/config.test.ts` | `bun run check` | Tests de prompts invariantes pasan; cero literales españoles |
| T22 | F4-A | Tipos de arista ampliados + impacto ponderado | T03 | `src/core/atlas.ts`, `tests/atlas.test.ts` | `bun run check` | `getImpactAnalysis` pondera `calls`/`implements` |
| T23 | F4-B | `semantic/typescript.ts` con Language Service acotado; aristas `calls` | T22, T08 | `package.json`, `src/core/semantic/typescript.ts`, `src/core/atlas.ts`, `tests/semantic-typescript.test.ts` | `bun run check` | Fixture `a→b` produce `calls`; tiempo < 3 s en fixture |
| T24 | F4-C | `semantic/php.ts`: phpstan/psalm opcional, console introspection opt-in, degradación declarada | T06, T22 | `src/core/semantic/php.ts`, `src/core/atlas.ts`, `tests/semantic-php.test.ts` | `bun run check` | Sin herramientas → `semantic: syntactic-only`; con mock JSON → aristas |
| T25 | F4-D | Extractores `module-federation`, `symfony`, `doctrine`, `cqrs` | T22, T06 | `src/core/extractors/{index,module-federation,symfony,doctrine,cqrs}.ts`, `tests/extractors.test.ts` | `bun run check` | Fixtures producen `exposes/consumes`, `route`, `entity`, handler↔command |
| T26 | F4-D | Extractores `tanstack-query`, `redux`, `nextjs`, `zod`, `scss`, `astro-expo` | T25, T07 | `src/core/extractors/*.ts`, `tests/extractors.test.ts` | `bun run check` | Fixtures producen `query-key`, `slice`, `route`, `contract`, `token` |
| T27 | F4-E | `contracts.ts` cross-repo (endpoint↔cliente, exposes↔remotes, Zod compartido) | T25, T26 | `src/core/contracts.ts`, `src/core/atlas.ts`, `tests/contracts.test.ts` | `bun run check` | Workspace multi-repo fixture produce aristas `consumes` inter-repo |
| T28 | F5-A | `rules/profiler.ts` + detectores `naming`, `modules`, `styles` | T03, T08 | `src/core/rules/profiler.ts`, `src/core/rules/detectors/*.ts`, `tests/rules-profiler.test.ts` | `bun run check` | Fixtures kebab 90% → inferred ≥ 0.85; barrels mixtos → decisión |
| T29 | F5-A | Detectores `state-data`, `backend`, `testing`, `quality`, `git`, `boundaries` | T28, T25 | `src/core/rules/detectors/*.ts`, `tests/rules-profiler.test.ts` | `bun run check` | Fixture Symfony detecta CQRS/Doctrine; fixture React detecta Query/Redux |
| T30 | F5-B | `rules/generator.ts` + `RepositoryRules` + `renderAgentsMarkdown(lang)` | T28, T29, T10 | `src/core/rules/generator.ts`, `src/core/render.ts`, `tests/rules-generator.test.ts` | `bun run check` | Reglas clasificadas fact/inferred/confirmed; AGENTS.md en `es` y `en` |
| T31 | F5-C | CLI `mr atlas init|rules|index` + TUI `src/tui/atlas.ts` + persistencia en `contextRoot/atlas/` + `instructions` | T30 | `src/cli.ts`, `src/tui/atlas.ts`, `src/core/config.ts`, `tests/cli-atlas.test.ts`, `tests/config.test.ts` | `bun run check`, `mr atlas init --no-rules` en fixture | Enter acepta; `--no-rules` no genera; fallo del profiler no bloquea; nunca sobrescribe sin diff |
| T32 | F5-D | Reglas en hidratación, invariantes de plan, gates deterministas, jueces y bp-architect | T31, T17, T14 | `src/core/context-hydrator.ts`, `src/core/gates.ts`, `src/core/config.ts`, `tests/*.test.ts` | `bun run check` | `hydrate` filtra por `appliesTo`; gate detecta naming/barrel/`!important` |
| T33 | F6-A | `render.ts` i18n (`MESSAGES[lang]`) y plugin outputs por idioma; tool descriptions en inglés | T10 | `src/core/render.ts`, `src/plugin.ts`, `tests/render.test.ts` | `bun run check` | Snapshot es/en de status, plan, verdict, coverage |
| T34 | F6-B | `budgets.ts` por rol × carril; uso vs. presupuesto en `mr_flow_status`; carril `fast` en una sesión | T14, T19 | `src/core/budgets.ts`, `src/core/context-hydrator.ts`, `src/plugin.ts`, `tests/budgets.test.ts` | `bun run check` | Presupuestos aplicados; `fast` sin jueces ni segunda sesión |
| T35 | F0/F6 | Re-ejecutar corpus, guardar `bench/baselines/2026-XX-after.json`, activar `MR_GATES_MODE=block` por defecto | T02, T17..T34 | `bench/`, `src/core/gates.ts`, `docs/USAGE.md`, `CHANGELOG.md` | `bun run check`, bench | Métricas de la sección 3 alcanzadas o desviaciones documentadas |

Dependencias críticas: T03 es raíz de casi todo; T11/T13/T14 son raíz de F3; T16/T17 son raíz de gates; T10 desbloquea idioma en render (T30, T33).

---

## 6. Especificaciones de interfaz consolidadas

### 6.1 Nuevos módulos
```text
src/core/bench.ts                 # F0 esquemas de journeys y reporte
src/core/atlas-resolve.ts         # F1 resolución de aliases/workspaces/PSR-4
src/core/evidence-store.ts        # F2 EvidenceRef, store, slices, freshness
src/core/context-hydrator.ts      # F2 ContextBundle por rol/tarea con presupuesto
src/core/gates.ts                 # F3 gates deterministas
src/core/risk.ts                  # F3 carriles de riesgo
src/core/language.ts              # F6 detección de idioma
src/core/budgets.ts               # F6 presupuestos por rol × carril
src/core/semantic/typescript.ts   # F4 Language Service acotado
src/core/semantic/php.ts          # F4 phpstan/psalm/console opcional
src/core/extractors/*.ts          # F4 extractores de framework
src/core/contracts.ts             # F4 contratos cross-repo
src/core/rules/profiler.ts        # F5 RepositoryProfile
src/core/rules/detectors/*.ts     # F5 detectores
src/core/rules/generator.ts       # F5 RepositoryRules + AGENTS.md
src/tui/atlas.ts                  # F5 TUI de atlas init
scripts/bench-report.ts           # F0 reporte
bench/                            # F0 corpus y baselines
```

### 6.2 Tools nuevas del plugin (nombres definitivos)
| Tool | Rol autorizado | Propósito |
|---|---|---|
| `mr_evidence_add` | explore, plan | Registrar un slice con hash como evidencia |
| `mr_evidence_list` | todos | Listar refs por ticket/kind/requisito |
| `mr_context_hydrate` | implement, judges, fix, plan | Bundle mínimo por rol/tarea |
| `mr_sdd_verify` | implement, fix | Persistir recibo real de verificación |

### 6.3 Cambios de esquema con versión
| Esquema | v actual | v nueva | Migración |
|---|---|---|---|
| `AtlasGraph` | 1 | 2 | reindex completo |
| `ResearchCapsule` | 1 | 2 | refs desde `evidence[]` |
| `TaskGraph`/`SddTask` | 1 | 2 | `verify` → `verification.commands`; `editBoundaries.allowedFiles` = `files[].path`; `evidenceRefs` desde research |
| `FlowState` | 1 | 1 (+ `userLanguage?`, `lane?`) | campos opcionales |

### 6.4 Persistencia por workspace
```text
${generatedRoot}/${workspaceId}/
  atlas/graph.json                 # v2
  evidence/${ticketId}/store.json
  evidence/${ticketId}/slices/${sliceHash}.txt
  sdd/verify/${taskId}.json
${contextRoot}/atlas/profile.json  # F5
${contextRoot}/atlas/rules.json
${contextRoot}/atlas/AGENTS.md
```

---

## 7. Guía de ejecución con GPT-5.6 Sol (high)

1. Ejecutar **una tarea por invocación**, en el orden de la tabla de la sección 5.
2. Antes de cada tarea: leer este documento (sección de la fase + fila de la tarea) y los archivos listados; usar `mr_atlas_skeleton`/`codebase-memory` para localizar y **leer cuerpos completos** de lo que se edita.
3. Restricciones de código: TypeScript ultra-estricto del repo (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Zod `strictObject`, funciones puras testeables, `atomicWrite`/`canonicalJson` para persistencia, nada de Markdown generado por modelo en artefactos internos.
4. Cada tarea termina con `bun run check` verde y un commit `type(scope): summary` (inglés).
5. Si una tarea revela una decisión no cubierta aquí, detenerse y registrar la pregunta en `docs/plans/2026-09-flow-reliability-program.md#open-decisions` en lugar de improvisar.
6. No tocar `models.json` ni el roster.
7. Mantener `MR_GATES_MODE=warn` hasta T35.

Plantilla de prompt por tarea (en inglés, para el implementador):
```text
Implement task T## from docs/plans/2026-09-flow-reliability-program.md.
Scope: only the files listed for T##. Read full bodies of every symbol you modify.
Constraints: strict TS, zod strictObject, pure functions, atomicWrite/canonicalJson, tests in tests/.
Done when: the "Hecho cuando" condition holds and `bun run check` passes.
Return a compact receipt: files changed, tests added, verification output tail.
```

---

## 8. Decisiones abiertas {#open-decisions}

| # | Decisión | Opción por defecto | Cuándo cerrar |
|---|---|---|---|
| D1 | Gramática Astro/SCSS sin wasm estable | Modo `partial` con regex, `parseStatus: partial` | T07 |
| D2 | `typescript` como dependencia runtime | Sí (mover de devDependencies) | T23 |
| D3 | Introspección Symfony por consola | Opt-in por regla `symfony.consoleIntrospection` | T24 |
| D4 | Ubicación por defecto de `AGENTS.md` | `${contextRoot}/atlas/AGENTS.md` + `instructions`; repo root solo con flag | T31 |
| D5 | Presupuestos iniciales por rol | implement 60k, judge 40k, fix 30k, plan 50k chars | T34 |
| D6 | Umbrales del carril de riesgo | fast ≤ 3 dif, ≤ 2 archivos, impacto ≤ 3; critical áreas críticas o impacto ≥ 15 | T19, revisar en T35 |

---

## 9. Riesgos globales y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Sobreingeniería antes de medir | F0 obligatoria; cada fase compara contra baseline |
| Falsos bloqueos de gates | `MR_GATES_MODE=warn` hasta validar corpus |
| Latencia de indexado/LSP en repos grandes | incremental por hash, vecindario acotado, timeouts, límites de bytes |
| Reglas incorrectas | siempre con `evidence[]`, confidence y confirmación mínima; nunca sobrescribir sin diff |
| Regresiones en FSM | campos opcionales, migraciones explícitas, tests de replay existentes |
| Mezcla de idiomas | test de cumplimiento en prompts y snapshots es/en en render |

---

## 10. Definición de "programa terminado"

- T01–T35 completadas con `bun run check` verde.
- `bench/baselines/*-after.json` muestra las métricas de la sección 3 alcanzadas o cada desviación explicada.
- `MR_GATES_MODE=block` por defecto.
- `docs/USAGE.md` documenta `mr atlas init|rules`, evidencia compartida, carriles de riesgo e idioma.
- `CHANGELOG.md` actualizado con una entrada por fase.
