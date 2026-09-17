# Manual de Instalación de mr-orchestrator

Este documento detalla paso a paso cómo instalar, configurar, verificar y desinstalar `mr-orchestrator` en cualquier máquina macOS (incluyendo MacBook Air / Pro Apple Silicon e Intel) o Linux mediante un runtime Bun aislado.

---

## 1. Principios de Instalación y Aislamiento

`mr-orchestrator` fue diseñado con los siguientes principios de seguridad:

1. **Cero impacto en repositorios de trabajo:** Nunca escribe archivos dentro de los repositorios registrados.
2. **Toolchain y capacidades aisladas:** Instala Bun y las capacidades recomendadas bajo `~/.local/share/mr-orchestrator/`, con versiones y checksums fijados.
3. **No mutación de archivos shell (`.zshrc` / `.bashrc`):** El instalador no escribe silenciosamente en tus archivos rc.
4. **Instalación basada en Manifest:** Cada archivo creado queda registrado con su hash SHA-256 en `~/.config/mr-orchestrator/install-manifest.json`.
5. **Desinstalación como reversa exacta:** `mr uninstall` solo elimina archivos de su propiedad que no hayan sido modificados por el usuario.

---

## 2. Requisitos Previos

Antes de instalar en una nueva máquina, asegúrate de contar con:

- **Sistema Operativo:** macOS 13.0+ (ARM64 Apple Silicon o x86_64 Intel) o Linux (x64/arm64).
- **Herramientas base del sistema:** `git`, `curl`, `unzip` (disponibles nativamente en macOS).
- **OpenCode CLI:** `opencode` instalado en el sistema (`opencode --version`).
- **Directorio de ejecutables en PATH:** Asegúrate de tener `~/.local/bin` en tu variable `$PATH`.

### Verificación de PATH

En tu terminal ejecuta:
```bash
echo $PATH | tr ':' '\n' | grep "\.local/bin"
```

Si no aparece, agrega la siguiente línea a tu `~/.zshrc` (o `~/.bashrc`):
```bash
export PATH="$HOME/.local/bin:$PATH"
```
Y recarga tu shell:
```bash
source ~/.zshrc
```

---

## 3. Proceso de Instalación Paso a Paso

### Paso 1: Ubicar el proyecto

Coloca la carpeta del proyecto en `~/Projects/mr-orchestrator` (o tu ruta preferida):
```bash
cd ~/Projects/mr-orchestrator
```

### Paso 2: Ejecutar el script de instalación

Para instalar registrando de una vez un workspace de desarrollo:

```bash
./install.sh --workspace ~/Projects/my-workspace
```

O si solo deseas instalar los ejecutables globales sin registrar workspaces de inmediato:

```bash
./install.sh
```

Antes de descargar capacidades, el instalador muestra para qué sirve cada skill/MCP, su importancia y si ya está disponible. Las opciones son:

1. **Instalarlos todos** — selección recomendada.
2. **Elegir uno por uno** — instala únicamente lo marcado.
3. **Continuar con la selección actual** — reanuda una instalación anterior.
4. **Continuar y hacerlo más tarde** — instala mr-orchestrator sin bloquearse y deja un recordatorio.
5. **Cancelar toda la instalación** — no continúa con el instalador principal.

En instalaciones sin terminal interactiva se usa la selección recomendada. Para aplazarla expresamente:

```bash
./install.sh --workspace ~/Projects/my-workspace --capabilities-later
```

Para consultar o reanudar después:

```bash
mr capabilities status
mr capabilities install
mr capabilities all
```

### ¿Qué hace `install.sh` por dentro?
1. Verifica si existe el runtime de Bun en `~/.local/share/mr-orchestrator/toolchains/bun/bin/bun`. Si no existe, lo descarga de manera aislada sin alterar `.zshrc`.
2. Abre el selector de capacidades. Instala el skill `i-have-adhd`, `codebase-memory`, CodeGraph, Engram y `figma-live-mcp` elegidos desde revisiones fijadas y valida cada descarga por SHA-256.
3. Registra también Context7, GitHub y Jira como MCP remotos. GitHub/Jira conservan su autenticación oficial y nunca reciben secretos desde el instalador.
4. Ejecuta `bun install --frozen-lockfile` y compila el código TypeScript (`bun run build`).
5. Si hay una terminal interactiva, abre `flow-models` para revisar o elegir el baseline global de cada proceso/step. Los cambios solo se persisten al seleccionar **Guardar y salir**.
6. Crea los launchers ejecutables en `~/.local/bin/`:
   - `~/.local/bin/mr`: CLI administrativo de mr-orchestrator.
   - `~/.local/bin/mrcode`: Wrapper inteligente que detecta el workspace actual y lanza OpenCode con la configuración compilada.
   - `~/.local/bin/bun`: Shim que apunta al runtime aislado de Bun.
7. Escribe el manifest en `~/.config/mr-orchestrator/install-manifest.json` y el catálogo portable en `~/.config/mr-orchestrator/recommended-mcps.json`.
8. Inicializa `~/.config/mr-orchestrator/models.json` con los modelos globales por rol elegidos. Los overrides de clientes externos se guardan aparte en `~/.config/mr-orchestrator/harnesses/<harness-id>/models.json`; nunca dentro de un workspace.
9. Si se pasó `--workspace`, registra el workspace en `~/.config/mr-orchestrator/workspaces.json` y compila su configuración en `~/.config/mr-orchestrator/generated/<workspace-id>/opencode.mr.json`.
10. **Instala las dependencias del plugin generado** (`bun install` en `~/.config/mr-orchestrator/generated/<workspace-id>/`). Esto es necesario para que el plugin pueda importar `@opencode-ai/plugin`, `zod`, `tree-sitter`, etc. Sin este paso, el plugin falla silenciosamente al cargar.

### Paso manual de Figma

El servidor y el plugin quedan construidos en una ruta aislada. Figma exige una importación explícita que el instalador no puede automatizar:

1. Abre **Figma → Plugins → Development → Import plugin from manifest…**.
2. Selecciona la ruta `packages/figma-plugin/manifest.json` que imprime `install.sh`.
3. Ejecuta **Figma Live Bridge** cuando necesites inspección en vivo.

El skill ADHD queda instalado y registrado, pero `/flow` lo aplica automáticamente **solo al Orchestrator**. Los implementadores, jueces y el agente de corrección continúan emitiendo únicamente payloads internos.

GitHub y Jira pueden quedar como `pending` sin abortar nada. El instalador continúa con las capacidades listas y muestra `mr capabilities install` como siguiente acción. Después de completar el OAuth en el cliente, ejecuta ese comando, marca **Ya está credencializado** y la configuración de todos los workspaces se regenera.

En automatizaciones sin TTY el selector se omite automáticamente. También puede omitirse de forma explícita con `./install.sh --no-models`; después se abre con `mr flow-models`.

Después de instalar un bridge externo, crea su catálogo explícito y valida el roster antes del primer despacho:

```bash
mr models validate --harness cursor
mr flow-models --harness cursor
```

El refresco automático funciona para OpenCode y fx (`mr models catalog --harness <opencode|fx> --refresh`). Si un adaptador no ofrece descubrimiento, escribe un `catalog.json` explícito con el identificador nativo, variantes y `applicationMode`. La ausencia o incompatibilidad del catálogo falla de forma cerrada y no altera el baseline global.

---

## 4. Verificación Post-Instalación

Ejecuta el comando de diagnóstico:

```bash
mr doctor
```

Deberías ver una salida similar a:
```text
┌  mr-orchestrator doctor
│
●  ✓ ~/.local/share/mr-orchestrator/toolchains/bun/bin/bun: 1.2.21
│
│
●  ✓ opencode: 1.18.25
│
●  ✓ codebase-memory-mcp: 0.10.8
●  ✓ codegraph: 1.6.0
●  ✓ engram: 1.20.0
●  ✓ i-have-adhd: installed for Orchestrator presentation only
●  ✓ figma-live-mcp: server binary installed
●  ✓ Figma plugin manifest: import manually in Figma: .../manifest.json
│
●  ✓ PATH: ~/.local/bin is configured
│
●  ✓ install manifest: v0.1.0
│
●  ✓ workspace registry: 1 registered
│
●  ✓ my-workspace: ~/Projects/my-workspace
│
└  All checks passed.
```

Comprueba que el ejecutable global apunta al runtime Bun aislado:
```bash
which bun
# Salida esperada: ~/.local/bin/bun
```

Prueba la detección del agente dentro del workspace registrado:
```bash
cd ~/Projects/my-workspace/apps/api
mrcode debug agent orchestrator
```
Debe responder con la metadata del agente `orchestrator` en modo `primary`.

---

## 5. Gestión de Workspaces

### Agregar un nuevo workspace:
```bash
mr workspace add /ruta/absoluta/a/tu/workspace/root
```
*(Nota: el directorio debe contener una carpeta `.aicontext` para ser reconocido como workspace válido).*

### Listar workspaces registrados:
```bash
mr workspace list
```

### Eliminar un workspace del registro:
```bash
mr workspace remove <workspace-id>
```

### Re-sincronizar configuración generada:
```bash
mr sync
```
*(Esto regenera `opencode.mr.json`, copia el plugin compilado e **instala automáticamente las dependencias** con `bun install` en cada workspace.)*

---

## 6. Uso sin `mrcode` (loader automático)

Si prefieres no usar `mrcode`, puedes iniciar `opencode` directamente desde cualquier subdirectorio del workspace:

```bash
cd ~/Projects/my-workspace/apps/api
opencode .
```

El loader global (`~/.config/opencode/plugins/mr-orchestrator-loader.ts`) detectará automáticamente el workspace y cargará:
- Los comandos `/flow`, `/atlas`, `/trace`, `/propose`, `/prompt`, `/flow-models`
- Los 20 tools `mr_flow_*`, `mr_sdd_*`, `mr_atlas_*`, etc.
- Los agentes `orchestrator`, `mr-explore`, `mr-plan`, etc.
- Los MCP recomendados, respetando cualquier entrada homónima definida por el usuario.

**Importante:** Si el loader falla, ahora verás un mensaje de error en stderr. Antes, los errores eran silenciosos y los comandos simplemente no aparecían.

---

## 7. Solución de Problemas

### Los comandos `/flow`, `/atlas` no aparecen en `opencode .`

**Síntoma:** Ejecutas `opencode .` desde un workspace registrado, pero los comandos del orchestrator no están disponibles.

**Causa probable:** Las dependencias del plugin no están instaladas en el directorio generado.

**Solución:**
```bash
# Re-sincronizar e instalar dependencias automáticamente
mr sync

# Si persiste el problema, verificar manualmente:
ls ~/.config/mr-orchestrator/generated/<workspace-id>/node_modules
# Si no existe, el sync debería haberlo creado. Reportar como bug.
```

### El loader muestra error en stderr

Si ves `[mr-orchestrator-loader] Failed to load plugin...`, revisa:
1. Que el workspace esté registrado: `mr workspace list`
2. Que el directorio generado exista: `ls ~/.config/mr-orchestrator/generated/`
3. Que las dependencias estén instaladas: `ls ~/.config/mr-orchestrator/generated/<workspace-id>/node_modules`

---

## 8. Desinstalación y Limpieza

### Desinstalación segura (mantiene datos y cachés):
```bash
# Ver qué archivos se eliminarían
mr uninstall --dry-run

# Proceder con la desinstalación (solicitará confirmación interactiva)
mr uninstall

# Omitir confirmación:
mr uninstall --yes
```

### Desinstalación completa (Purge total):
Elimina los launchers, el manifest y todos los datos/cachés globales (`~/.config/mr-orchestrator`, `~/.local/share/mr-orchestrator` con el Bun aislado y `~/.cache/mr-orchestrator`):
```bash
mr uninstall --purge --yes
```

*Nota: La desinstalación nunca borra ni modifica los repositorios de tus proyectos ni sus historiales git.*
