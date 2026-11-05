# Benchmark de export en la PC del dueño (5 nov 2026)
Ryzen 9 5900X (12 núcleos) + RTX 3070, ffmpeg 8 de `tools/`, `tools-dev/bench_export.js`.

| Fuente | Variante | Tiempo | Calidad |
|---|---|---|---|
| sintética 240 s (5 pedazos → 100 s) | CPU lee + NVENC | 27.9 s | PSNR/SSIM iguales |
| | GPU lee + NVENC | 30.6 s (+10 %) | idéntica bit a bit (PSNR inf) |
| directo real 2 h 12 (8 pedazos → 240 s) | CPU lee + NVENC | 66.5 s | iguales |
| | GPU lee + NVENC | 68.7 s (+3 %) | idéntica bit a bit |

**Decisión:** decodificar por GPU queda APAGADO por defecto (`EMM_GPU_DECODE=1` lo prende). En esta PC el procesador
decodifica más rápido que NVDEC; la GPU sigue codificando (NVENC) como siempre.
