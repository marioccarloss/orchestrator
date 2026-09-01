# Manual de Arquitectura y Desarrollo de mr-orchestrator

Este documento sirve como guía técnica integral sobre el diseño, arquitectura, estándares de código, ciclo de desarrollo y hoja de ruta de `mr-orchestrator`.

---

## 1. Filosofía Arquitectónica

### "El plugin es el orquestador; el LLM es el ejecutor"
Tradicionalmente, los frameworks de agentes delegan la lógica de control, los bucles de transición y la gestión de archivos al razonamiento probabilístico del LLM. Esto introduce **indeterminismo**, riesgo de alucinación y un consumo desmedido de tokens.

`mr-orchestrator` invierte esta relación:
- **La Máquina de Estados Finitos (FSM) es código TypeScript determinista:** Los estados, eventos, guardas y transiciones están modelados mediante *discriminated unions* exhaustivas.
- **Validación estricta por schema (Zod):** Todo estado, cápsula de plan, resultado de revisión o veredicto se valida contra esquemas Zod con control estricto de versión (`schemaVersion`).
- **Cero Markdown generado por el LLM en la orquestación:** El LLM produce únicamente objetos JSON tipados. La transformación a Markdown (propuestas, especificaciones, planes, checklists de tareas) es realizada por un motor de render determinista (`mr render`) en CLI puro con **cero coste de tokens**.
- **Aislamiento absoluto del workspace:** Toda configuración compilada vive bajo los estándares XDG del usuario (`~/.config/mr-orchestrator/`), nunca en el árbol git del proyecto destino.

---

## 2. Stack Tecnológico y Estándares de Tipado

- **Runtime & Toolchain:** Bun (v1.2.21 fijada) en modo aislado.
- **Lenguaje:** TypeScript 5.9+ en modo ultra-estricto:
  - `strict: true`
  - `noUncheckedIndexedAccess: true` (fuerza chequeo de `undefined` en accesos a índices y diccionarios)
  - `exactOptionalPropertyTypes: true` (diferencia entre propiedad ausente y `undefined`)
  - `noImplicitOverride: true`, `noImplicitReturns: true`, `noFallthroughCasesInSwitch: true`
  - `verbatimModuleSyntax: true`
- **Parsing e Indexación:** tree-sitter (web-tree-sitter + tree-sitter-typescript + tree-sitter-java) para análisis estático de código; `yaml` para parsing de configuración multi-documento.
- **Validación de Datos en Runtime:** Zod 4+
- **Linter & Análisis Estático:** ESLint 9+ con `@typescript-eslint` y reglas `strictTypeChecked` y `stylisticTypeChecked`.
- **UI de Terminal:** `@clack/prompts` para experiencias CLI limpias e interactivas.
- **Suite de Pruebas:** `bun test` nativo.

---

## 3. Estructura del Código Fuente

```text
~/Projects/mr-orchestrator/
├── install.sh                  # Bootstrap POSIX autónomo (instala Bun aislado + compila + registra)
├── package.json                # Configuración de dependencias, scripts y binarios
├── tsconfig.json               # Configuración TypeScript estricta
├── tsconfig.build.json         # Configuración para emitir JS y .d.ts a dist/
├── eslint.config.mjs           # Reglas de linting type-aware
├── models.json                 # Catálogo semilla de modelos por rol
├── src/
│   ├── cli.ts                  # Punto de entrada CLI (mr) y dispatch de comandos
│   ├── plugin.ts               # Plugin nativo de OpenCode (command guards + tools mr_flow_*)
│   ├── core/
│   │   ├── paths.ts            # Resolución de rutas canónicas XDG y herramientas
│   │   ├── files.ts            # Utilidades de escritura atómica (tmp->rename), JSON canónico y SHA-256
│   │   ├── schema.ts           # Esquemas Zod: Workspaces, ModelMap, Manifest, etc.
│   │   ├── flow-schema.ts      # FSM Core: FlowState, FlowEvent, PlanCapsule, Verdicts, Migrations
│   │   ├── flow-state.ts       # Persistencia y transiciones del estado de flujo
│   │   ├── sdd-schema.ts       # Esquemas Zod para cápsulas SDD/RPI: ResearchCapsule, SpecCapsule, TaskGraph
│   │   ├── render.ts           # Render determinista a Markdown (planes, status, veredictos)
│   │   ├── ticket.ts           # Puerto y adaptadores de tickets (GitHub, Jira, GitLab, ask-once)
│   │   ├── git.ts              # Resolutor de convenciones git, generación de ramas y PR ports
│   │   ├── judgment.ts         # Día del Juicio: fusión de veredictos, diff hash, fix loop acotado
│   │   ├── atlas.ts            # Cartógrafo: indexador tree-sitter (TS/TSX/Java), parser YAML/JSON, grafo de dependencias, gobernanza
│   │   ├── tools.ts            # Herramientas /trace (React), /propose (MD) y /prompt (clipboard)
│   │   ├── figma.ts            # Integración Figma MCP, caché local con TTL y harness de tests E2E
│   │   ├── lifecycle.ts        # Backup, restore, plan de update, rollback, export/import perfil
│   │   ├── workspace.ts        # Registro y algoritmo de detección por longest-prefix
│   │   ├── config.ts           # Compilador determinista de opencode.mr.json y sincronización
│   │   ├── install.ts          # Motor de instalación idempotente y desinstalación basada en manifest
│   │   ├── doctor.ts           # Diagnóstico de prerequisitos y consistencia de entorno
│   │   ├── launch.ts           # Lanzador de OpenCode con inyección de OPENCODE_CONFIG
│   │   ├── models.ts           # Gestión de roles, modelos, presets e interactividad
│   │   └── process.ts          # Ejecución segura de subprocesos sincrónicos e interactivos
│   └── tui/
│       ├── index.ts            # Abstracciones sobre @clack/prompts para mensajes, intro/outro
│       └── models.ts           # TUI interactivo para selección y customización de modelos
├── tests/                      # Suite de pruebas unitarias y de integración
│   ├── atlas.test.ts
│   ├── config.test.ts
│   ├── figma.test.ts
│   ├── flow-schema.test.ts
│   ├── flow-state.test.ts
│   ├── git.test.ts
│   ├── install.test.ts
│   ├── judgment.test.ts
│   ├── launch.test.ts
│   ├── lifecycle.test.ts
│   ├── models.test.ts
│   ├── plugin.test.ts
│   ├── process.test.ts
│   ├── render.test.ts
│   ├── schema.test.ts
│   ├── sdd-schema.test.ts
│   ├── ticket.test.ts
│   ├── tools.test.ts
│   └── workspace.test.ts
└── docs/                       # Documentación técnica completa
    ├── INSTALLATION.md
    ├── DEVELOPMENT.md
    ├── USAGE.md
    └── TRANSFER_MACBOOK_AIR.md
```

---

## 4. Arquitectura Hexagonal y Puertos del Orquestador

Para garantizar que `mr-orchestrator` sea verdaderamente global e interoperable con cualquier entorno de ticketing y control de versiones, se utiliza una arquitectura de Puertos y Adaptadores:

```text
┌────────────────────────────────────────────────────────┐
│                   mr-orchestrator                      │
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │                    Core FSM                      │  │
│  │    INIT ──> WIZARD ──> CONTEXT ──> EXPLORE...   │  │
│  └─────────────┬──────────────────────┬─────────────┘  │
│                │                      │                │
│       ┌────────▼────────┐    ┌────────▼────────┐       │
│       │   TicketPort    │    │     PrPort      │       │
│       └────────┬────────┘    └────────┬────────┘       │
└────────────────┼──────────────────────┼────────────────┘
                 │                      │
       ┌─────────┴─────────┐  ┌─────────┴─────────┐
       ▼                   ▼  ▼                   ▼
GitHub MCP Adapter    Jira Adapter          GitLab Stub
```

### Puertos Clave:
1. **`TicketPort`**: Normaliza cualquier ticket (GitHub Issue, Jira Issue, GitLab Issue) a una estructura tipada `TicketRef` + `TicketContent` (título, descripción, tipo, adjuntos).
2. **`PrPort`**: Normaliza la creación de Pull Requests (título, cuerpo de relaciones, rama base, modo draft).
3. **`GitConventionResolver`**: Lee la carpeta `.aicontext/` del workspace para extraer convenciones de ramas (`feature/GH-<id>-slug`), commits (`feat: ...` con firma GPG) y ramas base (`develop` vs `main`).

---

## 5. Pipeline SDD + RPI (Spec-Driven Development + Research-Plan-Implement)

`mr-orchestrator` implementa un pipeline determinista donde la IA solo produce y consume **cápsulas JSON tipadas**, nunca Markdown libre:

```text
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   EXPLORE   │────>│    PLAN     │────>│  IMPLEMENT  │────>│    JUDGE    │
│  (Research) │     │(Spec+Tasks) │     │  (Execute)  │     │  (Review)   │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
       │                   │                   │                   │
       ▼                   ▼                   ▼                   ▼
  ResearchCapsule     SpecCapsule        TaskGraph           Verdicts
  (evidencias)        (requisitos)       (tareas)            (A/B fusionados)
```

### Cápsulas SDD/RPI

| Cápsula | Esquema Zod | Contenido | Renderizado |
|---|---|---|---|
| `ResearchCapsule` | `ResearchCapsuleSchema` | Evidencias (archivo:línea), constraints, unknowns | `renderResearchCapsule` |
| `SpecCapsule` | `SpecCapsuleSchema` | Requisitos R1..Rn con criterios de aceptación | `renderSpecCapsule` |
| `TaskGraph` | `TaskGraphSchema` | Tareas T1..Tn con `dependsOn`, `files`, `verify`, `doneWhen` | `renderTaskGraph` |

### Guardrails Estructurales

Antes de aceptar una cápsula `TaskGraph`, el sistema valida:
- **Cobertura de requisitos:** Cada R1..Rn debe estar cubierto por al menos una tarea.
- **Aciclicidad:** El grafo de dependencias `dependsOn` no puede tener ciclos.
- **Requisitos conocidos:** Las tareas solo pueden referenciar requisitos definidos en el `SpecCapsule`.

### Herramientas `mr_sdd_*`

- **`mr_sdd_submit`:** Valida y persiste cápsulas. En éxito, renderiza Markdown por script (cero tokens de LLM) y devuelve un ack compacto. En fallo, devuelve los issues exactos de Zod para corrección.
- **`mr_sdd_get`:** Lee cápsulas como JSON compacto. `kind=next-task` devuelve la siguiente tarea accionable con sus criterios de aceptación pre-unidos — el briefing exacto para implementar.
- **`mr_sdd_task_status`:** Progresión determinista de estados. Solo marca `done` tras pasar los comandos `verify` de la tarea.

---

## 6. Estrategia de Ahorro y Optimización de Tokens

1. **Indexador propio de Atlas (tree-sitter):** No consume tokens de LLM para indexar. Un proceso local basado en tree-sitter genera el grafo de componentes, dependencias y module federation para TypeScript/TSX y Java. Además, un parser YAML/JSON dedicado indexa archivos de configuración (perfiles Spring, OpenAPI, tsconfig). La IA solo consume consultas quirúrgicas (`mr_atlas_query`, `mr_atlas_skeleton`).
2. **Caché en disco con TTL y Hash:** Los esquemas de Figma y el contenido de tickets se descargan una sola vez a `.cache/` local.
3. **Persistencia Engram en fronteras:** Las decisiones se graban en Engram exclusivamente al finalizar fases clave (e.g. fin de Plan, fin de Implementación), evitando la sobrecarga de llamadas continuas a memoria.
4. **Skeletons deterministas (`mr_atlas_skeleton`):** Extrae imports y firmas de archivos fuente (TS/TSX/Java) o estructura de claves de configs (JSON/YAML) con cuerpos elididos, reduciendo el consumo de tokens en un 85-90% frente a la lectura completa.

---

## 7. Ciclo de Desarrollo y Comandos Útiles

Dentro de `~/Projects/mr-orchestrator`:

```bash
# Instalar dependencias con Bun
bun install

# Compilar TypeScript a JavaScript en dist/
bun run build

# Chequeo estático de tipos
bun run typecheck

# Linting con reglas type-checked
bun run lint

# Ejecutar todos los tests
bun test

# Ejecutar la suite completa de calidad (typecheck + lint + tests)
bun run check
```

---

## 8. Hoja de Ruta (Roadmap de Fases)

| Fase | Título | Estado | Descripción |
|---|---|---|---|
| **F0** | **Scaffold, Toolchain & Launcher** | ✅ Completado | Repositorio independiente, Bun aislado, registry de workspaces, `mr install/uninstall` con manifest, launcher `mrcode` y `mr doctor`. |
| **F1** | **FSM Core, Schemas & Render** | ✅ Completado | Modelado de estados de `/flow` (`FlowStateSchema`), esquemas Zod de `PlanCapsule`, framework de migraciones con versionado (`MigrationRegistry`) y motor de render determinista a Markdown (`renderPlanCapsule`, `renderFlowStatus`, `renderVerdict`). |
| **F2** | **OpenCode Plugin & Guardias** | ✅ Completado | Plugin nativo TypeScript (`@opencode-ai/plugin`), guard `command.execute.before` para control estricto de modos (`Orchestrator` vs `build`), 9 herramientas `mr_flow_*` y TUI interactivo `mr models`. |
| **F3** | **`/flow` Lite & Adapters** | ✅ Completado | Flujo completo de dificultad 1-3 con arquitectura hexagonal (`TicketPort`, `PrPort`, `GitConventionResolver`), adaptadores GitHub/Jira/GitLab, ask-once de plataforma y generación determinista de ramas/commits. |
| **F4** | **Judgment Day (Jueces A/B)** | ✅ Completado | Flujo de dificultad 5+ con revisión adversarial paralela (`mr-judge-a` vs `mr-judge-b`), fusión estricta de veredictos (`mergeVerdicts`), y bucle de corrección acotado (`FixLoopState`) con escalado a humano tras 3 intentos. |
| **F5** | **Cartógrafo `/atlas`** | ✅ Completado | Indexador determinista con **tree-sitter** (TypeScript/TSX y Java) y parser YAML/JSON sobre repositorios frontend/backend, grafo JSON con nodos y aristas, análisis de impacto (`getImpactAnalysis`), `governance.json` y persistencia en caché XDG. |
| **F6** | **`/trace`, `/propose` y `/prompt`** | ✅ Completado | Diagnóstico quirúrgico React (`traceComponent`) con navegación por el grafo de Atlas, propuestas técnicas a Markdown (`saveProposal`) y generador de prompts con plantillas y copiado al portapapeles (`pbcopy`/`xclip`). |
| **F7** | **MCP Figma & Hardening E2E** | ✅ Completado | Adaptador MCP Figma (`FigmaMcpAdapter`) con caché local basada en hash SHA-256 y TTL (`FigmaCache`), más harness de pruebas E2E automatizadas (`runE2ETest`, `runE2ESuite`). |
| **F8** | **Lifecycle Global & Multi-platform** | ✅ Completado | Gestión de backups atómicos (`createBackup`/`restoreBackup`), plan de actualización con script de rollback automático (`planUpdate`), exportación/importación de perfiles (`exportProfile`/`importProfile`) y detección multi-plataforma. |

---

## 9. Guía para Agregar Nuevos Tests

Al crear nuevas funcionalidades:
1. Agrega los tests correspondientes en `tests/<modulo>.test.ts`.
2. Utiliza `node:assert/strict` y la función `test` (compatible con `bun test`).
3. Para operaciones con archivos o directorios, utiliza siempre `mkdtemp(join(tmpdir(), ...))` para asegurar aislamiento y limpieza.
4. Ejecuta `bun run check` antes de finalizar.
