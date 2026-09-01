# Manual de Uso de mr-orchestrator

Esta guía explica en detalle cómo operar con `mr-orchestrator`, cómo interactuar con los comandos en los diferentes modos (`Orchestrator` y `build`), y cómo sacar el máximo provecho de sus capacidades de orquestación y ahorro de tokens.

---

## 1. Conceptos Fundamentales

- **`mr` (CLI Administrativo):** Herramienta de línea de comandos para gestionar la instalación, configuración de workspaces, diagnósticos y modelos.
- **`mrcode` (Lanzador de OpenCode):** Wrapper inteligente que detecta en qué workspace te encuentras (inspeccionando el directorio de trabajo actual y sus ancestros) y arranca `opencode` inyectando la configuración compilada adecuada.
- **Modos de Agente:**
  - Modo `Orchestrator`: Modo primario enfocado en la orquestación integral de tareas y entrega de tickets mediante `/flow`.
  - Modo `build`: Modo de desarrollo y asistencia donde se ejecutan los comandos técnicos especializados (`/atlas`, `/trace`, `/propose`, `/prompt`).

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
Abre el selector buscable de modelos disponibles en OpenCode. Permite recorrer todos los procesos/steps, cambiar uno, aplicar un preset o actualizar el catálogo. Los cambios se guardan de una vez y sincronizan todos los workspaces:
```bash
mr flow-models
```
`mr models` es un alias equivalente para la UI interactiva.
Otras operaciones CLI directas para modelos:
- `mr models list`: Muestra la matriz completa de roles, modelos asignados y estado de recomendación.
- `mr models set <rol> <modelo>`: Asigna un modelo a un rol específico (ej: `mr models set orchestrator github-copilot/gpt-5.6-sol`).
- `mr models preset <nombre>`: Aplica un conjunto preconfigurado (`balanced`, `gpt-sol`, `claude-opus`).

---

## 3. Lanzamiento del Entorno (`mrcode`)

Navega a cualquier carpeta de tu proyecto registrado (por ejemplo, dentro de un microservicio o una SPA) y ejecuta:

```bash
cd ~/Projects/my-workspace/apps/api
mrcode
```

`mrcode` detectará automáticamente el workspace registrado y lanzará la interfaz TUI de OpenCode configurada con el modo `Orchestrator`.

---

## 4. Modos y Roster de Agentes

| Agente / Rol | Modo | Permisos | Propósito |
|---|---|---|---|
| `orchestrator` | Primary | Control de flujo y preguntas | Orquestador principal. Es el **único** agente donde se permite ejecutar `/flow`. |
| `mr-explore` | Subagent | Solo lectura (`edit: deny`, `bash: deny`) | Mapeo rápido de archivos, lectura de código y consultas al grafo de Atlas. |
| `mr-plan` | Subagent | Solo lectura (`edit: deny`, `bash: deny`) | Planificación estructurada en formato JSON combinando SDD + RPI. |
| `mr-general` | Subagent | Edición y bash controlados | Implementación quirúrgica de tareas delimitadas en el código fuente. |
| `mr-sdd-apply` | Subagent | Edición y bash controlados | Aplicación de cambios bajo metodología SDD con verificación. |
| `mr-judge-a` | Subagent | Solo lectura (`edit: deny`, `bash: deny`) | Primer revisor ciego adversarial del diff generado. |
| `mr-judge-b` | Subagent | Solo lectura (`edit: deny`, `bash: deny`) | Segundo revisor ciego adversarial independiente. |
| `mr-fix` | Subagent | Edición y bash controlados | Aplica exclusivamente las correcciones indicadas en el veredicto fusionado. |

---

## 5. Comandos de Trabajo

### En Modo `Orchestrator`:

#### `/flow + [prompt]`
Ejecuta el ciclo de vida completo de un requerimiento o ticket de forma controlada y determinista.

**Paso a paso del flujo:**
1. **Wizard Inicial:**
   - **Dificultad (Fibonacci: 1, 3, 5, 8, ...):**
     - Si es **1 o 3 (Lite):** No se ejecuta la fase de juicio adversarial (`judge-a` vs `judge-b`) ni `mr-fix`, agilizando tareas pequeñas o de bajo riesgo.
     - Si es **5 en adelante (Full):** Se activa el pipeline completo con juicio ciego paralelo y corrección iterativa.
   - **Identificador de Ticket:** Pregunta la clave del ticket (ej: `123`, `GH-42`, `PROJ-105`). La primera vez pregunta el sistema de tickets (GitHub / Jira / GitLab) y lo recuerda permanentemente para ese workspace.
   - **Diseño en Figma:** Pregunta si existe diseño. Si se indica afirmativamente, consulta vía MCP y guarda la respuesta en caché local para evitar re-consultas.
2. **Descarga y Sincronización:**
   - Realiza un `git pull` de la rama base más reciente (`develop` o la default branch).
   - Genera la rama correspondiente siguiendo la receta de convención del workspace (ej: `feature/GH-123-slug` o `bugfix/GH-123-slug`) con una **única confirmación** del usuario.
3. **Exploración y Planificación (SDD + RPI):**
   - `mr-explore` mapea dependencias con Atlas y Engram.
   - `mr-plan` genera una cápsula JSON de plan determinista.
   - Se muestra el plan y se solicita aprobación al usuario.
4. **Implementación Quirúrgica:**
   - `mr-general` o `mr-sdd-apply` ejecutan la tarea paso a paso con verificaciones intermedias.
5. **Día del Juicio (solo dificultad >= 5):**
   - `mr-judge-a` y `mr-judge-b` evalúan el diff en paralelo.
   - Se fusiona el veredicto y `mr-fix` aplica parches si existen observaciones críticas.
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
- **Cartografía e Indexación:** Mapea componentes, dependencias y relaciones mediante un indexador estático determinista basado en **tree-sitter** (TypeScript/TSX, Java) y parsers YAML/JSON para configuración. No gasta tokens de LLM.
- **Soporte multi-formato:** Indexa código fuente (`.ts`, `.tsx`, `.java`) y archivos de configuración (`.json`, `.yml`, `.yaml`) incluyendo perfiles Spring multi-documento (`---`) y JSONC con comentarios.
- **Fronteras y Gobernanza:** Establece las rutas prohibidas, anti-patrones y reglas operativas en `~/.cache/mr-orchestrator/<workspaceId>/governance.json`.
- **Caché Contextual:** El grafo indexado se persiste en `~/.cache/mr-orchestrator/<workspaceId>/atlas-graph.json` y se reutiliza automáticamente (lazy-index si no existe).
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
Abre un flujo guiado dentro de la TUI de OpenCode mediante sus preguntas interactivas. Primero selecciona el proceso/step, después el proveedor y el modelo disponible; la elección actualiza `models.json`, las definiciones globales y todos los workspaces registrados. Para el editor directo, buscable y sin intervención del modelo usa `mr flow-models`. Reinicia las sesiones activas para aplicar la nueva asignación.

---

## 6. Herramientas Internas del Plugin (Tools `mr_*`)

Estas herramientas son invocadas internamente por los comandos y agentes, pero puedes llamarlas directamente desde la interfaz de OpenCode si necesitas operaciones atómicas.

### Herramientas de Flujo (`mr_flow_*`)

| Tool | Propósito |
|---|---|
| `mr_flow_status` | Obtiene el estado actual del flujo activo |
| `mr_flow_start` | Inicia un nuevo flujo (dificultad, ticketId, hasFigma) |
| `mr_flow_ticket` | Carga el contenido del ticket en el flujo |
| `mr_flow_plan` | Somete el plan de implementación para aprobación |
| `mr_flow_implement` | Marca la implementación como completada |
| `mr_flow_judge` | Somete el veredicto de un juez para el diff actual |
| `mr_flow_fix` | Marca las correcciones como aplicadas |
| `mr_flow_finish` | Finaliza el flujo con commit y PR opcional |
| `mr_flow_abort` | Aborta el flujo actual |

### Herramientas SDD/RPI (`mr_sdd_*`)

Pipeline determinista de especificación y ejecución de tareas:

| Tool | Propósito |
|---|---|
| `mr_sdd_submit` | Sube una cápsula tipada (research, spec, tasks) como JSON compacto. Valida con Zod + guardrails estructurales. Renderiza Markdown por script sin coste de tokens. |
| `mr_sdd_get` | Lee cápsulas SDD como JSON compacto. `kind=next-task` devuelve la siguiente tarea accionable con criterios de aceptación pre-unidos. |
| `mr_sdd_task_status` | Marca el estado de una tarea (`pending`, `in_progress`, `done`, `blocked`). Solo marca `done` tras pasar los comandos de verificación. |

**Flujo SDD/RPI típico:**
1. `mr_sdd_submit kind=research` — Cápsula de evidencia del explore (archivos, líneas, constraints).
2. `mr_sdd_submit kind=spec` — Especificación de requisitos R1..Rn con criterios de aceptación.
3. `mr_sdd_submit kind=tasks` — Grafo de tareas T1..Tn con dependencias, archivos, verify y doneWhen.
4. `mr_sdd_get kind=next-task` → implementar → `mr_sdd_task_status taskId done` (repetir).

### Herramientas Atlas (`mr_atlas_*`)

| Tool | Propósito |
|---|---|
| `mr_atlas_index` | Indexa código fuente (TS/TSX/Java) y configuración (JSON/YML/YAML) en el grafo Atlas. Persiste en caché XDG. |
| `mr_atlas_query` | Consulta el grafo: info de nodos, deps, dependents, impact, governance. Soporta filtros por tipo de nodo. |
| `mr_atlas_skeleton` | **Nuevo.** Genera skeleton determinista de un archivo: imports + firmas, cuerpos elididos (~85-90% menos tokens). Ideal para leer `application.yml`, OpenAPI specs o clases Java grandes. |

### Otras Herramientas

| Tool | Propósito |
|---|---|
| `mr_trace_component` | Análisis forense React de un componente específico |
| `mr_propose_save` | Guarda una propuesta técnica en `.aicontext/deliverables/mr/proposals/` |
| `mr_prompt_build` | Construye un prompt desde una plantilla (bugfix, feature, refactor, review) |
| `mr_prompt_copy` | Copia texto al portapapeles del SO |
| `mr_models` | Muestra el roster de modelos actual |

---

## 7. Personalización de Modelos de Inteligencia Artificial

Los modelos asociados a cada rol están tipados y pueden modificarse en el archivo de configuración global:

```text
~/.config/mr-orchestrator/models.json
```

Ejemplo de configuración:

```json
{
  "schemaVersion": 1,
  "roles": {
    "orchestrator": "github-copilot/gpt-5.6-sol",
    "explore": "github-copilot/gpt-5.6-sol",
    "plan": "github-copilot/gpt-5.6-sol",
    "general": "github-copilot/gpt-5.6-sol",
    "sddApply": "github-copilot/gpt-5.6-sol",
    "judgeA": "github-copilot/gpt-5.6-sol",
    "judgeB": "github-copilot/gpt-5.6-sol",
    "fix": "github-copilot/gpt-5.6-sol"
  }
}
```

*Nota: Cualquier cambio en `models.json` se aplica al workspace ejecutando `mr sync`.*

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

**Causa:** El caché de Atlas en `~/.cache/mr-orchestrator/<workspaceId>/atlas-graph.json` fue generado antes de tus últimos cambios.

**Solución:**
```bash
# Desde dentro del workspace en OpenCode:
/atlas index
```

O borra el caché para forzar re-indexado en la próxima consulta:
```bash
rm ~/.cache/mr-orchestrator/<workspaceId>/atlas-graph.json
```

### `/flow` no funciona en modo `build`

**Causa:** Por diseño y seguridad, `/flow` requiere el control estricto de la máquina de estados y las compuertas interactivas del modo `Orchestrator`.

**Solución:** Cambia al modo `Orchestrator` en la TUI de OpenCode, o ejecuta `mrcode` que lo configura por defecto.

### Modifiqué `.aicontext` y no veo los cambios

**Causa:** `mr-orchestrator` compila la convención en memoria cacheada por hash.

**Solución:** Ejecuta `mr sync` para recalcular las convenciones sin mutar tu repositorio git.

---

## 9. Preguntas Frecuentes

**¿Por qué `/flow` no funciona en modo `build`?**
Por diseño y seguridad, `/flow` requiere el control estricto de la máquina de estados y las compuertas interactivas del modo `Orchestrator`. El guard interno rechaza la ejecución de `/flow` fuera de su modo correspondiente.

**¿Qué pasa si modifico los archivos de `.aicontext` del workspace?**
`mr-orchestrator` compila la convención en memoria cacheada por hash. Cuando ejecutas `mr sync` o inicias un nuevo `/flow`, se recalculan las convenciones sin mutar tu repositorio git.

**¿Atlas indexa código Java de microservicios Spring Boot?**
Sí. Atlas usa tree-sitter con gramáticas para TypeScript/TSX y Java. Además indexa archivos de configuración JSON/YAML (incluyendo perfiles Spring multi-documento separados por `---`).

**¿Cómo ahorro tokens al consultar código?**
Usa `/atlas query` para consultas puntuales en lugar de leer archivos completos. Usa `mr_atlas_skeleton` para obtener la estructura de un archivo (imports + firmas) con ~85-90% menos tokens que el contenido completo.

**¿Dónde se guardan los artefactos SDD?**
Los JSON tipados se guardan en `~/.local/share/mr-orchestrator/<workspaceId>/sdd/`. El Markdown renderizado para el usuario se genera en `.aicontext/deliverables/mr/sdd/` dentro del workspace (si existe `.aicontext`) o en el directorio de datos global.
