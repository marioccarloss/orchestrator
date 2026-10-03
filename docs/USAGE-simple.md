# Guía rápida de comandos

Chuleta puntual para `/flow`, `/task`, `/blueprint`, `/prompt` y `/atlas`. Todos reciben texto libre como `[CONTEXT_INPUT_PAYLOAD] $ARGUMENTS`; los parámetros formales viven en las herramientas `mr_*` que cada comando invoca.

---

## `/flow` — wizard guiado → entrega determinista

> Descripción del comando: *Wizard guiado: ticket/tarea → dificultad → diseño → arranque*.

Escribes `/flow`. El orchestrator ejecuta el **wizard determinista**:

- `mr_flow_wizard_begin` → primera pregunta
- `mr_flow_wizard_step answer=...` → siguiente paso (o `autoStarted: true` al final)
- El orchestrator refleja las mismas opciones con `question` para la TUI

Pasos:

1. **Origen** — GitHub | Jira | GitLab | **No tengo ticket** (una sola opción).
   - Con plataforma: identificador (`GH-42`, `PROJ-105`) → lectura vía gh/MCP o pegado manual si falla (`mr_flow_platform_status` es informativo, no bloqueante).
   - Sin ticket: salta al paso 4 con tu descripción.
2. **Dificultad Fibonacci** — `1 | 3 | 5 | 8 | 13 | 21` (`1-3` Lite, `5+` Full con Judgment si el carril lo exige).
3. **Diseño** — No | Figma (figma-live-mcp) | Imagen | Otro. Sin preguntar “¿eres frontend?”. Figma no bloqueante si MCP no responde.
4. **Instrucciones** — placeholder: se analizará el ticket; complementa aquí si quieres.
5. **`mr_flow_start`** — arranca el flujo.

Indicador de rol en el arnés (título de tools `mr_flow_*`, sin gastar tokens en prosa): `🔍 Explore · mr-explore · modelo`.

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

## `/task` — entrega rápida explore → plan → apply

> Especificación: `docs/plans/2026-10-task-flow.md`.

Escribes `/task <una línea, un prompt, o la referencia a un ticket/diseño>`. Sin wizard ni jueces:

1. **Intake** (`mr_task_start`): señales deterministas + Jev decide cuánto leer, si usar grafo, memoria y reglas, y qué verificar. Suelos deterministas que Jev no puede bajar. Si es crítico o grande, recomienda `/flow` sin forzarlo.
2. **Explore** (`mr-task-explore`): lee lo justo y registra hechos, decisiones, **descartes** y dudas (`mr_task_record`); cierra con `mr_task_explore_submit` y la checklist de la estrategia.
3. **Plan** (`mr-task-plan`): recibe el handoff sin pérdida (`mr_task_context`), pregunta con `mr_task_ask` (Jev → default → humano solo si es crucial) y envía un plan anclado (`mr_task_plan_submit`).
4. **Apply**: `mr_task_apply` aplica sin modelo los pasos con código exacto; `mr-task-apply` hace solo los pasos con `intent` (`mr_task_step_done`).
5. **Verify** (`mr_task_verify`): lint/format de los archivos tocados + typecheck/tests según el nivel, sin shell, y comprobación de que el diff solo toca archivos del plan.
6. **Finish** (`mr_task_finish`): memoria compacta en Engram. No hace commit, push ni PR.

Modelos: por defecto heredan `explore`, `plan` y `general` de `/flow`. `mr task-model` abre pestañas **Modelo │ Esfuerzo │ Velocidad** por rol (explore, plan, apply); la velocidad aparece solo si el catálogo de OpenCode tiene variantes de servicio (`-fast`, `-flex`, `-ultrafast`). También: `mr task-model set plan openai/gpt-5.6-sol-fast#high`, `mr task-model reset`, o la opción «Configurar roles de /task» en `mr flow-models`. Jev se usa si el Decision Plane está activo (`mr decision shadow` + credencial de AI Gateway); si no, heurísticas deterministas.

El **Relay** (hook `tool.execute.after`) escribe cada lectura, búsqueda, edición y comando en `journal.jsonl`; lo omitido en un handoff aparece en el manifest y se recupera con `mr_task_recall`.

---

## Narración `[▶ play]` en `/task`, `/flow` y `/blueprint`

Cada explicación del orchestrator (o de bp-architect) termina con un enlace `[▶ play]`. Al pincharlo se abre una URL local del plugin y la explicación se lee en voz alta con `say` de macOS, en el idioma del developer. Sin clic no suena nada; la página tiene `⏹ Detener`.

* Solo `127.0.0.1`, token aleatorio por sesión de OpenCode; la URL no lleva el texto.
* El enlace se quita del historial antes de cada llamada al modelo: cero tokens.
* `MR_NARRATION=off` lo desactiva; `MR_NARRATION_VOICE` y `MR_NARRATION_RATE` (90-400) ajustan voz y velocidad.
* Fuera de macOS, o en arneses externos (fx, Pi, Cursor…), no aparece.

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

### Atlas para cualquier agente (fuera de `/flow` y `/task`)

`mr atlas index` (y `init`/`rules`) además genera un paquete **local** en `.aicontext/atlas/`:

* `MAP.md`: stack, comandos, carpetas y símbolos más conectados con `archivo:línea` (≤ 16.000 caracteres).
* `MEMORY.md`: decisiones del proyecto desde Engram (si está activo).
* `AGENTS.md`: reglas (con `mr atlas init`).

Y escribe un bloque `<!-- mr-atlas:start -->…<!-- mr-atlas:end -->` en el `AGENTS.md` de cada repo (lo crea si falta), en `GEMINI.md` y `.github/copilot-instructions.md` si existen, y en `CLAUDE.md`: si falta lo crea con `@AGENTS.md` (Claude Code lo importa); si ya importa `@AGENTS.md` no lo toca. Solo toca lo que hay entre las marcas. `.aicontext/` y los `AGENTS.md` creados se ignoran en local con `.git/info/exclude`; nunca se commitean.

* `mr atlas query <Símbolo> info|deps|dependents|impact|slice|tests|find`: consulta el grafo desde cualquier terminal.
* `mr atlas index --no-link`: no escribe punteros. `mr atlas unlink`: los quita.
