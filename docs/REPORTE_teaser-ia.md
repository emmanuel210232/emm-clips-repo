# Reporte — Avance elegido por la IA (rama `nube/teaser-ia`)
Sale de `nube/export-intro` (ya trae el corte exacto). No toca `buildTeaserGraph`, `exportVideo`, `exportBatched`, `version.json` ni `APP_VERSION`.

## Qué hice
- **Prompt del Resumen del directo** (mismo llamado a Claude Sonnet 5.5, sin uno extra): por cada momento, la IA da su mejor pedazo de 6–10 s para el avance, lo más fuerte pero **sin revelar el desenlace ni el remate**, empezando y terminando en frase completa. Campos planos `av_ini`, `av_fin`, `av_hasta` (últimas 2–5 palabras exactas) y `av_por` (por qué engancha); se guardan en `data/bestof.json` como `avance: {inicio, fin, por_que}`.
  - Son **planos** a propósito: si la respuesta llega cortada, el lector solo rescata objetos planos.
  - Costo extra: ~150 palabras más de instrucciones y ~40 tokens de respuesta por momento.
- **`lib/teaser.js`**:
  - `readAvance`: valida 4–12 s dentro del momento (±1.5 s); entiende tiempos relativos, `m:ss`/`h:mm:ss` y "83.5 s"; si viene mal, `null`.
  - `refineAvance`: con `av_hasta` busca esas palabras en la transcripción y corta justo donde terminan (antes del remate); el inicio se pega al inicio de una frase a ≤ 3 s.
  - `pickMoments`/`planTeaser`: si hay avance válido que no cae en algo quitado, se usa (`source: 'ia'`); si no, la ventana con más energía como antes.
- **Interfaz**: en "👀 Ver qué momentos entran", los fragmentos de la IA muestran "✨ Elegido por la IA: <por qué>".

## Cómo probarlo
```bash
node tests/teaser.test.js
```
3 pruebas nuevas con respuestas de ejemplo (absolutas, relativas, texto, muy cortas o largas, fuera del momento, rotas). Todas las pruebas de `tests/` pasan (80; 1 saltada de siempre).
En la PC: "Resumen del directo" con la nube y luego "👀 Ver qué momentos entran" en Exportar.

## Riesgos
- No se probó con la API real (sin clave en la nube); solo con respuestas de ejemplo.
- Si el modelo no copia exacto `av_hasta`, el final queda en su tiempo aproximado y podría incluir parte del remate.
- Los `bestof.json` viejos no traen `avance`: usan la energía como antes.
- Al fusionar con `nube/export-intro`: cambios en `pickMoments`/`planTeaser`, el prompt y lector del Resumen y `renderTeaserList`; no deberían chocar con el export.

## Qué falta
- Probar con un directo real y la API; revisar en 3–4 avances que no se vea el remate.
- Cortar al nivel de palabra (hoy es al nivel de segmento de whisper).
