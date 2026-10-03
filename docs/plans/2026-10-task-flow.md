# `/task`: entrega rápida explore → plan → apply

Estado: implementado (v1). Este documento es la especificación de referencia.

## Objetivo

Entregar tareas pequeñas y medianas con calidad de modelo frontera, pagando
modelo caro solo para razonar. Cada rol lee lo mínimo suficiente; nada se
pierde porque todo queda en un diario recuperable.

| Rol | Modelo (config `models.json`) | Hace |
|---|---|---|
| orchestrator | `orchestrator` | Coordina; único que habla con el developer |
| mr-task-explore | `explore` | Lee y registra hechos, descartes y dudas |
| mr-task-plan | `plan` | Razona y emite un ExecutionPlan anclado |
| mr-task-apply | `general` | Ejecuta solo los pasos que requieren síntesis |
| Jev | Decision Plane | Decide cuánto leer, qué verificar, qué pasar a cada rol |
| Relay | código del plugin (0 tokens) | Escucha cada tool y escribe el diario |

El modelo y el esfuerzo de cada rol los decide el developer en configuración.
Jev nunca elige modelo.

## Fases (FSM `src/core/task/schema.ts`)

```text
mr_task_start ─► explore ─► plan ─► apply ─► verify ─► done
   (intake +       │          ▲                  │
    J1 Jev)        └─ read=none salta a plan     └─ fallo ×2 ─► plan (replan)
abort desde cualquier fase ─► aborted
```

Un solo `/task` activo por workspace. `/flow` y `/task` son independientes.

### 1. Intake (determinista, sin LLM)

`collectTaskSignals` extrae de la entrada: rutas existentes mencionadas,
símbolos presentes en Atlas, palabras clave por estrategia, áreas críticas
(`risk.ts`), reglas `block` sobre las rutas, herramientas de verificación
detectadas en `package.json` y gestor de paquetes.

### 2. J1: estrategia de contexto (Jev)

Una sola evaluación con varias preguntas `choice`:

| Clave | Opciones |
|---|---|
| graph | skip · map · impact |
| engram | skip · prefetch |
| rules | skip · applicable |
| read | none · targeted · broad |
| verify | format-lint · typecheck · tests |
| size | trivial · small · medium · large |
| strategy | tweak · replicate · ui · feature · bugfix · refactor |

Una respuesta se acepta si su probabilidad ≥ `TASK_ACCEPT_THRESHOLD` (0.75).
Si no, o si Jev no está disponible, gana la heurística determinista.

**Suelos deterministas** (`applyTaskFloors`) que Jev no puede bajar:

- regla `block` sobre una ruta mencionada → `rules=applicable`;
- verificación mínima: `format-lint` si hay eslint/prettier; `bugfix` ≥ `tests`
  si hay script de test; `feature`/`refactor` ≥ `typecheck` si existe;
- `bugfix` ≥ `read=targeted`; `refactor` ⇒ `graph=impact`; `read=broad` ⇒ `graph≥map`;
- área crítica, `size=large` o dificultad ≥ 13 ⇒ `escalation="flow"` (recomendación, no se fuerza).

### 3. Explore

`mr-task-explore` recibe el brief con presupuesto, lee y registra con
`mr_task_record` lo que no es una lectura: `fact`, `decision`, `discard`
(hipótesis descartadas y por qué), `unknown`. Termina con
`mr_task_explore_submit`, que valida la **lista de comprobación de la
estrategia** (contrato del receptor):

| Estrategia | Claves obligatorias |
|---|---|
| tweak | target |
| replicate | reference, target, deltas |
| ui | design, reuse, placement |
| feature | entrypoints, contracts, tests |
| bugfix | reproduction, rootCauseCandidates, failingPath, tests |
| refactor | symbols, dependents, tests |

Valor permitido: texto concreto o `unknown: <motivo>`. Tras el submit, J2
reclasifica estrategia y dificultad (1, 2, 3, 5, 8, 13) con el informe y evalúa
suficiencia. Insuficiente ⇒ se pide una exploración puntual de los huecos.

### 4. Escalera de preguntas (`mr_task_ask`)

El modelo formula hasta 3 preguntas `choice` con criterios, impacto y default.

1. Jev ≥ 0.85 ⇒ resuelta, se registra como decisión.
2. Si no e impacto `high` ⇒ se pregunta al humano (máximo 2 por tarea).
3. En otro caso ⇒ se toma el default y se registra como supuesto.

### 5. Handoff sin pérdida (`mr_task_context`)

Para cada rol receptor:

1. **Must-keep** literal: entrada del usuario, decisiones, descartes, dudas,
   hechos, errores y comandos fallidos, criterios de la checklist.
2. **Candidatos** (lecturas, búsquedas, comandos ok, notas): Jev decide
   KEEP/DROP con sesgo a conservar (solo se descarta con p(keep) < 0.25).
   Sin Jev: se conservan los más recientes dentro del presupuesto.
3. Lo conservado viaja **literal**; las lecturas se rehidratan desde disco con
   su rango y se marcan `stale` si el sha cambió.
4. **Manifest**: todo lo omitido aparece con id y una línea.
   `mr_task_recall(ids)` lo devuelve completo. Nada se borra.

### 6. Plan (`mr_task_plan_submit`)

```json
{ "summary": "…", "strategy": "replicate", "difficulty": 2,
  "assumptions": ["…"],
  "steps": [{ "id": "S1", "file": "src/a.ts", "op": "replace",
    "anchor": { "snippet": "texto actual exacto", "fileSha": "opcional" },
    "code": "texto final exacto", "intent": "si code falta",
    "reference": { "file": "src/b.ts", "lines": [10, 40] },
    "mustNotTouch": ["…"], "dependsOn": [] }],
  "verification": ["bun run typecheck"] }
```

Validador determinista: rutas relativas y no sensibles; `replace`/`insertAfter`/
`insertBefore` exigen ancla que aparece **exactamente una vez**; `create` exige
archivo inexistente y `code`; `deleteFile` exige archivo existente; cada paso
lleva `code` o `intent` (≥ 20 caracteres); `dependsOn` sin ciclos ni ids
desconocidos; comandos de verificación con el formato permitido.

### 7. Apply

`mr_task_apply` aplica sin modelo todos los pasos con `code`, revalidando el
ancla en el momento. Los pasos con `intent` los ejecuta `mr-task-apply`, que
recibe solo su paso + ancla ±20 líneas + referencia, y cierra con
`mr_task_step_done`.

### 8. Verify (`mr_task_verify`)

Ejecuta, sin shell, los comandos del plan más los del suelo (eslint/prettier
acotados a los archivos tocados, typecheck, tests). Comprueba conformidad: el
diff solo toca archivos del plan o que ya estaban sucios al empezar. Dos
fallos seguidos ⇒ replan con la cápsula del fallo, no con el historial.

### 9. Finish

`mr_task_finish` cierra y guarda una memoria compacta en Engram (best-effort).
`/task` **no** crea rama, commit ni PR: deja los cambios en el árbol de trabajo.

## Relay (escuchador)

Hook `tool.execute.after` del plugin. Con un `/task` activo registra en
`<generated>/<workspace>/task/<id>/journal.jsonl`:

| Tool | Evento |
|---|---|
| read | `read` con archivo, rango y sha del archivo (puntero, sin contenido) |
| grep / glob / list | `search` con patrón y primeras líneas del resultado |
| edit / write / patch | `edit` con archivo |
| bash | `command` con comando, salida recortada y fallo detectado |

El orchestrator no lee el flujo en tiempo real: recibe solo estados compactos
en las transiciones. Jev se consulta en cada frontera.

## Seguridad

- Los comandos de verificación se ejecutan sin shell, con lista blanca de
  binarios (`bun`, `bunx`, `npm`, `npx`, `pnpm`, `yarn`), sin metacaracteres
  y con timeout.
- Las rutas del plan no pueden salir del workspace ni tocar rutas sensibles.
- Jev solo decide coste (lectura, verificación, qué pasar). Los suelos y las
  validaciones siguen siendo deterministas.

## Medición

Para afirmar «nivel Opus», correr `bench/corpus.json` con el modelo frontera
solo y con `/task`, mismas condiciones, y comparar éxito, coste, tiempo a la
primera edición, tiempo total e intervenciones humanas.

## Esfuerzo por estrategia

`~/.config/mr-orchestrator/task-effort.json` (lo edita el developer, nunca Jev):

```bash
mr task-effort set replicate plan low
mr task-effort set bugfix plan xhigh
mr task-effort show
mr task-effort unset replicate plan
```

Mismo modelo de `models.json`, solo cambia la variante. En OpenCode se generan
agentes `mr-task-<rol>-<variante>` y las tools de `/task` devuelven
`next.agent`. En arneses por invocación se pasa
`mr-clients run-role <arnés> <rol> --variant <v> -- …`.

## Arneses

`/task` se instala con `mr-clients install` en Codex, Cursor (`agent`),
Claude Code, Antigravity, AGY, fx y Pi. Todos usan las mismas tools `mr_task_*`
por el bridge MCP y lanzan cada rol con `run-role`. Esos arneses no tienen el
hook del Relay: las lecturas se registran con `mr_task_record kind=read`.

## Bench de intake (bajo coste)

```bash
bun scripts/task-intake-bench.ts                     # heurística, 0 tokens
bun scripts/task-intake-bench.ts --jev --no-zdr --out bench/baselines/2026-10-task-intake.json
```

Mide solo intake (estrategia, dificultad, contexto, escalado) sobre
`bench/corpus.json`; los repos del corpus no existen, así que ningún modelo
ejecuta los recorridos. Resultado 2026-10-03: acuerdo de carril lite/full 86,7 %
heurística y Jev; ~1.520 tokens y ~0,4 s por llamada a Jev. Jev subestimaba la
dificultad, por eso en intake solo puede subirla.

**Proveedor de Jev:** con `TYPESAFE_API_KEY` (o `JEV_API_KEY`) el plugin llama
directo a `https://api.typesafe.ai/v1/systemone` (~0,3 s, ~470 tokens por
pregunta corta); sin ella usa Vercel AI Gateway. Simulación con Jev real:
`bun scripts/task-sim-bench.ts --corpus ../apps/corpus --jev` → 6/6, 19 llamadas,
~18.800 tokens de Jev.

**ZDR:** Vercel AI Gateway rechaza `zeroDataRetention` en el plan hobby. El
runtime lo sigue pidiendo (Jev falla cerrado y gana la heurística); el bench
usa `--no-zdr` porque el corpus está anonimizado.

## Pendiente

- Paralelizar pasos independientes en apply.
- Bench end-to-end con modelos reales sobre fixtures de los repoProfile.
