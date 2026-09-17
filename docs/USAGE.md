# Manual de Uso de mr-orchestrator

Esta guía explica cómo operar `mr-orchestrator` desde el modo normal de desarrollo. Los comandos seleccionan internamente el agente especializado; no necesitas cambiar manualmente a `Orchestrator` para usar `/flow`.

---

## 1. Conceptos Fundamentales

- **`mr` (CLI Administrativo):** Herramienta de línea de comandos para gestionar la instalación, configuración de workspaces, diagnósticos y modelos.
- **`mrcode` (Lanzador de OpenCode):** Wrapper inteligente que detecta en qué workspace te encuentras (inspeccionando el directorio de trabajo actual y sus ancestros) y arranca `opencode` inyectando la configuración compilada adecuada.
- **Agentes internos:**
  - `build` es el agente predeterminado para desarrollo y asistencia.
  - `/flow` declara `agent: orchestrator`, por lo que OpenCode despacha automáticamente ese comando al coordinador primario sin pedir un cambio de modo.

---

## 2. Referencia de Comandos CLI (`mr`)

### `mr doctor`
Ejecuta un diagnóstico completo del entorno:
- Verifica la presencia del runtime Bun aislado y OpenCode.
- Comprueba que `~/.local/bin` esté presente en la variable `$PATH`.
- Valida la integridad del manifest de instalación.
- Revisa los workspaces registrados y la existencia de sus archivos de configuración generados.

```bash
mr doctor
```

### `mr workspace add <ruta>`
Registra un nuevo workspace en el registry global:
```bash
mr workspace add ~/Projects/my-workspace
```

> **Importante:** Los tools `mr_atlas_*`, `mr_flow_*` y `mr_sdd_*` **solo se cargan cuando ejecutas `mrcode` desde un directorio dentro de un workspace registrado**. Si ejecutas `opencode` desde `~/Projects/mr-orchestrator` (u otro directorio no registrado), `/atlas` fallará con un error de "tools no encontrados". Ver sección [8. Troubleshooting](#8-troubleshooting).

### `mr workspace list`
Muestra la lista de todos los workspaces registrados con sus identificadores únicos y rutas canónicas:
```bash
mr workspace list
```

### `mr workspace remove <id>`
Elimina un workspace del registro global:
```bash
mr workspace remove root-b78d0381
```

### `mr sync [id]`
Fuerza la regeneración del archivo `opencode.mr.json` para el workspace actual o el indicado por `id`:
```bash
mr sync
```

### `mr flow-models` / `mr models`
Abre el selector buscable del roster global o del override parcial de un arnés. Sin `--harness` edita el baseline compartido; con `--harness` solo persiste los roles cambiados para ese cliente:
```bash
mr flow-models
mr flow-models --harness cursor
```
`mr models` es un alias equivalente para la UI interactiva.
Otras operaciones CLI directas para modelos:
- `mr models list [--harness <id>]`: Muestra el roster efectivo y el origen `global` u `override` de cada target.
- `mr models set <rol> <modelo[#variante]> [model|alternative] [--harness <id>]`: Cambia un target global o crea un override atómico para un arnés.
- `mr models reset [<rol> [model|alternative]] --harness <id>`: Elimina todos los overrides del arnés, un rol o un target concreto.
- `mr models validate --harness <id>`: Valida y traduce el roster efectivo contra el catálogo del arnés.
- `mr models catalog --harness <id> --refresh`: Actualiza el catálogo cuando el adaptador soporta descubrimiento automático.
- `mr models preset <nombre>`: Aplica un conjunto preconfigurado (`balanced`, `gpt-sol`, `claude-opus`).

Los identificadores admitidos son `opencode`, `codex`, `cursor`, `claude`, `antigravity`, `agy` y `fx`. No existe `--workspace`: cambiar el workspace cambia el código y el estado de ejecución, nunca el roster de modelos.

### `mr atlas index | init | rules`

```bash
mr atlas index
mr atlas init --no-rules
mr atlas init --guided --lang es
mr atlas rules --diff --lang es
mr atlas rules --write-repo-agents --lang es --yes
```

| Operación | Resultado |
|---|---|
| `index` | Actualiza el grafo incremental usando hashes de contenido. |
| `init --no-rules` | Genera índice y perfiles sin crear una propuesta de reglas. |
| `init --guided` | Permite revisar las inferencias en una TUI; requiere terminal interactiva. |
| `rules --diff` | Regenera las reglas observadas y muestra el diff de su proyección. |
| `--lang en\|es` | Elige el idioma de la proyección humana de reglas. |
| `--write-repo-agents` | Propone un `AGENTS.md` en cada repo. Siempre enseña el diff antes de escribir. |
| `--yes` | Confirma esas escrituras cuando no hay TTY. |

`atlas init` perfila todos los repositorios del workspace registrado y persiste `profile.json`, `rules.json` y una proyección interna `AGENTS.md` en el almacenamiento aislado de `mr-orchestrator`. El profiler es *best effort*: un fallo se avisa, pero no inutiliza el índice. Las reglas conservan evidencia, confianza y ámbito `appliesTo`; describen convenciones observadas y no inventan preferencias.

---

## 3. Lanzamiento del Entorno (`mrcode`)

Navega a cualquier carpeta de tu proyecto registrado (por ejemplo, dentro de un microservicio o una SPA) y ejecuta:

```bash
cd ~/Projects/my-workspace/apps/api
mrcode
```

`mrcode` detectará automáticamente el workspace registrado y lanzará la interfaz TUI de OpenCode en el agente normal `build`. Al ejecutar `/flow`, OpenCode usa automáticamente el coordinador interno.

---

## 4. Modos y Roster de Agentes

| Agente / Rol | Modo | Permisos | Propósito |
|---|---|---|---|
| `orchestrator` | Primary interno | Control de flujo y preguntas | Coordinador de `/flow`; el comando lo selecciona automáticamente. |
| `mr-explore` | Subagent | Solo lectura (`edit: deny`, `bash: deny`) | Mapeo rápido de archivos, lectura de código y consultas al grafo de Atlas. |
| `mr-plan` | Subagent | Solo lectura (`edit: deny`, `bash: deny`) | Blueprint-lite, especificación y tareas en JSON tipado combinando SDD + RPI. |
| `mr-general` | Subagent | Edición y bash controlados | Único implementador en dificultad 1-3; modelo potente porque el flujo Lite no ejecuta juicio ni fix. |
| `mr-sdd-apply` | Subagent | Edición y bash controlados | Implementador especializado en dificultad 5+; aplica cada criterio SDD con verificación estricta. |
| `mr-judge-a` | Subagent | Solo lectura (`edit: deny`, `bash: deny`) | Primer revisor ciego adversarial del diff generado. |
| `mr-judge-b` | Subagent | Solo lectura (`edit: deny`, `bash: deny`) | Segundo revisor ciego adversarial independiente. |
| `mr-fix` | Subagent | Edición y bash controlados | Aplica exclusivamente las correcciones indicadas en el veredicto fusionado. |

---

## 5. Comandos de Trabajo

### `/flow` desde el modo normal:

#### `/flow + [prompt]`
Ejecuta el ciclo de vida completo de un requerimiento o ticket de forma controlada y determinista.

**Paso a paso del flujo:**
1. **Wizard Inicial:**
   - **Dificultad (Fibonacci: 1, 3, 5, 8, ...):** propone un carril inicial. Tras aprobar el plan, Flow lo recalcula con archivos tocados, evidencia, impacto Atlas y áreas críticas.
     - `fast` / `standard`: no ejecutan juicio adversarial ni `mr-fix`.
     - `full`: activa implementación SDD, juicio ciego paralelo y corrección iterativa.
     - `critical`: además exige aprobación explícita del riesgo.
   - **Identificador de Ticket:** Pregunta la clave del ticket (ej: `123`, `GH-42`, `PROJ-105`). La primera vez pregunta el sistema de tickets (GitHub / Jira / GitLab) y lo recuerda para ese workspace. Si no hay ticket, crea una referencia local `LOCAL-YYYYMMDD-NN` y continúa sin una escritura remota.
   - **Diseño en Figma:** Pregunta si existe diseño. Si se indica afirmativamente, consulta vía MCP y guarda la respuesta en caché local para evitar re-consultas.
   - **Idioma:** Detecta `es`, `en`, `pt`, `ca` o `fr` desde la petición y lo refina con el ticket. El idioma queda persistido durante todo el Flow.
2. **Descarga y Sincronización:**
   - Realiza un `git pull` de la rama base más reciente (`develop` o la default branch).
   - Genera la rama correspondiente siguiendo la receta de convención del workspace (ej: `feature/GH-123-slug` o `bugfix/GH-123-slug`) con una **única confirmación** del usuario.
3. **Exploración y Planificación (SDD + RPI):**
    - `mr-explore` mapea dependencias con Atlas y Engram.
    - `mr-plan` ejecuta primero un Blueprint-lite en JSON. Si el ticket ya está claro, continúa sin preguntar. Si existe una ambigüedad que cambia comportamiento, contrato, seguridad, alcance o aceptación, devuelve como máximo tres preguntas ordenadas por riesgo.
    - Las respuestas se convierten en un `PlanningBrief` `READY`; los supuestos solo pueden ser de riesgo bajo o medio. Este artefacto no genera Markdown.
    - Después genera `SpecCapsule` y `TaskGraph`; su Markdown visible se renderiza por script con cero tokens de autoría LLM.
    - Se muestra una explicación determinista de cinco líneas (`qué`, `por qué`, `cómo`, `prueba`) y se solicita aprobación. El agente no vuelve a parafrasearla.
4. **Implementación Quirúrgica:**
    - Carriles `fast`/`standard`: `mr-general` ejecuta cada tarea. En `fast` sin ticket, la misma sesión mantiene el plan breve y la implementación para reutilizar contexto; no se abre una segunda sesión de implementación.
    - Carriles `full`/`critical`: `mr-sdd-apply` ejecuta cada tarea con criterios SDD estrictos.
    - Cada `next-task` incorpora una nota ultracondensada `what/why/touch/prove` para que el developer entienda la intención, el alcance y cómo se demostrará sin añadir una explicación libre del modelo.
5. **Día del Juicio (solo carriles `full` y `critical`):**
    - `mr-judge-a` y `mr-judge-b` evalúan el diff en paralelo.
    - Cada hallazgo debe declarar severidad, archivo, línea, lado (`new`/`old`) y un fragmento textual exacto del diff. El plugin rechaza mecánicamente citas inexistentes o requisitos desconocidos.
    - Los dos veredictos quedan ligados al hash CAS del mismo diff; un cambio posterior invalida el juicio y los veredictos de rondas anteriores no se reutilizan.
    - Se fusiona el veredicto y `mr-fix` aplica únicamente hallazgos críticos validados.
6. **Compuerta de Finalización:**
   - Pregunta en la terminal: *"¿Damos por finalizada la tarea? (sí / no / otra)"*.
   - Si se indica *"no"* u *"otra"*, el ciclo continúa con ajustes.
   - Si se indica *"sí"*, se procede al cierre:
     - `git add .`
     - `git commit` analizando las convenciones de los últimos 30 commits (con firma GPG).
     - `git push` a la rama trabajada.
     - Pregunta final: *"¿Deseas crear la Pull Request en draft?"* (si se aprueba, crea la PR siguiendo la convención del repositorio).

---

### En Modo `build`:

#### `/propose + [prompt]`
Genera una propuesta técnica y arquitectónica completa.
- Tras cada respuesta, pregunta si la idea está suficientemente aterrizada.
- Si respondes *"no"*, continúa el refinamiento interactivo.
- Si respondes *"sí"*, compila mecánicamente la propuesta en un archivo Markdown dentro de `.aicontext/deliverables/mr/proposals/`.

#### `/prompt + [prompt]`
Herramienta de ingeniería de prompts interactiva:
- Aterriza y evoluciona tu idea hasta convertirla en un prompt avanzado y estructurado.
- Al confirmar que es lo que deseas, lo copia automáticamente al **portapapeles del sistema operativo** (`pbcopy`) para que puedas pegarlo donde necesites.

#### `/atlas [index|query <nombre>]`
Actúa como el cartógrafo y guardián del repositorio:
- **Cartografía e Indexación:** Mapea componentes, dependencias, símbolos, llamadas, contratos y relaciones de framework con extracción estática determinista. Reutiliza archivos sin cambios por hash y no gasta tokens de LLM.
- **Soporte multi-formato:** Cubre TypeScript/TSX, JavaScript/JSX, Java, PHP, Astro, CSS/SCSS y configuración JSON/YAML. Cada archivo declara `ok`, `partial`, `error` o `unsupported`; las salidas incluyen un recibo de cobertura en vez de fingir completitud.
- **Resolución de repositorios:** Entiende aliases de `tsconfig`, workspaces pnpm, PSR-4 y contratos entre repositorios. El Language Service de TypeScript y PHPStan/Psalm son enriquecimientos acotados y opcionales.
- **Fronteras y Gobernanza:** Establece las rutas prohibidas, anti-patrones y reglas operativas en `~/.cache/mr-orchestrator/<workspaceId>/governance.json`.
- **Persistencia Contextual:** El grafo se guarda bajo el directorio generado aislado del workspace y se actualiza automáticamente cuando la consulta detecta cambios.
- **Consultas disponibles:**
  - `/atlas query <nombre>` — Información de un nodo (tipo, ubicación, imports, exports).
  - `/atlas query <nombre> deps` — Dependencias directas del nodo.
  - `/atlas query <nombre> dependents` — Nodos que dependen de él.
  - `/atlas query <nombre> impact [depth]` — Análisis de impacto transitivo.
  - `/atlas query governance <filePath>` — Verificación de reglas de gobernanza.

#### `/trace + [componente]`
Forense y cirujano de código para React:
- Diagnostica renders infinitos, *stale closures*, dependencias omitidas en `useEffect`, fallos de hidratación SSR y condiciones de carrera.
- Navega directamente por los nodos del grafo de `/atlas` sin escanear carpetas completas ni desperdiciar tokens.
- Genera un parche mínimo y quirúrgico que respeta las normas de gobernanza.

#### `/flow-models`
Abre un flujo guiado dentro de la TUI de OpenCode mediante sus preguntas interactivas. Para cada proceso/step configura un modelo principal y su alternativa específica. Sin arnés explícito actualiza el baseline global; desde un bridge externo, `mr_models` recibe la identidad confiable del arnés y limita los cambios a su override. Para el editor directo y buscable usa `mr flow-models [--harness <id>]`. Reinicia las sesiones activas para aplicar la nueva asignación.

---

## 6. Herramientas Internas del Plugin (Tools `mr_*`)

Estas herramientas son invocadas internamente por los comandos y agentes, pero puedes llamarlas directamente desde la interfaz de OpenCode si necesitas operaciones atómicas.

### Herramientas de Flujo (`mr_flow_*`)

| Tool | Propósito |
|---|---|
| `mr_flow_status` | Obtiene el estado actual del flujo activo |
| `mr_flow_start` | Inicia un nuevo flujo (dificultad, ticketId, hasFigma) |
| `mr_flow_ticket` | Carga el contenido del ticket, precalienta Atlas y prefetch de Engram para el ticket |
| `mr_flow_memory_prefetch` | Refresca prefetch Engram + warm Atlas (automático tras `mr_flow_ticket`; manual solo si cambia el alcance) |
| `mr_flow_plan` | Somete el plan de implementación para aprobación |
| `mr_flow_implement` | Marca la implementación como completada |
| `mr_flow_judge` | Somete hallazgos estructurados; verifica archivo, línea, lado, snippet, requisito y hash del diff antes de aceptar el veredicto |
| `mr_flow_fix` | Marca las correcciones como aplicadas |
| `mr_flow_finish` | Finaliza el flujo con commit y PR opcional; persiste resumen compacto en Engram (`flow/<ticket>`) |
| `mr_flow_abort` | Aborta el flujo actual |

Cada estado incluye una línea de progreso tipo pedido:

```text
✓ Ticket  →  ✓ Research  →  ● Planning  →  ○ Implementation  →  ○ Review  →  ○ Delivery
```

También muestra el coste estimado por OpenCode, tokens de entrada/salida/razonamiento y uso de caché para las sesiones del coordinador y sus subagentes. Las actualizaciones repetidas del mismo mensaje se deduplican. El valor monetario proviene de la estimación de OpenCode basada en su catálogo de precios: no es una factura y puede ser `$0` cuando el proveedor o una suscripción no expone precio fiable. Tras cerrar el Flow, `/flow` status conserva el último total conocido. Los adaptadores MCP para clientes externos no reciben eventos de uso del host, por lo que allí el importe permanece en cero hasta que el cliente exponga esa telemetría.

### Herramientas SDD/RPI (`mr_sdd_*`)

Pipeline determinista de especificación y ejecución de tareas:

| Tool | Propósito |
|---|---|
| `mr_sdd_submit` | Sube una cápsula tipada (`research`, `brief`, `spec`, `tasks`) como JSON compacto. `brief=NEEDS_INPUT` devuelve 1-3 preguntas sin persistir; `brief=READY` persiste solo JSON. Las demás cápsulas renderizan Markdown por script sin coste de tokens. |
| `mr_sdd_get` | Lee cápsulas SDD como JSON compacto. `kind=brief` lee el Blueprint-lite aprobado; `kind=next-task` devuelve la siguiente tarea accionable, criterios de aceptación y `developerNote` ultracondensada. |
| `mr_sdd_task_status` | Marca el estado de una tarea (`pending`, `in_progress`, `done`, `blocked`). Solo marca `done` tras pasar los comandos de verificación. |
| `mr_sdd_verify` | Registra los resultados exigidos y guarda un recibo ligado al hash actual del diff. |
| `mr_evidence_add` / `mr_evidence_list` | Guarda slices direccionados por contenido y comparte sus referencias sin duplicar el archivo en cada prompt. |
| `mr_context_hydrate` | Construye el bundle mínimo para rol, tarea y carril; incluye `memoryContext` del prefetch Engram cuando existe; informa presupuesto, uso y truncamiento. |
| `mr_internal_receipt` | Valida el cierre de implementadores y fix como recibo tipado en inglés y devuelve JSON realmente minificado, sin prosa libre. |

**Flujo SDD/RPI típico:**
1. `mr_sdd_submit kind=research` — Cápsula de evidencia del explore (archivos, líneas, constraints).
2. `mr_sdd_submit kind=brief` — Auto-continúa con `READY` o solicita hasta tres decisiones materiales con `NEEDS_INPUT`; el brief es JSON-only.
3. `mr_sdd_submit kind=spec` — Especificación de requisitos R1..Rn con criterios de aceptación.
4. `mr_sdd_submit kind=tasks` — Grafo de tareas T1..Tn con dependencias, archivos, verify y doneWhen.
5. `mr_sdd_get kind=next-task` → implementar → `mr_sdd_task_status taskId done` (repetir).

### Grounding y evidencia insuficiente

- Todos los comandos y agentes reciben un contrato común: solo pueden usar tickets, cápsulas, resultados de tools, especificaciones y código/diffs inspeccionados.
- Cuando falta evidencia esencial deben detenerse con `{"status":"INSUFFICIENT_EVIDENCE","missing":[...],"nextAction":"..."}`. `mr_sdd_submit` y `mr_flow_judge` reconocen este resultado sin persistir datos inventados ni avanzar la FSM.
- En carriles `full`/`critical`, una tarea que modifica un archivo sin evidencia previa en ResearchCapsule es un error bloqueante. En `fast`/`standard` permanece como advertencia.
- Los agentes generados usan `temperature: 0` y `top_p: 1`. Esto reduce variabilidad, pero no promete repetibilidad absoluta entre proveedores.

### Presupuestos por carril

Los bundles de contexto usan límites en caracteres por rol y carril. `mr_flow_status` muestra la última hidratación como `usado/presupuesto`, junto con rol, carril y truncamiento.

| Carril | Plan | Implement | Cada juez | Fix |
|---|---:|---:|---:|---:|
| `fast` | 25k | 30k | 20k | 15k |
| `standard` | 37.5k | 45k | 30k | 22.5k |
| `full` | 50k | 60k | 40k | 30k |
| `critical` | 62.5k | 75k | 50k | 37.5k |

Un override positivo explícito sigue siendo válido y también queda reflejado en el recibo. El filtrado prioriza evidencia fresca de la tarea y reglas cuyo `appliesTo` coincide con sus archivos permitidos.

### Idioma y separación de artefactos

- La salida humana de Flow y Blueprint se renderiza en el `userLanguage` persistido: `es`, `en`, `pt`, `ca` o `fr`.
- Ante texto corto o ambiguo se conserva el idioma anterior; sin señal suficiente, el fallback es español.
- Prompts, contratos tipados, recibos y comunicación entre agentes permanecen en inglés. Los implementadores y fix cierran mediante `mr_internal_receipt`, que exige `language: "en"` y rechaza campos libres fuera del esquema.
- El transporte hacia modelos usa JSON sin indentación; los artefactos persistidos conservan formato legible. `next-task` incluye `ContextBundle` como objeto, sin doble serialización.
- Status, planes, veredictos, cobertura y Markdown presentado a la persona se generan mediante plantillas deterministas, no mediante traducción libre del modelo.

### Gates deterministas

El modo por defecto es fail-closed:

```bash
export MR_GATES_MODE=block
```

En `block`, Flow rechaza planes sin evidencia exigida, cambios fuera de límites, incumplimientos mecánicos de reglas, recibos ausentes u obsoletos y juicios ejecutados antes de reindexar el delta Atlas. Un valor desconocido también equivale a `block`.

Usa `warn` únicamente como escape temporal para diagnóstico o migración:

```bash
export MR_GATES_MODE=warn
```

### Herramientas Atlas (`mr_atlas_*`)

| Tool | Propósito |
|---|---|
| `mr_atlas_index` | Actualiza el grafo incremental y devuelve estadísticas más un recibo honesto de cobertura. |
| `mr_atlas_query` | Consulta nodos, deps, dependents, impacto ponderado y governance; cada resultado declara cobertura. |
| `mr_atlas_skeleton` | Genera skeletons deterministas con profundidad configurable: imports, firmas, llamadas y metadatos relevantes con cuerpos elididos. |

### Otras Herramientas

| Tool | Propósito |
|---|---|
| `mr_trace_component` | Análisis forense React de un componente específico |
| `mr_propose_save` | Guarda una propuesta técnica en `.aicontext/deliverables/mr/proposals/` |
| `mr_prompt_build` | Construye un prompt desde una plantilla (bugfix, feature, refactor, review) |
| `mr_prompt_copy` | Copia texto al portapapeles del SO |
| `mr_models` | Lista, valida o modifica el roster global o el override del arnés que inyecta el bridge |

---

## 7. Personalización de Modelos de Inteligencia Artificial

Los modelos asociados a cada rol están tipados. El baseline completo vive en:

```text
~/.config/mr-orchestrator/models.json
```

Ejemplo de configuración:

```json
{
  "schemaVersion": 1,
  "roles": {
    "general": {
      "model": "openai/gpt-5.6-sol",
      "variant": "high",
      "alternative": { "model": "opencode-go/deepseek-v4-pro", "variant": "high" }
    },
    "judgeA": {
      "model": "opencode-go/deepseek-v4-pro",
      "variant": "max",
      "alternative": { "model": "openai/gpt-5.6-sol", "variant": "high" }
    },
    "judgeB": {
      "model": "opencode-go/kimi-k2.7-code",
      "alternative": { "model": "openai/gpt-5.6-sol", "variant": "high" }
    }
  }
}
```

Cada arnés puede guardar un override **parcial** y un catálogo independiente:

```text
~/.config/mr-orchestrator/harnesses/<harness-id>/models.json
~/.config/mr-orchestrator/harnesses/<harness-id>/catalog.json
~/.config/mr-orchestrator/generated/harnesses/<harness-id>/effective-models.json
```

La resolución siempre aplica `models.json` global → override parcial → validación y traducción del catálogo. Un target incluye modelo y variante como unidad atómica: si cambias el modelo sin pasar `--variant`, no se conserva implícitamente la variante del target sustituido.

Ejemplo de catálogo explícito para un arnés externo:

```json
{
  "schemaVersion": 1,
  "harness": "cursor",
  "applicationMode": "per-invocation",
  "provenance": { "source": "explicit" },
  "models": {
    "openai/gpt-5.6-sol": {
      "nativeModel": "openai/gpt-5.6-sol",
      "variants": ["high"]
    }
  }
}
```

OpenCode conserva el catálogo legado si todavía no existe `harnesses/opencode/catalog.json`. Los demás arneses fallan antes del despacho cuando falta su catálogo o un modelo/variante no está soportado. Los modos gestionados y verificados son `opencode=native-role` y `codex|cursor|claude|agy|fx=per-invocation`; un catálogo que declare otro modo se rechaza. Antigravity permanece sin aplicación heterogénea verificada y falla de forma cerrada en vez de fingir soporte.

Codex, Cursor Agent, Claude Code, AGY y fx usan aplicación `per-invocation`: sus adaptadores ejecutan cada pase aislado mediante `mr-clients run-role <arnés> <rol> -- <prompt>`. El runner vuelve a resolver y validar las fuentes globales/del arnés y lanza la CLI del host con su modelo y variante nativos (`codex exec`, `agent --print`, `claude --print`, `agy --print` o `fx ask`); no toma el artefacto generado como fuente, ni depende del modelo de la sesión padre o de archivos del workspace.

Ante `429 insufficient_quota` o `quota_exceeded`, el plugin promueve automáticamente `alternative.model` a `model` para ese rol y conserva el principal fallido como nueva alternativa. Si la ejecución pertenece a un arnés externo, la promoción solo modifica su override; nunca reescribe el baseline global. La unidad activa queda persistida, pero no se repite automáticamente para evitar duplicar efectos. Reinicia el cliente y reanuda la tarea.

*Nota: cualquier cambio manual debe validarse con `mr models validate --harness <id>`. Para OpenCode, `mr sync` regenera las definiciones de sus workspaces con el roster efectivo, pero el workspace no se convierte en ámbito de configuración.*

---

## 8. Troubleshooting

### Error: "mr_atlas_index / mr_atlas_query tools not found" o "MCP server not available"

**Causa:** Ejecutaste `/atlas` (o cualquier comando que use tools `mr_*`) desde un directorio que **no está registrado** como workspace en `mr-orchestrator`.

**Solución:**
```bash
# Verifica workspaces registrados
mr workspace list

# Registra el workspace actual si no aparece
mr workspace add /ruta/absoluta/a/tu/workspace

# O navega a un workspace registrado y usa mrcode
cd ~/Projects/my-workspace
mrcode
```

**Explicación técnica:** Los tools `mr_*` son registrados por el plugin `mr-orchestrator` de OpenCode, que solo se carga cuando `mrcode` detecta que el cwd está dentro de un workspace registrado (via `~/.config/mr-orchestrator/workspaces.json`).

### El grafo Atlas parece desactualizado

**Causa:** El grafo Atlas aislado del workspace fue generado antes de tus últimos cambios.

**Solución:**
```bash
# Desde dentro del workspace:
mr atlas index
```

### `/flow` no aparece o no encuentra sus tools

**Causa:** El workspace no está registrado o la configuración generada es anterior a la instalación actual.

**Solución:** Ejecuta `mr workspace add <ruta>` si corresponde, luego `mr sync` y reinicia OpenCode. No cambies manualmente a `Orchestrator`: `/flow` ya declara ese agente internamente.

### Modifiqué `.aicontext` y no veo los cambios

**Causa:** `mr-orchestrator` compila la convención en memoria cacheada por hash.

**Solución:** Ejecuta `mr sync` para recalcular las convenciones sin mutar tu repositorio git.

---

## 9. Preguntas Frecuentes

**¿Tengo que cambiar al modo `Orchestrator` para ejecutar `/flow`?**
No. `build` es el agente predeterminado y `/flow` especifica `agent: orchestrator` en su definición. OpenCode ejecuta ese comando con el coordinador adecuado automáticamente.

**¿Qué pasa si modifico los archivos de `.aicontext` del workspace?**
`mr-orchestrator` compila la convención en memoria cacheada por hash. Cuando ejecutas `mr sync` o inicias un nuevo `/flow`, se recalculan las convenciones sin mutar tu repositorio git.

**¿Atlas indexa código Java de microservicios Spring Boot?**
Sí. Atlas cubre Java y configuración JSON/YAML, incluidos perfiles Spring multi-documento. También cubre TypeScript/TSX, JavaScript/JSX, PHP, Astro y CSS/SCSS, declarando cobertura parcial o no soportada cuando corresponde.

**¿Cómo ahorro tokens al consultar código?**
Usa `/atlas query` para consultas puntuales en lugar de leer archivos completos. Usa `mr_atlas_skeleton` para obtener la estructura de un archivo (imports + firmas) con ~85-90% menos tokens que el contenido completo.

**¿Dónde se guardan los artefactos SDD?**
Los JSON tipados se guardan en `~/.local/share/mr-orchestrator/<workspaceId>/sdd/`. El Markdown renderizado para el usuario se genera en `.aicontext/deliverables/mr/sdd/` dentro del workspace (si existe `.aicontext`) o en el directorio de datos global.

---

## 10. Medición del corpus de fiabilidad

`bench/corpus.json` contiene 15 journeys anonimizados. Una ejecución solo cuenta cuando existen métricas y eventos reales capturados por Flow:

```bash
bun scripts/bench-report.ts \
  --journey J01 \
  --metrics /ruta/flow-metrics.json \
  --events /ruta/events.jsonl \
  --one-shot \
  --language-compliant true
```

Consulta `bench/README.md` antes de guardar un resultado. Los tests, fixtures sintéticos y reportes con cero journeys validan la instrumentación, pero no demuestran ejecución dirigida por un modelo. Un reporte posterior debe compararse con una baseline observacional real y documentar cualquier objetivo que no se alcance.
