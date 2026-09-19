# Context Pruning & Compaction con Jev

**JevCompactor** sustituye resúmenes generativos por poda literal de salidas
antiguas de herramientas. Se conecta al hook
**experimental.chat.messages.transform** de OpenCode y solo se activa cuando el
contexto alcanza el presupuesto configurado.

## Invariantes

- Nunca modifica mensajes system, el último mensaje user, estados de tool con
  error, líneas con errores no resueltos ni líneas que parezcan contener secretos.
- Cada bloque marcado KEEP se conserva byte por byte. No se reescribe, resume ni
  normaliza.
- Los bloques DROP se reemplazan por un marcador con el número de líneas podadas.
- Todos los candidatos se evalúan como preguntas independientes en una única
  llamada a experimental_evaluate; Vercel AI Gateway realiza un solo POST al
  endpoint evaluation-model.
- Timeout total máximo: 1500 ms, sin reintentos. Error, timeout, respuesta
  incompleta o un DROP con confianza inferior al mínimo activan un fallback FIFO
  determinista sobre tool outputs antiguos.
- El state remoto es breve, está acotado y sanea patrones de credenciales.

La API pública es:

    const compactor = new JevCompactor();
    if (compactor.shouldCompact(context)) {
      context = await compactor.compact(context);
    }

## Configuración

La integración del plugin es opt-in:

    export MR_CONTEXT_COMPACTION=jev
    export AI_GATEWAY_API_KEY='...' # recomendado para Vercel AI Gateway

También se acepta **JEV_API_KEY** como alias específico del módulo. No guardes
ninguna credencial en el repositorio.

| Variable | Default | Descripción |
|---|---:|---|
| MR_CONTEXT_COMPACTION | off | Usa jev, on o true para activar el interceptor |
| AI_GATEWAY_API_KEY | — | Credencial estándar de Vercel AI Gateway |
| JEV_API_KEY | — | Alias de credencial para el compactor |
| JEV_API_URL | Gateway SDK | Base URL alternativa del endpoint Gateway v4 |
| JEV_MODEL | typesafe-ai/jev | ID del evaluation model |
| JEV_CONTEXT_WINDOW_TOKENS | 200000 | Límite usado si el host no informa otro |
| JEV_COMPACTION_TRIGGER_RATIO | 0.75 | Fracción que dispara la compactación |
| JEV_COMPACTION_TARGET_RATIO | 0.55 | Objetivo del fallback determinista |
| JEV_COMPACTION_DROP_THRESHOLD | 0.70 | p(drop) mínima |
| JEV_COMPACTION_MIN_CONFIDENCE | 0.50 | Confianza mínima para ejecutar DROP |
| JEV_COMPACTION_TIMEOUT_MS | 1500 | Timeout; el schema prohíbe valores mayores |
| JEV_COMPACTION_TOOLS | bash,shell,terminal,read,read_file,grep,glob | Tools elegibles |
| JEV_COMPACTION_EVALUATION_TYPE | boolean | boolean o choice |

La especificación actual de Vercel AI SDK llama **boolean** a la evaluación
binaria que el enfoque fast-jev-compaction denomina “noul”. **choice** usa las
clases literales KEEP y DROP.

## Interceptor

**chat.params** registra el límite real del modelo por sesión. Antes de cada
llamada al LLM, **experimental.chat.messages.transform** calcula el tamaño actual
usando el conteo reportado por el host y una estimación UTF-8 conservadora. Al
superar el umbral:

1. localiza resultados antiguos y voluminosos de tools elegibles;
2. los divide en bloques de líneas con chunk_id temporal;
3. crea un estado breve con objetivo, archivos modificados, fase y presupuesto;
4. evalúa los bloques en paralelo dentro de un solo request;
5. reensambla el mismo árbol de mensajes sustituyendo únicamente rangos DROP.

La implementación solicita **gateway.zeroDataRetention=true**. Si la cuenta o el
proveedor no soportan esa política, la petición falla y se usa el fallback
determinista; la ejecución del agente continúa.
