# Reporte — Ritmo y márgenes para quitar silencios (rama `nube/ritmo`) — **A MEDIAS: falta la interfaz**
Sale de `main` 1.27.13. No toca `version.json` ni `APP_VERSION`.

## Qué hice
- **`lib/pace.js`** (Node y navegador como `window.Pace`) + `tests/pace.test.js` (7 pruebas):
  - `parseSilenceLog(log, duración)`: lee la salida de `silencedetect`.
  - `plan({silences, duration, minPause, padBefore, padAfter, words})` → `{keep, cuts, total, kept, removed}`: **Ritmo** = pausa mínima que se quita (0.20–2.0 s; `Infinity` = "Dejar todas las pausas"); **margen antes** (80 ms por defecto) y **después** (150 ms). Nunca deja pedazos de voz < 0.15 s; no hace cortes < 0.12 s; **no se come palabras** cuando hay tiempos por palabra confiables. Un directo de 6 h (20 000 pausas, 60 000 palabras) se calcula en < 0.5 s.
  - `summary(plan)` → "El video pasa de 4:12:00 a 3:31:10 · 312 cortes (−40:50)".
- **`server.js`**: `POST /api/pace/scan` corre `silencedetect` **una sola vez** con el umbral más sensible (`d=0.2`, −30 dB) y guarda **todas** las pausas en `data/pace_silences.json`; `GET /api/pace/silences` las devuelve; se sirve `/lib/pace.js`. El botón "Quitar silencios" de siempre **no cambió**.

## Cómo probarlo
```bash
for f in tests/*.test.js; do node "$f"; done
```
Con un video de 20 s con huecos de 1.5 s, `POST /api/pace/scan` encontró exactamente las 5 pausas.

## Riesgos
- Directos de 6 h: `data/pace_silences.json` puede pesar ~1 MB (va por su propia ruta, no en `/api/state`).
- Un solo nivel de ruido (−30 dB); con mucho ruido de calle habrá que volver a analizar con otro valor.
- Las palabras solo se protegen cuando whisper da segmentos de una sola palabra.

## Qué falta
- **Interfaz** debajo de "Quitar silencios": "Analizar pausas"; slider "Ritmo" (`Pace.RHYTHM_STEPS`); sliders "Margen antes/después" (0–300 ms) con candado; resumen en vivo; botón "Aplicar" (`pushUndo(); clips = plan.keep; saveClips(); syncRemoved(); buildTimeline();`); `<script src="/lib/pace.js">` acomodado en el rediseño.
- Probarlo con Playwright y con un directo real.
- Al publicar: agregar **`lib/pace.js`** a `version.json` → `files`.
