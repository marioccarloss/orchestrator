# mr-orchestrator (Mario Roca Orchestrator)

Orquestador determinista, tipado y global para OpenCode, diseñado para el desarrollo y entrega quirúrgica de software en plataformas complejas con **máxima eficiencia y ahorro de tokens**.

`mr-orchestrator` se instala de forma global y aislada en el sistema, conectándose a OpenCode mediante configuraciones generadas bajo el estándar XDG. No modifica código de producto por iniciativa propia; solo escribe entregables solicitados y, de forma opt-in con diff y confirmación, reglas `AGENTS.md` dentro de un repositorio.

---

## 📚 Documentación Completa

Hemos preparado manuales detallados para cada aspecto del sistema:

1. 📖 **[Manual de Instalación (`docs/INSTALLATION.md`)](docs/INSTALLATION.md):**
   - Principios de aislamiento y seguridad.
   - Instalación de un runtime Bun aislado y reproducible.
   - Verificación con `mr doctor` y registro de workspaces.
   - Procedimiento de desinstalación limpia y segura.

2. 🛠️ **[Manual de Arquitectura y Desarrollo (`docs/DEVELOPMENT.md`)](docs/DEVELOPMENT.md):**
   - Filosofía: *"El plugin es el orquestador; el LLM es el ejecutor"*.
   - Estándares TypeScript estrictos y validación Zod.
   - Arquitectura hexagonal: `TicketPort`, `PrPort`, `GitConventionResolver`.
   - Estrategia de optimización de tokens (Atlas, caché de tickets/Figma, persistencia Engram en fronteras).
   - Roadmap de fases de desarrollo (F0 a F8).

3. 🚀 **[Manual de Uso y Referencia de Comandos (`docs/USAGE.md`)](docs/USAGE.md):**
   - Uso de `mr` (CLI de administración) y `mrcode` (lanzador inteligente de OpenCode).
   - Experiencia unificada: desarrollo normal en `build` y despacho automático de `/flow` al coordinador interno.
   - Roster completo de agentes (`orchestrator`, `mr-explore`, `mr-plan`, `mr-general`, `mr-sdd-apply`, `mr-judge-a`, `mr-judge-b`, `mr-fix`).
   - Guía detallada de comandos: `/flow`, `/propose`, `/prompt`, `/atlas`, `/trace` y `/flow-models`.
   - Pipeline SDD/RPI con Blueprint-lite (`research → brief → spec → tasks → implement`).
   - Configuración de modelos de IA por rol.
   - Troubleshooting y preguntas frecuentes.

4. 🧭 **[Decision Plane con Jev (`docs/DECISION-PLANE.md`)](docs/DECISION-PLANE.md):**
   - Integración compartida para OpenCode y arneses externos.
   - Configuración nativa y reversible de fx.
   - Activación segura en modo shadow, métricas y límites de autoridad.

---

## ⚡ Estado del Proyecto

**Runtime principal y programa de fiabilidad F0–F6 implementados; la aceptación cuantitativa depende de journeys reales capturados.**
- Suite automatizada de pruebas unitarias y de integración en Bun
- Plugin nativo de OpenCode con despacho por agente y herramientas FSM fail-closed
- Atlas v2 incremental y honesto sobre cobertura para TypeScript/TSX, JavaScript/JSX, Java, PHP, Astro, CSS/SCSS y JSON/YAML
- EvidenceStore compartido, bundles mínimos por rol, reglas observadas y resolución de contratos entre repositorios
- Pipeline SDD/RPI determinista: cápsulas JSON tipadas, límites quirúrgicos, recibos de verificación y gates bloqueantes por defecto
- Carriles `fast`, `standard`, `full` y `critical` con presupuesto de contexto por rol; `fast` local reutiliza una sola sesión
- Salida determinista en español, inglés, portugués, catalán o francés, manteniendo inglés para contratos internos y prompts
- Decision Plane opcional con Jev en modo shadow: aconseja sobre ambigüedad sin sustituir FSM, gates, denegaciones ni confirmación humana
- Progreso tipo pedido, coste/tokens estimados por Flow y explicaciones técnicas ultracondensadas
- Skill `i-have-adhd` aplicado solo por Orchestrator y catálogo MCP gestionado (`codebase-memory`, CodeGraph, Context7, Engram, GitHub, Jira y `figma-live-mcp`)
- Diagnóstico React `/trace`, propuestas técnicas `/propose` y generador `/prompt` con `pbcopy`
- Sistema de juicio ciego con jueces A/B y bucle de corrección acotado
- Gestión de ciclo de vida con backup, restore, plan de update y rollback automático
- Selector interactivo `flow-models` durante la instalación y flujo guiado dentro de OpenCode
- Skeletons de código con `mr_atlas_skeleton` (~85-90% menos tokens que lectura completa)

---

## ⚡ Inicio Rápido

### 1. Instalar Bun

Instala Bun siguiendo la [documentación oficial](https://bun.com/docs/installation):

```bash
curl -fsSL https://bun.com/install | bash
```

Abre una terminal nueva y comprueba la instalación:

```bash
bun --version
```

### 2. Descargar e instalar dependencias

```bash
git clone git@github.com:marioccarloss/orchestrator.git
cd orchestrator
bun install --registry https://registry.npmjs.org --frozen-lockfile
bun run build
```

### 3. Instalar mr-orchestrator y registrar un workspace

```bash
./install.sh --workspace ~/Projects/my-workspace
```

El asistente explica cada skill/MCP y permite instalar todos, elegir, continuar con una selección anterior, aplazar sin bloquear la instalación o cancelar. Reanuda en cualquier momento con `mr capabilities install`.

### 4. Diagnóstico del Entorno

```bash
mr doctor
```

### 5. Inicializar Atlas y reglas observadas

```bash
cd ~/Projects/my-workspace
mr atlas init --guided --lang es
```

Usa `--no-rules` si solo quieres índice y perfiles. La escritura de `AGENTS.md` en cada repositorio requiere `--write-repo-agents` y confirmación explícita.

### 6. Lanzar OpenCode con el Orquestador

Navega a cualquier subcarpeta o repositorio del workspace y ejecuta:

```bash
cd ~/Projects/my-workspace/apps/api
mrcode
```

---

## 🛡️ Garantías de Seguridad y Aislamiento

- **Control de Posesión:** Todos los archivos instalados quedan registrados en `~/.config/mr-orchestrator/install-manifest.json` con su hash SHA-256.
- **Desinstalación Reversible:** `mr uninstall` únicamente retira los ejecutables propios no modificados. Con `--purge` limpia también cachés y datos globales sin tocar repositorios de trabajo.
- **Runtime Bun dedicado:** instalación, dependencias, build, tests y CLI se ejecutan con el Bun aislado de mr-orchestrator.
