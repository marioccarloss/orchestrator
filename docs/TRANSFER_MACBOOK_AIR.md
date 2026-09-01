# Guía de Transferencia y Replicación para MacBook Air
### Destino: Mario Carlos Roca Peñafiel Victoria's MacBook Air

Esta guía describe el procedimiento exacto para empaquetar, transferir, restaurar y ejecutar `mr-orchestrator` en la MacBook Air de Mario Carlos Roca Peñafiel (o en cualquier máquina adicional) **sin subir el código a ningún repositorio remoto**.

---

## 1. Empaquetado Limpio en la Máquina de Origen

Para transferir el proyecto sin arrastrar dependencias compiladas ni archivos temporales (`node_modules`, `dist`, `.DS_Store`), genera un archivo comprimido limpio ejecutando en la terminal de origen:

```bash
cd ~/Projects
tar --exclude="mr-orchestrator/node_modules" \
    --exclude="mr-orchestrator/dist" \
    --exclude="mr-orchestrator/.DS_Store" \
    -czvf mr-orchestrator-bundle.tar.gz mr-orchestrator
```

Esto generará el archivo `~/Projects/mr-orchestrator-bundle.tar.gz` (de menos de 1 MB de peso).

---

## 2. Métodos de Transferencia a la MacBook Air

Puedes transferir el archivo `mr-orchestrator-bundle.tar.gz` mediante cualquiera de estos métodos:

### Opción A: AirDrop (Recomendado entre Macs)
1. Abre **Finder** en la máquina de origen.
2. Haz clic derecho sobre `mr-orchestrator-bundle.tar.gz` → **Compartir** → **AirDrop**.
3. Selecciona **Mario Carlos Roca Peñafiel Victoria's MacBook Air**.
4. Acepta la transferencia en la MacBook Air (el archivo se guardará en `~/Downloads/`).

### Opción B: Copia Directa por Red Local (rsync / scp)
Si ambas máquinas están en la misma red Wi-Fi y tienes SSH habilitado:
```bash
scp ~/Projects/mr-orchestrator-bundle.tar.gz usuario@ip-macbook-air:~/Downloads/
```

O sincronizar directamente la carpeta completa:
```bash
rsync -avz --exclude 'node_modules' --exclude 'dist' ~/Projects/mr-orchestrator/ usuario@ip-macbook-air:~/Projects/mr-orchestrator/
```

### Opción C: Memoria USB / Disco Externo
1. Copia `mr-orchestrator-bundle.tar.gz` a una memoria USB.
2. Conéctala a la MacBook Air y copia el archivo a `~/Downloads/`.

---

## 3. Puesta en Marcha en la MacBook Air de Destino

Sigue estos pasos en la terminal de la MacBook Air:

### Paso 1: Descomprimir en `~/Projects`
```bash
mkdir -p ~/Projects
cd ~/Projects
tar -xzvf ~/Downloads/mr-orchestrator-bundle.tar.gz
```

### Paso 2: Verificar la variable `$PATH`
Asegúrate de que `~/.local/bin` esté en tu `$PATH`:
```bash
echo $PATH | tr ':' '\n' | grep "\.local/bin"
```
Si no aparece, agrégalo a tu `~/.zshrc`:
```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

### Paso 3: Ejecutar el Instalador Autónomo
Ingresa al directorio del proyecto y ejecuta el instalador indicando la ruta del workspace:

```bash
cd ~/Projects/mr-orchestrator
chmod +x install.sh
./install.sh --workspace ~/Projects/my-workspace
```

**Lo que sucederá automáticamente:**
1. El script detectará la arquitectura de la MacBook Air (Apple Silicon ARM64 o Intel).
2. Descargará e instalará el runtime aislado de Bun en `~/.local/share/mr-orchestrator/toolchains/bun`.
3. Instalará las dependencias y compilará el código TypeScript.
4. Creará los launchers `mr`, `mrcode` y `bun` en `~/.local/bin/`.
5. Registrará el workspace indicado y generará la configuración de OpenCode.

---

## 4. Verificación en la MacBook Air

Ejecuta el comando de diagnóstico:
```bash
mr doctor
```

Debe mostrar:
```text
┌  mr-orchestrator doctor
│
●  ✓ ~/.local/share/mr-orchestrator/toolchains/bun/bin/bun: 1.2.21
│
│
●  ✓ opencode: 1.18.25
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

Comprueba que `which bun` apunta a `~/.local/bin/bun`:
```bash
which bun
```

Prueba la ejecución de OpenCode con `mrcode`:
```bash
cd ~/Projects/my-workspace/apps/api
mrcode
```

---

## 5. Actualización Futura de Cambios

Si realizas mejoras en la máquina de desarrollo y deseas sincronizarlas a la MacBook Air:
1. Vuelve a generar el `.tar.gz` o envía los archivos modificados.
2. En la MacBook Air, descomprime y ejecuta nuevamente:
```bash
cd ~/Projects/mr-orchestrator
./install.sh
```
El instalador es completamente **idempotente**: compilará los cambios y actualizará los manifests y configuraciones generadas sin duplicar datos ni alterar nada ajeno.
