# Reporte — Tarea 6: Miniaturas y cola de exports (rama `nube/miniaturas-cola`) — **A MEDIAS**

> ⚠️ **No publicar todavía.** Falta la interfaz y el PNG puede salir de otro momento a mitad del video (ver Riesgos).

## Qué hice
- **`lib/thumbs.js`** (sirve en Node y en el navegador) + `tests/thumbs.test.js`:
  - Elige qué fotogramas mostrar: todo el video (sin el primer y último 1 %), alrededor de un momento, o los mejores momentos de `data/bestof.json` por score (sin resumen usa todo el video).
  - Puntúa qué tan expresiva es una cara con datos de MediaPipe: boca abierta, sonrisa, cejas arriba y ojos muy abiertos suben; ojos cerrados, cara chica o en la orilla y foto movida bajan.
  - Da las mejores sugerencias sin repetir casi el mismo momento.
- **`lib/queue.js`** + `tests/queue.test.js`: cola de exports con estados en espera / exportando / listo / error / cancelado.
  - Guarda una copia de las opciones al agregar; se puede cancelar, quitar, reintentar y mover.
  - Al reabrir la app, lo que estaba exportando queda como error y la cola en pausa.
  - Salta los exports de otro video con aviso.
- **`server.js`**:
  - El botón "Exportar MP4" y la cola llaman a la misma función, así que la calidad y el método de export no cambian. `renderShort` ahora usa `renderShortClip(clip)`, que es lo que llama la cola.
  - `/api/thumbs/plan` (tiempos, tamaño, fps), `/api/thumbs/frame` (JPG chico para la galería, en caché en `data/thumbs/`, máximo 2 ffmpeg a la vez, no se mete con Cancelar ni con un export) y `/api/thumbs/save` (PNG del original sin reescalar en `exports/` + copia a Descargas; salto 3 s antes + `trim`; BT.709 si el video no trae etiqueta de color).
  - `/api/queue` y `/api/queue/add|start|pause|cancel|remove|retry|move|clear`; la cola se guarda en `data/export_queue.json`.
  - Se sirven `/lib/thumbs.js`, `/miniaturas.js` y `/cola.js` (estos dos aún no existen).

## Cómo probarlo
```bash
for f in tests/*.test.js; do node "$f"; done
```
Medido con un video de prueba MPEG-TS 1080p60 de 90 s: el plan regresa 12 tiempos con 1920×1080 a 60 fps; el JPG de la galería pesa ~10 KB (~15 ms en caché); los PNG salen 1920×1080 `rgb24`.

## Riesgos
- **El PNG puede salir de otro momento.** En t=0.5 s el PNG es exactamente el cuadro 30 (bien), pero en 37.5, 61.25 y 88.9 s **no** es el cuadro esperado, ni a ±2 cuadros. Probable causa: con MPEG-TS, `-ss` antes de `-i` cae tarde (hasta ~1.3 s) y el `trim` relativo asume que cayó exacto. Siguiente paso: medir contra `select=eq(n\,N)` decodificando desde el inicio en un rango de ±150 cuadros y corregir (`-copyts` con `trim` sobre el tiempo absoluto restando el `start_time` del MPEG-TS, o `-ss` como opción de salida en una ventana corta).
  - **Ojo:** conviene revisar si el mismo supuesto afecta al export (pre-roll de 15 s + `trim`); el export ya se midió con sincronía A/V correcta, pero la sincronía puede estar bien aunque el corte empiece unos cuadros antes o después.
- La cola sabe que terminó un export cuando el trabajo deja de estar "en curso" (revisa cada 0.7 s). Si otro proceso arranca justo en ese hueco, podría confundirse. Es raro.
- A los Shorts encolados les falta correr `visionBeforeRender` al agregarlos (va con la interfaz).

## Qué falta
1. Interfaz: `miniaturas.js` (galería, ◀ ▶ un cuadro, "Guardar PNG", "✨ Sugerir caras expresivas" con FaceLandmarker `outputFaceBlendshapes:true` usando `MP_BASE`/`MP_MODELS` de `vision.js`, aviso si no carga sin internet) y `cola.js` (lista con estados y botones, "➕ Agregar a la cola" junto a "Exportar MP4" y en cada Short).
2. Corregir y medir la precisión del fotograma.
3. Probar la cola con 2 exports reales.
4. Fusionar `main` (1.27.13) y acomodar la interfaz en el rediseño de `nube/diseno`.

**Antes de publicar en `main`:** agregar `lib/thumbs.js` y `lib/queue.js` a `version.json` → `files` (sin ellos la app no arranca porque `server.js` los usa), y `miniaturas.js` y `cola.js` cuando existan.
