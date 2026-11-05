# Reporte — Hallazgo: los cortes no caen en el cuadro pedido (MPEG-TS)

## Qué encontré
El export abre cada pedazo con `-ss` unos segundos antes (hasta 15 s) y corta con `trim=start=<pre>` **relativo**. Ese método supone que, después de `-ss`, el tiempo 0 es exactamente el punto pedido. En MPEG-TS **no es así**: ffmpeg pone el 0 donde realmente cayó el salto, y eso varía.

Medido con `node tools-dev/check_cut.js` (ffmpeg 6.1, fuente sintética MPEG-TS 60 fps, GOP de 2 s):

| Archivo | Método actual | `-copyts` + `trim` en tiempo absoluto |
|---|---|---|
| `start_time` 1.4 s (tiempos 30 / 60 / 90 s) | **84–86 cuadros antes (~1.4 s)** | **exacto** |
| `start_time` 31.4 s (tiempo 61.25 s) | **10 cuadros antes** | **exacto** |

- El error **cambia según el archivo y el punto**, así que no se arregla sumando un número fijo.
- Audio y video se recorren **juntos**, por eso la sincronía A/V sale bien aunque el corte esté movido. Explica también los ~16 ms de diferencia de sincronía que vieron las pruebas de la intro de avance (`docs/REPORTE_export-intro.md` en `nube/export-intro`): el audio y el video del MPEG-TS empiezan en tiempos un poco distintos.
- Afecta a todo lo que usa ese patrón: export en modo Cortar (`server.js`, `vIn`/`aIn` y las tandas), la intro de avance y el PNG de miniaturas.
- Los pedazos que empiezan antes de 15 s (sin salto real) sí caen exacto.

## Cómo comprobarlo en las PCs (Windows, con su ffmpeg de `tools/`)
Con la fuente sintética:
```bash
runtime\node.exe tools-dev\check_cut.js
```
Con un directo real de Kick (lo más importante, porque el ffmpeg de los usuarios puede ser otra versión):
```bash
runtime\node.exe tools-dev\check_cut.js --src "D:\ruta\directo.mpg" --times 600,3600,7200
```
Sale con código 1 si el método actual no cae en el cuadro pedido.

## Arreglo propuesto (NO aplicado todavía)
Abrir cada entrada con `-copyts -ss <s>` y cortar con `trim`/`atrim` sobre el **tiempo absoluto** (`start_time` del formato + tiempo del pedazo), y luego `setpts=PTS-STARTPTS`/`asetpts=PTS-STARTPTS`. Cada stream conserva su marca de tiempo real, así que el corte cae exacto sin importar dónde quedó el salto, y audio y video se cortan en el mismo instante real.

No lo cambié en el export porque toca el corazón de la calidad y la sincronía. Antes de aplicarlo:
1. Correr `check_cut.js` con un directo real en la PC de los usuarios.
2. Aplicarlo en una rama (`vIn`/`aIn`, tandas, intro de avance, miniaturas) y pasar `tools-dev/teaser_e2e.js` y `tools-dev/avsync.js` midiendo **sincronía y cuadro exacto**.
3. Revisar directos donde las marcas de tiempo del MPEG-TS dan la vuelta (33 bits ≈ 26.5 h); ffmpeg suele corregirlo, pero hay que probarlo.
4. Revisar el audio igual que el video (este script solo compara cuadros de video).
