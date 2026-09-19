# Decision Plane con Jev

## Objetivo

Jev se integra como **evaluador de decisiones**, no como otro rol generativo. El mismo núcleo de mr-orchestrator sirve a:

- **OpenCode**, mediante el tool `mr_decision_evaluate` del plugin nativo.
- **Arneses externos**, mediante el bridge MCP existente.
- **fx**, además, mediante su reviewer nativo de permisos.

El modo inicial es `off`. Al activar `shadow`, Jev puede recomendar, pero la autoridad continúa en la FSM determinista, los gates, las denegaciones explícitas y la confirmación humana.

## Arquitectura

```text
OpenCode plugin ─┐
MCP bridge ──────┼─> Decision Plane ─> Jev adapter ─> Vercel AI Gateway
Flow probes ─────┘        │
                         └─> métricas y recomendación shadow

fx ─> reviewer nativo Jev para permisos
```

El Decision Plane expone perfiles fijos y preguntas acotadas: `intent`, `context`, `routing`, `flow`, `judgment` y `permission`. El estado enviado se limita a 16.000 caracteres. No acepta una pregunta libre que pueda convertirlo en un segundo agente.

## Activación

Proporciona una credencial a Vercel AI Gateway en el entorno de ejecución. mr-orchestrator solo comprueba si existe; no la lee, almacena ni imprime.

```bash
export AI_GATEWAY_API_KEY='...'
# Alternativa en entornos Vercel: VERCEL_OIDC_TOKEN

mr decision shadow
mr decision status
```

Para desactivarlo:

```bash
mr decision off
```

La configuración se guarda bajo el directorio global de mr-orchestrator. Nunca contiene la credencial. El adaptador solicita `zeroDataRetention` al Gateway en cada evaluación.

## OpenCode y bridge MCP

El plugin expone:

```text
mr_decision_evaluate(profile, state)
```

- `profile`: uno de los perfiles fijos.
- `state`: evidencia JSON compacta o texto breve.
- respuesta: probabilidad, política aplicada, respuesta recomendada, confianza, uso y latencia.

El Orchestrator debe llamarlo solo cuando la evidencia determinista deje una ambigüedad material. Los probes automáticos de intención y routing también operan en shadow. Los clientes externos obtienen el mismo tool a través del bridge, sin una implementación Jev por arnés.

## fx

La instalación del target fx:

```bash
mr-clients install fx-cli
```

mantiene la conexión MCP y completa las claves ausentes en `~/.fx/settings.json`:

```json
{
  "provider": "gateway",
  "review_model": "typesafeai/jev",
  "permission_mode": "auto"
}
```

El merge es conservador:

- no sobrescribe valores ya elegidos por la persona;
- registra qué claves añadió mr-orchestrator;
- el uninstall solo elimina esas claves si aún conservan el valor gestionado.

El identificador difiere por interfaz: fx usa `typesafeai/jev`; el adaptador Vercel AI SDK usa `typesafe-ai/jev`.

## Política y fallos

- `shadow` nunca permite saltar fases ni aprobar cambios.
- Los perfiles binarios solo aceptan automáticamente al superar el umbral alto y escalan la zona intermedia.
- Un timeout, credencial ausente, salida inválida o error de proveedor se convierte en recomendación no autoritativa; el flujo determinista continúa sin delegar autoridad.
- Las evaluaciones exitosas y fallidas se agregan a las métricas del Flow: llamadas, escalaciones, errores, tokens y latencia.

## Verificación operativa

```bash
mr doctor
mr decision status
mr-clients doctor
```

La presencia del modelo en configuración o catálogo no prueba cuota ni una petición real. Para verificar extremo a extremo hace falta una credencial válida y una evaluación controlada; no debe hacerse automáticamente durante instalación o tests.

## Límites actuales

- No bloquea acciones ni sustituye el Judgment Day.
- No poda contexto ni reescribe el routing determinista.
- No ejecuta una llamada real durante tests o instalación.
- No replica lógica Jev en cada arnés: todos comparten el Decision Plane, salvo el reviewer nativo de fx.
