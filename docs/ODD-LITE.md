# ODD-lite: trabajo cotidiano adaptativo

`mr-orchestrator` separa el trabajo cotidiano del Flow formal. El tamaño o la incertidumbre nunca activan `/flow` automáticamente: Flow sigue siendo una decisión explícita de la persona.

## Rutas

`mr_work_route` decide de forma determinista entre tres rutas:

| Ruta | Cuándo | Contrato |
|---|---|---|
| `read-only` | Explicar, investigar, revisar, proponer o no hay autorización de escritura | No mutar archivos, Git, configuración ni servicios externos. |
| `direct` | Cambio autorizado, entendido, de un archivo y un paso significativo | Aplicar el diff mínimo y ejecutar verificación enfocada. |
| `tracked` | Incidente, 4+ archivos inspeccionados, 2+ archivos previstos o 2+ pasos | Persistir y sincronizar una tarea recuperable antes de la primera escritura. |

La ruta `tracked` usa `mr_work_track` y guarda el estado en:

```text
.mr/odd/tasks/<slug>.md
```

El registro incluye objetivo, alcance, tareas, evidencia y siguiente paso para poder reanudar tras una compactación, cambio de sesión o incidente de worktree/cwd.

## Seguridad transversal

Todos los roles y adaptadores reciben el mismo límite:

- denegar lectura y edición de `.env`, claves SSH, keychains, credenciales cloud/GitHub, certificados y directorios de secretos;
- no descubrir ni reutilizar credenciales o sesiones ambientales;
- pedir autorización explícita antes de `ssh`, `scp`, `sftp` o transferencias remotas con `rsync`;
- no interpretar acceso local como autorización para ejecutar o transferir remotamente.

En OpenCode estas reglas se proyectan además a permisos `read`, `edit` y `bash`. En los demás arneses se incluyen en los adapters nativos.

## Judgment inmutable

Al terminar una implementación `full` o `critical`, el plugin congela el diff exacto en `judgment-candidate.json` y lo liga a su SHA-256. Ambos jueces obtienen ese mismo artefacto mediante `mr_judgment_candidate`, por fragmentos acotados de hasta 12.000 caracteres y siguiendo `nextOffset` hasta `done=true` para no depender del truncado de salida del arnés.

Antes de exponerlo o aceptar un veredicto, el plugin comprueba:

1. que los bytes persistidos conservan su hash;
2. que el hash coincide con la ronda activa;
3. que el diff vivo no cambió desde la congelación.

Si falla cualquiera de las tres condiciones, Judgment se detiene y exige volver a verificar la implementación.
