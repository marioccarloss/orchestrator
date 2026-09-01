# mr-orchestrator (Mario Roca Orchestrator)

Orquestador determinista, tipado y global para OpenCode, diseñado para el desarrollo y entrega quirúrgica de software en plataformas complejas con **máxima eficiencia y ahorro de tokens**.

`mr-orchestrator` se instala de forma global y aislada en el sistema, conectándose a OpenCode mediante configuraciones generadas bajo el estándar XDG. **Nunca contamina el árbol git ni escribe archivos dentro de los repositorios de tu proyecto.**

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
   - Modos de operación: modo `Orchestrator` vs modo `build`.
   - Roster completo de agentes (`orchestrator`, `mr-explore`, `mr-plan`, `mr-general`, `mr-sdd-apply`, `mr-judge-a`, `mr-judge-b`, `mr-fix`).
   - Guía detallada de comandos: `/flow`, `/propose`, `/prompt`, `/atlas`, `/trace` y `/flow-models`.
   - Pipeline SDD/RPI con herramientas `mr_sdd_*` (research → spec → tasks → implement).
   - Configuración de modelos de IA por rol.
   - Troubleshooting y preguntas frecuentes.

4. 💻 **[Guía de Transferencia a MacBook Air (`docs/TRANSFER_MACBOOK_AIR.md`)](docs/TRANSFER_MACBOOK_AIR.md):**
   - Cómo empaquetar y replicar el proyecto en la MacBook Air de Mario Carlos Roca Peñafiel (o cualquier máquina) **sin subir a repositorios remotos**.
   - Métodos de transferencia (AirDrop, red local, USB).
   - Puesta en marcha desde cero en el equipo destino.

---

## ⚡ Estado del Proyecto

**Fases F0 a F8 completadas al 100%.**
- Suite automatizada de pruebas unitarias y de integración en Bun
- Plugin nativo de OpenCode con guardias de comandos y herramientas FSM
- Indexador Atlas con **tree-sitter** (TypeScript/TSX + Java) y soporte para configs JSON/YAML
- Pipeline SDD/RPI determinista: cápsulas JSON tipadas validadas con Zod + guardrails estructurales
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

### 4. Diagnóstico del Entorno

```bash
mr doctor
```

### 5. Lanzar OpenCode con el Orquestador

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
