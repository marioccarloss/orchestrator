# Asignación global de modelos con overrides por arnés

Estado: idea revisada · Fecha: 2026-09-14 · Repositorio: `mr-orchestrator`

## Resultado buscado

Mantener una única asignación global de modelos por rol para `/flow` y `/blueprint`, y permitir que cada **arnés o editor** sobrescriba únicamente los roles que necesite. OpenCode, Codex, Cursor, Claude Code, Antigravity, AGY y fx podrán producir configuraciones efectivas distintas sin que un cambio de arnés afecte a los demás.

Cada arnés tendrá además su propio catálogo de modelos y variantes soportados. Si no existe un override para un rol, ese rol heredará la asignación global. Si la asignación heredada no puede representarse en el arnés, la resolución fallará de forma accionable en lugar de escoger o degradar un modelo silenciosamente.

> **Decisión de alcance:** los modelos se configuran a nivel global o por arnés, nunca por workspace. El workspace sigue identificando el código, el estado y los artefactos de una ejecución, pero no participa en la precedencia de modelos.

## Resumen de la decisión

| Pregunta | Decisión propuesta |
|---|---|
| ¿Cuál es el default? | El roster completo de `~/.config/mr-orchestrator/models.json`. |
| ¿Dónde se personaliza Cursor, Codex, fx, etc.? | En un override parcial propio del arnés. |
| ¿Dónde se declara qué soporta cada arnés? | En un catálogo separado por arnés. |
| ¿Qué ocurre si falta un override? | Se hereda el target global del rol y slot correspondientes. |
| ¿Qué ocurre si el target efectivo no está soportado? | Error antes del despacho; nunca sustitución implícita. |
| ¿Puede un workspace cambiar modelos? | No. Dos workspaces ejecutados desde el mismo arnés resuelven el mismo roster. |
| ¿Quién decide la precedencia? | Un resolver central y puro; los adaptadores solo traducen/aplican. |

## Términos

- **Roster global:** asignación completa de modelo principal, variante y alternativa para todos los roles.
- **Arnés:** host que ejecuta o despacha los roles de mr-orchestrator, por ejemplo OpenCode, Cursor o Codex.
- **Override de arnés:** asignación parcial que reemplaza uno o más targets del roster global para un único arnés.
- **Catálogo de arnés:** contrato de capacidades que enumera modelos, aliases nativos, variantes y modo de aplicación soportados por ese arnés.
- **Target:** unidad atómica formada por modelo y variante opcional.
- **Configuración efectiva:** resultado validado de combinar el roster global con el override del arnés y traducirlo mediante su catálogo.
- **Workspace:** contexto de repositorio y persistencia del flujo. No es un ámbito de configuración de modelos.

La presencia de un modelo en un catálogo confirma que mr-orchestrator sabe representarlo en ese arnés; **no confirma credenciales, suscripción, cuota ni disponibilidad temporal**.

## Comportamiento esperado

La configuración efectiva se resolverá con una precedencia explícita:

```text
roster global completo
        ↓
override parcial del arnés activo
        ↓
validación y traducción con el catálogo de ese arnés
        ↓
configuración efectiva por rol, con origen y target nativo
        ↓
adaptador del arnés
```

El workspace no aparece en esta cadena. Vincular otro workspace cambia el contexto de ejecución, no la selección de modelos.

### Reglas de herencia

1. El roster global debe contener todos los roles y sus dos slots: principal y alternativa.
2. El archivo de un arnés puede omitir cualquier rol.
3. Dentro de un rol, `primary` y `alternative` se sobrescriben por separado.
4. Cada target se reemplaza de forma atómica. No se heredará una `variant` global al cambiar solo el modelo.
5. Un rol o slot ausente en el override hereda exactamente el target global correspondiente.
6. `null` no significa “heredar” ni “desactivar”; será inválido. Para volver al global se elimina el override del slot, rol o archivo.
7. Después del merge, todos los targets efectivos deben existir en el catálogo del arnés y toda variante debe tener una traducción explícita.
8. Un modelo no soportado, una variante no traducible o un arnés sin capacidad de aplicar modelos por rol fallan antes de lanzar agentes.
9. No se consultarán catálogos de otros arneses ni se hará fallback automático a un modelo “parecido”.

### Ejemplo mínimo

Roster global abreviado:

```json
{
  "schemaVersion": 1,
  "roles": {
    "explore": {
      "model": "google/gemini-3.8-flash",
      "variant": "high",
      "alternative": {
        "model": "openai/gpt-5.6-sol",
        "variant": "high"
      }
    }
  }
}
```

Override exclusivo de Cursor:

```json
{
  "schemaVersion": 1,
  "harness": "cursor",
  "roles": {
    "explore": {
      "primary": {
        "model": "anthropic/claude-sonnet-4.6",
        "variant": "high"
      }
    }
  }
}
```

Resultado:

- Cursor usa `anthropic/claude-sonnet-4.6#high` para `explore` y hereda su alternativa global.
- OpenCode, Codex, Claude Code, Antigravity, AGY y fx intentan heredar `google/gemini-3.8-flash#high`; cada uno podrá ejecutarlo solo si su catálogo lo traduce, y en caso contrario fallará antes del despacho.
- Ningún workspace recibe una copia o excepción de este cambio.

## Persistencia propuesta

Separar intención, capacidades y estado generado:

```text
~/.config/mr-orchestrator/models.json
    Roster global completo y existente.

~/.config/mr-orchestrator/harnesses/<harness-id>/models.json
    Override declarativo, parcial y opcional del arnés.

~/.config/mr-orchestrator/harnesses/<harness-id>/catalog.json
    Modelos, variantes, aliases nativos y capacidades exclusivas del arnés.

~/.config/mr-orchestrator/generated/harnesses/<harness-id>/...
    Configuración efectiva y artefactos desechables del arnés.

~/.config/mr-orchestrator/generated/<workspace-id>/opencode.mr.json
    Configuración OpenCode que aún contiene rutas y contexto del workspace,
    pero cuyos modelos provienen del arnés `opencode`.
```

No se creará `<workspace>/.aicontext/models.json` ni ningún equivalente local al proyecto.

### Contrato conceptual del override

```json
{
  "schemaVersion": 1,
  "harness": "cursor",
  "roles": {
    "explore": {
      "primary": {
        "model": "anthropic/claude-sonnet-4.6",
        "variant": "high"
      }
    },
    "judgeB": {
      "alternative": {
        "model": "openai/gpt-5.6-sol",
        "variant": "xhigh"
      }
    }
  }
}
```

`roles` es un record parcial. Cada entrada debe contener al menos `primary` o `alternative`; ambos son targets completos.

### Contrato conceptual del catálogo

```json
{
  "schemaVersion": 1,
  "harness": "fx",
  "applicationMode": "native-role",
  "models": {
    "openai/<modelo-logico>": {
      "nativeModel": "<identificador-nativo-de-fx>",
      "variants": {
        "high": "<variante-nativa>"
      }
    }
  },
  "provenance": {
    "source": "explicit",
    "refreshedAt": "<ISO-8601>"
  }
}
```

El catálogo de fx contendrá solo targets que fx pueda expresar; el de Antigravity, solo targets de Antigravity; y así sucesivamente. No se construirá un catálogo universal mediante la unión de todos los clientes.

Los modos de aplicación deberán representar al menos:

- `native-role`: el host puede fijar un modelo por agente o rol.
- `per-invocation`: el adaptador puede fijarlo de forma verificable en cada despacho.
- `session-only`: el host solo permite un modelo para toda la sesión y no satisface por sí solo un roster heterogéneo.
- `unsupported`: no existe una vía verificada para aplicar la asignación.

Los modos `session-only` y `unsupported` no podrán presentarse como “configuración aplicada”. No habrá degradación silenciosa.

## Identidad del arnés

La selección del override requiere una identidad explícita y confiable; no debe inferirse del workspace ni del nombre de un proceso accidental.

| Target instalado | `harness-id` propuesto |
|---|---|
| OpenCode CLI / Desktop | `opencode` |
| Codex CLI / Desktop | `codex` |
| Cursor CLI / Desktop | `cursor` |
| Claude Code | `claude` |
| Antigravity Desktop | `antigravity` |
| AGY CLI | `agy` |
| fx | `fx` |

Aunque Antigravity y AGY compartan actualmente parte de la configuración Gemini, deben conservar identidades separadas hasta demostrar que su catálogo y semántica de selección de modelos son idénticos.

- El plugin nativo usará `opencode`.
- Cada entrada MCP externa deberá iniciar el bridge con su `harness-id`, por argumento o variable de entorno administrada por el instalador.
- `mr_bind_workspace` seguirá vinculando el contexto, pero no podrá cambiar el arnés de la sesión.
- Una invocación con arnés ausente o desconocido fallará antes de exponer una configuración efectiva.

## Requisitos funcionales

### Roster global

- Mantener `models.json` como baseline completo por rol.
- Preservar modelo principal, variante y alternativa.
- Mantener el comportamiento actual de los comandos sin `--harness`: editan el global.
- Evitar duplicar el roster completo en cada arnés.

### Overrides por arnés

- Admitir overrides parciales por rol y por slot.
- Aislar completamente las escrituras: cambiar Cursor no modifica Codex, OpenCode, fx ni el global.
- Permitir inspeccionar, establecer y eliminar overrides.
- Cuando el host reporte de forma verificable un fallo de cuota, materializar la promoción automática en el override del arnés afectado, incluso si antes heredaba ambos targets del global.
- Nunca convertir una incidencia de cuota de un arnés en una mutación del roster global.

### Catálogos por arnés

- Mantener un catálogo separado para cada `harness-id`.
- Validar modelo lógico, target nativo, variante y modo de aplicación.
- Conservar procedencia y fecha de actualización.
- Actualizar catálogos solo mediante una acción explícita y con escritura atómica; no cambiarlos en segundo plano durante una ejecución.
- Usar el último catálogo válido cuando esté disponible y mostrar si está desactualizado.
- Distinguir “soportado/configurable” de “disponible con la cuenta y cuota actual”.

### Resolución y adaptadores

- Implementar una función pura equivalente a `resolveEffectiveModels(global, override, catalog, harnessId)`.
- Devolver por target: valor lógico, valor nativo, variante traducida y origen `global` o `harness:<id>`.
- Resolver y validar antes de iniciar o despachar cualquier rol.
- Mantener la precedencia fuera de los adaptadores.
- Exigir a cada adaptador que demuestre cómo aplica el modelo; una instrucción textual que el host pueda ignorar no cuenta como aplicación verificada.
- Preservar archivos administrados por el usuario y la semántica de ownership del instalador actual.

### CLI y UX

La forma final podrá ajustarse, pero debe cubrir operaciones equivalentes a:

```text
mr models list [--harness <id>] [--effective] [--origins]
mr models set <role> <model> [model|alternative] [--harness <id>]
mr models reset [<role> [model|alternative]] --harness <id>
mr models validate --harness <id>
mr models catalog --harness <id> [--refresh]
mr flow-models [--harness <id>]
```

- Sin `--harness`, `list`, `set` y los presets conservan su semántica global actual.
- Con `--harness`, el selector muestra únicamente el catálogo de ese arnés y guarda un override parcial.
- La vista efectiva debe mostrar modelo lógico, target nativo, variante, origen y estado de validación.
- No se ofrecerá `--workspace` para modelos.

## Semántica de escritura y sincronización

- Toda operación validará primero el resultado completo y escribirá después; un error no dejará cambios parciales.
- Un cambio de override regenerará solo el arnés afectado.
- Un cambio global recalculará los arneses instalados, respetando sus overrides.
- Si cambia el roster efectivo de OpenCode, se regenerarán sus definiciones globales y los archivos por workspace que hoy embeben agentes; esto no convierte al workspace en ámbito de modelos.
- Una configuración global que deje inválido un arnés instalado deberá rechazarse con la lista de roles afectados, salvo que exista una decisión explícita futura de permitir estado pendiente.
- Los artefactos generados nunca serán fuente de verdad ni se editarán manualmente.

## Estado de partida al redactar este spec

- `~/.config/mr-orchestrator/models.json` contiene una única asignación global completa por rol.
- `ModelMapSchema` exige targets completos y `loadModels` rellena roles ausentes con defaults.
- `syncWorkspace` carga ese mapa global y lo embebe en la configuración OpenCode generada para cada workspace.
- El overlay `.opencode/opencode.json` solo incorpora actualmente `instructions` y `mcp`; no implementa overrides de modelos.
- `discoverAvailableModels` consulta únicamente `opencode models` y usa un catálogo de respaldo común.
- `mr models`, `mr flow-models` y `mr_models` mutaban el mapa global y sincronizaban todos los workspaces.
- La promoción automática de alternativas mutaba el mapa global.
- Los adaptadores externos indicaban que el host resolviera modelos desde su configuración, pero no generaban ni verificaban asignaciones por rol.
- El bridge externo se identificaba por el workspace vinculado, pero no recibía la identidad del arnés.
- El instalador distinguía OpenCode, Codex, Cursor, Claude Code, Antigravity y AGY; fx todavía no estaba incorporado ni identificado.

## Alcance previsto

- Esquemas versionados para override, catálogo y configuración efectiva.
- Registro canónico de `harness-id` y mapeo desde targets de instalación.
- Resolver puro de precedencia, herencia, traducción y validación.
- Persistencia atómica por arnés.
- CLI y selector interactivo con ámbito global o de arnés.
- Identidad de arnés en el bridge y en el plugin nativo.
- Adaptadores que apliquen configuraciones efectivas sin sobrescribir archivos del usuario.
- Catálogos separados para OpenCode, Codex, Cursor, Claude Code, Antigravity, AGY y fx.
- Diagnóstico de origen y capacidad de aplicación.
- Migración compatible con la instalación global existente.
- Pruebas unitarias, de integración y de aislamiento entre arneses.
- Documentación de uso y recuperación.

## Fuera de alcance inicial

- Overrides por workspace, repositorio o proyecto.
- Sobrescrituras por ticket, tarea, usuario del workspace o ejecución individual.
- Routing dinámico por coste, latencia, benchmark o disponibilidad.
- Selección automática de un modelo alternativo no declarado.
- Afirmar cuota o acceso a partir de un catálogo estático.
- Gestionar credenciales o suscripciones de los proveedores.
- Simular soporte por rol en hosts que solo permiten un modelo de sesión.
- Sustituir la máquina de estados determinista de mr-orchestrator.

## Criterios de aceptación

- [ ] Sin overrides, cada arnés hereda exactamente los targets globales que su catálogo pueda traducir.
- [ ] Un override de `cursor.explore.primary` no altera otros roles, la alternativa heredada, el global ni otro arnés.
- [ ] Dos arneses pueden producir rosters efectivos distintos para el mismo workspace.
- [ ] Dos workspaces ejecutados desde el mismo arnés producen el mismo roster efectivo.
- [ ] No existe ni se consulta un archivo de modelos dentro de `.aicontext`, `.opencode` u otra carpeta del workspace.
- [ ] Cada arnés valida exclusivamente contra su propio catálogo.
- [ ] Un target global heredado pero no soportado falla antes del despacho e identifica arnés, rol, slot, origen y regla infringida.
- [ ] Una variante sin traducción explícita falla; nunca se descarta silenciosamente.
- [ ] Eliminar un override restaura la herencia global sin reescribir el global.
- [ ] Cuando un host reporta un fallo de cuota, la promoción crea o actualiza solo el override del arnés afectado.
- [ ] La CLI muestra global, override, resultado efectivo, target nativo y origen por rol.
- [ ] Un adaptador `session-only` o `unsupported` no informa que un roster heterogéneo fue aplicado.
- [ ] Un cambio por arnés no regenera ni modifica configuraciones de otros arneses.
- [ ] OpenCode conserva el comportamiento actual cuando no existe `harnesses/opencode/models.json`.
- [ ] Las instalaciones existentes migran sin requerir archivos por workspace.
- [ ] Hay pruebas de integración deterministas para OpenCode y para cada arnés externo cuya aplicación por rol se declare soportada.

## Decisiones que debe cerrar la planificación

1. **Cerrado:** `fx` significa [fx de Vercel Labs](https://fx.sh/). Su catálogo se descubre con `fx models --json`; `--model` y `--effort` son overrides por proceso, y sus subagentes heredan el modelo del padre, por lo que se clasifica como `per-invocation` y no `native-role`.
2. Definir la identidad lógica estable de un modelo y la migración desde referencias actuales como `github-copilot/...`, `openai/...` y `opencode-go/...`.
3. Verificar para cada host si la selección es `native-role`, `per-invocation`, `session-only` o `unsupported` y documentar evidencia reproducible.
4. Definir cómo se obtienen y refrescan los catálogos sin confundir soporte conocido con acceso real de la cuenta.
5. **Cerrado para Gemini:** Antigravity Desktop y AGY CLI conservan `harness-id` distintos y reciben entradas MCP separadas aunque compartan `~/.gemini/config/mcp_config.json`.
6. Decidir la política exacta cuando un cambio global invalida un arnés instalado: rechazo atómico recomendado frente a estado pendiente explícito.
7. Definir umbral de caducidad y comportamiento offline de los catálogos.
8. Determinar el formato nativo y el mecanismo ownership-safe que usará cada adaptador para aplicar el roster.

## Restricciones de implementación

- TypeScript estricto y validación con Zod.
- Funciones puras para merge, resolución y validación.
- Targets de modelo atómicos; no mezclar variantes entre modelos.
- Escrituras mediante las utilidades atómicas existentes.
- Esquemas versionados y migraciones explícitas.
- Compatibilidad hacia atrás: ausencia de overrides mantiene el baseline global.
- Errores accionables con arnés, rol, slot, valor, origen, catálogo y regla infringida.
- Ninguna mutación global como efecto lateral de una operación o fallo de un arnés.
- Ninguna decisión de precedencia dentro de un adaptador.
- Ninguna afirmación de soporte sin una vía verificable de aplicación en el host.

## Siguiente paso

Ejecutar Gepetto sobre este spec para investigar las capacidades reales de cada host y cerrar las decisiones abiertas:

```text
/gepetto @docs/plans/harness-model-overrides/spec.md
```
