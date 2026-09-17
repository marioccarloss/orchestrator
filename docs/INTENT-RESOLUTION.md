# Resolución de intención (Intent Resolution)

La fase **INTENT** aterriza *qué problema se resuelve* y *cómo sabremos que está hecho* **antes** de explorar código. El objetivo es minimizar preguntas al humano: el orquestador intenta resolver solo con barridos deterministas y solo escala a aclaración excepcional.

## Pipeline

```text
Ticket → Context (Atlas + Engram warm) → INTENT → Explore → Plan → …
```

Tras cargar el ticket (`mr_flow_ticket` o `mr_flow_start` con ticket), el plugin ejecuta automáticamente los barridos **S0–S4** y persiste un borrador en `sdd/intent.json`.

## Escalera de barridos (S0–S5)

| Barrido | Fuente | Qué hace |
|--------|--------|----------|
| **S0** | Ticket | Parse mecánico: título, descripción, líneas tipo Given/When/Then, hotfix constraints |
| **S1** | Engram | Lee `flow-engram-prefetch.json`; convierte hits en decisiones con fuente `engram` |
| **S2** | Atlas | Tokeniza título+descripción y busca nodos por nombre (mapa, sin leer ficheros) |
| **S3** | Inferencia acotada | Fusiona S0–S2; opcionalmente merge de un borrador JSON de `mr-intent` (`llmDraft`) |
| **S4** | Plugin (TypeScript) | Valida huecos de alto riesgo; decide `PROPOSED`, `READY` o `NEEDS_INPUT` |
| **S5** | Humano | Excepcional: ≤2 preguntas con **opciones** y **default sugerido**, no cuestionario en blanco |

S5 no es un barrido automático: solo ocurre cuando S4 no puede cerrar un hueco **high** sin inventar.

## Estados de la cápsula

```typescript
status: "PROPOSED" | "READY" | "NEEDS_INPUT"
```

| Estado | Significado | Siguiente paso |
|--------|-------------|----------------|
| **PROPOSED** | Borrador con fuentes, supuestos y huecos visibles | Usuario confirma con `mr_flow_intent approved=true` |
| **READY** | Intención aprobada (auto en carril rápido o tras confirmación) | Avanza a explore tras `mr_flow_intent` |
| **NEEDS_INPUT** | Hueco high sin default seguro | Responder vía `mr_sdd_submit kind=intent` o re-ejecutar `mr_flow_intent_resolve` |

### Campos de trazabilidad (PROPOSED)

- `resolution.fields` — por campo: `source` (ticket | engram | atlas | inferred | user) y `confidence` (high | medium | low)
- `assumptions[]` — supuestos inferidos con `risk: low | medium`
- `unresolved[]` — huecos pendientes con `suggestedDefault` y `options`

## Política de supuestos y carriles

| Riesgo del supuesto | Carril `fast` | Carril `full` / `critical` |
|---------------------|---------------|----------------------------|
| **low** | Auto-aceptable | Auto-aceptable |
| **medium** | Auto-aceptable | Requiere `confirmMediumAssumptions=true` en `mr_flow_intent` |
| **high** (hueco) | No inventar → NEEDS_INPUT o default sugerido | Igual |

**Auto-READY** (sin paso PROPOSED explícito) cuando:

- Dificultad ≤ 3 (carril rápido)
- Confianza del outcome ≠ `low`
- Todos los supuestos son `low`
- Cero huecos `unresolved` de riesgo `high`

## Herramientas

| Tool | Uso |
|------|-----|
| `mr_flow_ticket` / `mr_flow_start` | Tras warm-up, ejecuta S0–S4 y muestra el borrador |
| `mr_flow_intent_resolve` | Re-ejecuta barridos; opcional `llmDraft` JSON de mr-intent |
| `mr_sdd_submit kind=intent` | Persiste PROPOSED o READY; NEEDS_INPUT no se persiste |
| `mr_sdd_get kind=intent` | Lee la cápsula (PROPOSED o READY) |
| `mr_flow_intent` | Promueve PROPOSED→READY y avanza a explore |

## Agente mr-intent

No parte de cero. Debe:

1. Leer el borrador existente (`mr_sdd_get` o salida de `mr_flow_intent_resolve`)
2. Refinar supuestos **medium/low** con evidencia de ticket o Engram
3. Preferir `status=PROPOSED` frente a `NEEDS_INPUT`
4. Reservar `NEEDS_INPUT` para huecos high sin default razonable (máx. 2 preguntas con opciones)

## UX recomendada

1. Mostrar **una vez** el resumen determinista (`renderIntentProposal` / `renderIntentAssessment`) — no parafrasear.
2. Si hay supuestos medium en carril full/critical, explicar qué se asumió y pedir confirmación explícita.
3. Si `NEEDS_INPUT`, presentar la **opción sugerida** como default, no un formulario vacío.

## Ejemplo de flujo feliz

1. `mr_flow_start` → ticket claro, dificultad 3
2. Salida: `Intent auto-ready` + resumen
3. Usuario confirma → `mr_flow_intent approved=true`
4. Fase explore desbloqueada

## Ejemplo con borrador

1. Ticket ambiguo pero con contexto Engram
2. Salida: `Intent draft proposed` + supuestos Atlas + fuentes
3. `mr-intent` refina → `mr_flow_intent_resolve llmDraft=…`
4. Usuario confirma → `mr_flow_intent approved=true`

## Ejemplo excepcional (humano)

1. Ticket demasiado vago tras S0–S4
2. `NEEDS_INPUT` con 1–2 preguntas, cada una con `[Usar default sugerido] | [Reescribir] | …`
3. Respuesta → `mr_sdd_submit kind=intent` con PROPOSED o READY
4. `mr_flow_intent approved=true`

## Implementación

- `src/core/intent-resolver.ts` — barridos S0–S4
- `src/core/intent-gates.ts` — `validateIntentApproval` por carril
- `src/core/intent-schema.ts` — esquema Zod PROPOSED / READY / NEEDS_INPUT
- `src/core/render.ts` — `renderIntentProposal`, `renderIntentAssessment`

Los gates de la FSM siguen en TypeScript (fail-closed): el LLM no puede saltarse INTENT ni publicar research sin READY persistido.
