# Reporte — Tarea 3 (avance): Export más rápido con la misma calidad (rama `nube/export-rapido`)

> Esta rama adelanta la parte de la tarea 3 que no choca con la tarea 2. **No toca `server.js`**: la integración va sobre `nube/export-intro` cuando esa rama termine.

## Qué hice
- **`lib/hwaccel.js`** + `tests/hwaccel.test.js` (8 pruebas):
  - `decodeArgs`: agrega solo `-hwaccel cuda`, **sin** `-hwaccel_output_format cuda`, para que los filtros actuales (trim, concat, xfade, crop, drawtext) sigan igual y no se llene la memoria de video con las ~100 entradas por tanda de `exportBatched`.
  - `withHwaccel`: pone `-hwaccel cuda` antes de cada `-i` de video, respetando el `-ss`/`-t` del pre-roll; no lo pone en `lavfi`, `concat`, imágenes, subtítulos ni audio.
  - `isHwaccelFailure` y `runWithHwFallback`: si falla NVDEC, reintentan el mismo comando sin GPU.
  - `probeCuda`: decodifica un video mínimo de verdad, guarda el resultado y nunca truena.
  - **La calidad no cambia**: decodificar H.264 da los mismos cuadros por GPU que por CPU; solo cambia quién decodifica.
- **`tools-dev/bench_export.js`**: repite el método del export (pre-roll de 15 s, `trim`/`atrim`, `concat`, una sola codificación con los mismos parámetros que `cutVnvenc`/`cutVx264`) con decodificación por CPU y por GPU. Mide tiempo, velocidad, fps, PSNR/SSIM contra una referencia sin pérdida, duración y sincronía (destello contra beep), y compara GPU contra CPU directo. Sale con código 2 si la sincronía se pasa de un cuadro.
- `tools-dev/avsync.js`: copiado tal cual de `nube/export-intro`.

## Medición en la nube (sin GPU)
La variante GPU se omitió: `ffmpeg` dice soportar CUDA pero la decodificación real falla, y `probeCuda` lo detectó bien. Fuente sintética MPEG-TS 1080p60 de 45 s, 4 pedazos = 22.5 s de salida:

| Variante | Tiempo | Velocidad | fps | PSNR | SSIM | Duración salida / esperada | Sincronía máx | ±1 cuadro |
|---|---|---|---|---|---|---|---|---|
| Decodifica CPU + libx264 (medium, crf 18) | 73.8 s | 0.31× | 18.3 | 26.1 dB | 0.981 | 22.533 / 22.512 s | 16 ms | sí |

El PSNR sale bajo por el ruido que la fuente sintética trae a propósito; lo que importa es comparar CPU contra GPU en la misma PC.

## Cómo medir en la RTX 3070
```bash
runtime\node.exe tools-dev\bench_export.js --seconds 240 --runs 3 --json bench_sintetico.json
```

Con un directo real (la sincronía sale "n/a", pero tiempo y calidad sí):
```bash
runtime\node.exe tools-dev\bench_export.js --src "D:\ruta\directo.mpg" --clips 8 --clip-len 30 --runs 2 --json bench_real.json
```
Para comparar contra CPU puro se agrega `--encoder libx264`. **Criterio para dejar la GPU por defecto:** la fila "GPU vs CPU" con SSIM ≥ 0.999, sincronía "sí" y menos tiempo.

## Cómo integrarlo en `server.js` (sobre `nube/export-intro`)
1. Requerir `./lib/hwaccel` y calcular `hw = gpu && await probeCuda(bins.ffmpeg)`.
2. `exportVideo`, modo Cortar: envolver los args con `withHwaccel(..., {gpu: hw})`. En el `catch` de NVENC que ya existe, revisar primero `isHwaccelFailure`: si es eso, reintentar con el mismo encoder sin GPU; si no, seguir con la caída actual a `cutVx264`.
3. `exportBatched`: lo mismo dentro de `args(enc)`, con una variable `useHw` que se apaga en la primera falla (igual que `useGpu`).
4. Silenciar con `-c:v copy` no aplica (no decodifica video). Sí aplica en `fxArgs` y en Silenciar con reescalado.

## Pasadas innecesarias encontradas (solo análisis, sin tocar código)
1. **Intro/outro vuelve a codificar todo el video por CPU** (`finalizeExport` usa `HQ_VIDEO` = libx264). Es la mayor ganancia: crear intro/outro con los mismos parámetros que el video y unir con el concat demuxer y `-c:v copy`.
2. En Silenciar con reescalado y animación, `applyClipAnim` reencoda todo otra vez; el escalado puede ir en el mismo filtro de `fxArgs`.
3. Con Voz Estudio el audio se codifica en AAC dos veces.
4. Las tandas de `exportBatched` van una por una; se podrían probar 2 en paralelo con NVENC.

## Riesgos
- Cerca de 100 decodificadores NVDEC abiertos en una tanda es mucho; si da errores, limitar la GPU a exports con ≤ 20 entradas.
- Probar con drivers viejos en la PC real.
- Copiar cada cuadro de la GPU a la RAM cuesta; en algunos CPUs la ganancia puede ser chica.

## Qué falta
- Integrar en `server.js` (después de la tarea 2), medir en la 3070 y anotar resultados.
- Quitar la doble codificación de intro/outro.
- Al publicar: agregar `lib/hwaccel.js` a `version.json` → `files`.
