# Guía rápida de comandos

Chuleta puntual para `/flow`, `/blueprint`, `/prompt` y `/atlas`. Todos reciben texto libre como `[CONTEXT_INPUT_PAYLOAD] $ARGUMENTS`; los parámetros formales viven en las herramientas `mr_*` que cada comando invoca.

---

## `/flow` — entrega determinista por ticket

> Fuente: `src/core/config.ts:134`, `src/plugin.ts:394`.

Escribes texto libre, ej. `/flow GH-42 dificultad 5`. El orchestrator ejecuta el wizard y te pide:

* `difficulty` — requerido: `1 | 3 | 5 | 8 | 13 | 21` (`1-3` = Lite, `5+` = Full con Judgment).
* `ticketId` — opcional, ej. `GH-42`, `123`. Si se omite hay que dar `taskText`.
* `taskText` — opcional, texto original; sin `ticketId` crea ticket sintético `LOCAL-*` y avanza directo a exploración.
* `hasFigma` — opcional, default `false`.

Herramientas del ciclo:

* `mr_flow_status` / `mr_flow_abort`: sin parámetros.
* `mr_flow_start`: `difficulty` requerido; `ticketId`, `taskText`, `hasFigma` opcionales. Exige `ticketId` o `taskText` no vacío.
* `mr_flow_ticket`: `title`, `description` requeridos; `type`, `platform`, `branch`, `baseBranch` opcionales.
* `mr_flow_plan`: `summary`, `files[] {path, action: create|modify|delete|rename, reason, risk?}` requeridos; `rootCause`, `tests[] {path, type: unit|integration|e2e, description}` opcionales.
* `mr_flow_implement`: `completedFiles[]` requerido.
* `mr_flow_judge`: `judge: a|b`, `status: SUPPORTED|INSUFFICIENT_EVIDENCE`, `approved`, `findings[] {severity, claim, file, line, side: new|old, source: diff, evidence}` requeridos; `missing`, `nextAction` para `INSUFFICIENT_EVIDENCE`.
* `mr_flow_fix`: sin parámetros.
* `mr_flow_finish`: `commitHash`, `prUrl`, `humanApproved` opcionales — pero `humanApproved=true` es obligatorio si `lane=critical`.

---

## `/blueprint` — idea o ticket a especificación

> Fuente: `src/core/config.ts:230`, `src/plugin.ts:938`.

Escribes `/blueprint <tu idea o ticket>`. El wizard pregunta con la herramienta `question`:

* Opción A: desarrollar idea de producto.
* Opción B: analizar ticket GitHub / Project v2.

Si es idea, opcionalmente eliges cuestionario estratégico: `10 | 20 | 50 preguntas | saltar a SDD`.

Herramientas:

* `mr_blueprint_save`: `slug`, `title`, `mode: idea|ticket`, `overview`, `requestIntent` requeridos; `userLanguage`, `transversalImpact[]`, `assumedInferences[]`, `entities[]`, `invariants[]`, `contracts[]`, `testConditions[]`, `tasks[]` opcionales. Guarda en `.blueprint/specs/<fecha>_<slug>.json` y `.md`.
* `mr_blueprint_safety_gate`: `action: create|update|delete`, `repo: owner/name`, `title` requeridos; `id`, `fields`, `userLanguage` opcionales. Devuelve `safetyGateTicket` (muestra preview antes de mutar).
* `mr_blueprint_graphql`: `query` requerido; `variables`, `safetyGateTicket` opcionales — pero toda `mutation` exige ticket válido o falla en cerrado.

---

## `/prompt` — prompt ingenierizado + portapapeles

> Fuente: `src/core/config.ts:213`, `src/plugin.ts:1351`.

Escribes `/prompt <lo que quieres lograr>`, ej. `/prompt fix del login que rompe en Safari`. El agente detecta plantilla y te refina variables contigo.

Herramientas:

* `mr_prompt_build`: `template: bugfix|feature|refactor|review` requerido; `variables: {clave: valor}` requerido.
* `mr_prompt_copy`: `text` requerido. Solo se invoca tras tu confirmación explícita en tu idioma.

Flujo: refinar → mostrar resultado → confirmar → copiar vía `pbcopy`/`xclip`.

---

## `/atlas` — mapa e índice del workspace

> Fuente: `src/core/config.ts:158`, `src/plugin.ts:1083`.

Escribes `/atlas index` o `/atlas <componente|pregunta>`, ej. `/atlas index`, `/atlas LoginForm impact`.

Herramientas:

* `mr_atlas_index`: todo opcional; `includePatterns[]` (globs, default cubre `src/**` y `repos/**`). Indexa `TS/TSX/JS/PHP/Java/CSS/SCSS/Astro` + `JSON/YML/YAML`.
* `mr_atlas_profile`: `repo`, `files[]` opcionales. Sin `repo` trae todos los perfiles + reglas aplicables.
* `mr_atlas_query`: todo opcional; lo habitual es `nodeName` + `action: map|info|deps|dependents|impact|slice|tests|semantic|governance`. Afinadores: `kind`, `depth` (default `2`), `context` (`0-50`), `filePath` (governance), `supports[]` (evidencia semántica).

Flujo: payload vacío o con `index` → `mr_atlas_index` e informa `ficheros, nodos, aristas, duración`; con nombre/consulta → `mr_atlas_query` y presenta markdown estructurado.
