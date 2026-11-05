# Reporte — Corte exacto en el export + decodificación por GPU (rama `nube/export-intro`)

> ⚠️ **No publicar sin verificar:** la prueba de punta a punta con el export completo no alcanzó a terminar en la sesión.

## Qué hice
### 1. Corte exacto en todo lo que corta pedazos del video (`lib/seek.js`)
Antes: `-ss <antes> -i` + `trim=start=<pre>` **relativo**. En MPEG-TS ffmpeg cuenta el tiempo desde donde **cayó** el salto, no desde el punto pedido → el pedazo empezaba hasta ~1.4 s (≈85 cuadros) antes (medido con `tools-dev/check_cut.js`).
Ahora: `-copyts` + `trim`/`atrim` sobre el tiempo **absoluto** (start_time del archivo + tiempo de la app), con el mismo salto de 15 s antes. Audio e imagen se cortan en el mismo instante real.

Dónde se aplicó (`server.js`):
- Exportar en modo Cortar: ≤ 120 clips (una entrada por clip) y > 120 con crossfade (una sola entrada, trims absolutos).
- Exportar por tandas (> 120 clips): tramos con `exactInput`, cada clip con `absTrims`.
- Intro de avance: `buildTeaserGraph` (`lib/teaser.js`) recibe `fmtStart`; parte 0 de las tandas, avance en la misma pasada y Silenciar + avance. En Silenciar + avance el video completo se rebasa con `setpts=PTS-<start_time>/TB` (lo mismo que hace ffmpeg sin `-copyts`) para que los rangos de groserías caigan igual.
- Shorts: render final, encuadre (`framingForClip`), cuadros para MediaPipe y energía del audio (zooms). El audio del Short ahora siempre pasa por filtro (`atrim` exacto).
- "Exportar frame": cuadro exacto a resolución completa (antes doble `-ss`).
- Clips de revisión ("revisar momento" y "revisar corte"): exactos; claves de caché nuevas (`review2_…`, `review_cut2_…`) para no reusar clips viejos corridos.
- Sin cambio (aproximados a propósito): miniaturas de la línea del tiempo, cuadros de revisión de contenido sensible y miniaturas de caras.

### 2. Decodificación por GPU (NVDEC) con caída automática a CPU
`runDec` en `server.js`: si `probeCuda` confirma que la GPU decodifica, agrega `-hwaccel cuda` antes de cada entrada de video (`withHwaccel`), sin `-hwaccel_output_format cuda` (filtros y codificador iguales → **misma calidad**). Si falla (error de CUDA/NVDEC o falla en los primeros 30 s), repite el **mismo** comando por CPU y no lo vuelve a intentar en esa sesión. Si no hay GPU, el comando es idéntico al de antes. Aplicado en Cortar, tandas, avance (parte 0), Silenciar + avance y Silenciar + efecto. La caída NVENC → x264 que ya existía sigue igual.

### 3. Prueba de punta a punta (`tools-dev/teaser_e2e.js`)
- Nueva medición de **cuadro exacto**: cada destello de la salida debe caer donde lo predicen los tiempos pedidos, con tolerancia de 30 ms (< 2 cuadros). Con el método viejo fallaba por ~1400 ms.
- Sincronía contra 0 ms (sincronía real): la fuente pone destello y bip en el mismo instante. Los ~21 ms que se medían en la fuente MPEG-TS son un artefacto (su video empieza 21 ms después que su audio). Antes la prueba comparaba contra esos 21 ms y marcaba fallas de 17.2 ms que no eran reales.

## Mediciones
- Unitarias: 77 pasan, 0 fallan, 1 saltada (la de siempre).
- Corte exacto con ffmpeg 6.1: 3 pedazos de una fuente MPEG-TS 1080p60 caen en el cuadro pedido y la sincronía queda en 4.7 ms en todos los pares (< 1 cuadro). `check_cut.js`: método viejo −84 a −86 cuadros; método nuevo 0.
- **No verificado con el export completo:** la prueba A/B/C no terminó en la sesión y "Exportar frame" no se probó contra el servidor. **Es lo primero que hay que correr.**
- GPU: aquí no hay NVDEC funcional; `probeCuda` = false → el comando queda igual que antes. Falta medir en la RTX 3070.

## Cómo probar
```bash
for f in tests/*.test.js; do node "$f"; done
```

```bash
node tools-dev/check_cut.js
```

```bash
node tools-dev/check_cut.js --src "D:\ruta\directo.mpg" --times 600,3600,7200
```

```bash
node tools-dev/teaser_e2e.js 240 ABC
```

```bash
runtime\node.exe tools-dev\bench_export.js --seconds 240 --runs 3
```
Con ffmpeg 6.x, `teaser_e2e.js` necesita `FFMPEG_BIN` apuntando a una envoltura que cambie `-/filter_complex` por `-filter_complex_script`.

## Riesgos
- Toca el corazón del export: **no publicar** sin correr `teaser_e2e.js` (A, B, C) y `check_cut.js` con un directo real en la PC de los usuarios (su ffmpeg puede ser otra versión).
- `-copyts` con marcas de tiempo que dan la vuelta en MPEG-TS (33 bits ≈ 26.5 h): ffmpeg suele corregirlo; probar un directo largo real.
- Si alguien compensaba a mano el corrimiento de ~1.4 s, sus cortes van a quedar distintos (ahora correctos).
- `runDec`: una falla real en los primeros 30 s se reintenta una vez por CPU (tarda el doble en ese caso raro).
- Fusión con `nube/miniaturas-cola`: allí el render de Shorts se movió a `renderShortClip`; hay que llevar el corte exacto (render, encuadre, vision y energía) a esa función al fusionar.

## Qué falta
- Correr la prueba de punta a punta A/B/C y verificar "Exportar frame".
- Medir GPU vs CPU en la RTX 3070 con `bench_export.js`.
- Quitar la doble codificación de intro/outro (`finalizeExport`): no se hizo porque unir sin reencodear exige que el SPS/PPS del intro coincida con el del video; necesita su propia prueba en la RTX.

## Archivos nuevos para version.json → files (al publicar)
`lib/seek.js`, `lib/hwaccel.js`, `lib/teaser.js` (`server.js` requiere seek y hwaccel: **sin ellos la app no arranca**).
