# Reporte — Tarea 5: Línea del tiempo (rama `nube/timeline`)

## Qué hice
Reutilicé `lib/timeline-core.js` (la lógica pura que ya estaba en la rama) y lo conecté a la app. `server.js` ahora lo sirve como `/timeline-core.js` y `index.html` lo carga antes de `app.js`.

- **Zoom de la línea del tiempo:**
  - Se controla con los botones **− / +**, el botón nuevo **↔ Ajustar** (ver todo), **Ctrl+rueda** (acerca sobre el punto del ratón) y las teclas **+ / −**.
  - Con zoom, la rueda sola desplaza a los lados y la línea del tiempo sigue al cabezal mientras reproduce.
  - El máximo depende de la duración: ~240 px por segundo, sin pasar de 4 millones de px de ancho (un directo de 6 h).
  - La regla solo dibuja las marcas visibles. Antes dibujaba todas, y con zoom alto serían decenas de miles.
- **Recortar arrastrando bordes:** ya existía. Ahora:
  - no se encima con el clip vecino del video (no duplica pedazos);
  - el mínimo es 0.2 s;
  - tiene imán al cabezal (8 px);
  - muestra la duración mientras arrastras;
  - queda en el historial. Antes el recorte no se podía deshacer.
- **Atajos:** solo funcionan en el Paso 1 y nunca mientras escribes en un campo.
  - **Espacio:** reproducir / pausa.
  - **J / K / L:** atrás / pausa / adelante. L otra vez sube a 2×, 4× y 8×. J va hacia atrás saltando y sin audio, porque el navegador no reproduce en reversa.
  - **S:** divide (además de **D**).
  - **Ctrl+Z:** deshacer. **Ctrl+Y** o **Ctrl+Shift+Z:** rehacer.
  - La velocidad se ve junto al zoom (por ejemplo, ▶▶ 2×).
- **Deshacer y rehacer que se guardan:**
  - Guarda los últimos 50 pasos **por video** en localStorage, junto a los clips. Sobreviven a recargar o cerrar la app.
  - Hay un botón nuevo **↷ Rehacer**, y el aviso dice qué se deshizo ("↶ Deshice: recortar clip").
  - **Por qué localStorage y no el servidor:** los clips ya se guardan ahí. Si el historial viviera en `data/`, podría quedar desfasado de los clips (por ejemplo, si se borra el almacenamiento del navegador).
  - Para no pasar del límite (~5 MB) con directos de miles de clips, tira los pasos más viejos hasta que quepa en 1.5 MB (`fitHistory`).
  - Cualquier cambio de clips queda en el historial, aunque venga de "Quitar silencios", del Resumen del directo, etc. Al guardar, compara con lo último guardado y adivina el nombre del paso (`describeChange`).
- **👁️ Vista de la edición:** botón nuevo en la barra de la línea del tiempo. Reproduce como quedará, **sin exportar**:
  - salta los clips borrados, los silencios quitados y los cortes;
  - sigue el orden de los clips, también si los reordenaste;
  - deja **en silencio** las groserías que se van a silenciar;
  - muestra un letrero sobre el video ("dura 00:00:30 · se salta 1 parte quitada · N groserías en silencio · Esc para salir").
  
  Usa las mismas reglas que `/api/export` (`editPlan`):
  - **Con clips editados:** reproduce los clips y silencia las groserías marcadas (y todas si está "censurar todas").
  - **Sin edición, modo Silenciar:** video completo, con silencio en las groserías marcadas y en los cortes manuales.
  - **Sin edición, modo Cortar:** salta las groserías marcadas, las pausas marcadas y los cortes manuales.
  
  Revisa la posición en cada fotograma (`requestVideoFrameCallback`) y usa el mismo margen de silencio de 0.15 s que el export.
- **Ids:** los ids existentes no cambiaron. Ids nuevos: `tlZoomFit`, `tlZoomLevel`, `tlRate`, `tlRedo`, `tlEditView`, `editViewBadge`. El CSS nuevo va en un solo bloque al final de `style.css`.

## Cómo probarlo
```bash
node tests/timeline.test.js
```
Son 24 pruebas; 6 son nuevas y cubren el plan de la vista en los 3 modos, el mensaje de deshacer, que el historial quepa y se recupere, el zoom máximo y el ancla del zoom. Todas las pruebas de `tests/` pasan.

**Prueba en el navegador:** Playwright, video de prueba de 40 s, servidor en el puerto 4420. Pasos y resultados:
1. S, S divide en 10 s y 20 s; Supr borra el clip de 10 a 20 s.
2. Ctrl+rueda acerca a 1.9× (16 marcas en la regla); Ajustar regresa a 1×.
3. Arrastrar el borde recorta el clip a 8.06 s; Ctrl+Z lo regresa.
4. Después de **recargar la página**, Ctrl+Y rehace el recorte. Ctrl+Z dos veces y Ctrl+Shift+Z también funcionan.
5. L, L pone 2×; K pausa; J retrocede; Espacio reproduce.
6. Vista de la edición desde 8.5 s: pasa de 9.79 s a **20.00 s** (salta el hueco), y Esc sale.

Capturas: `docs/capturas/timeline_*.png`.

**A mano:** abre un video, divide, borra y recorta clips, y pulsa **👁️ Vista de la edición**.

## ⚠️ Antes de publicar en main
Hay que agregar **`"lib/timeline-core.js"`** a `version.json` → `files`. Si falta, el navegador no carga la lógica nueva. La app sigue funcionando, pero con el deshacer viejo, sin rehacer, sin Vista de la edición y con el zoom limitado.

## Riesgos
- **Saltos de la Vista de la edición:** cada salto es una búsqueda (seek) del navegador.
  - Con el `.mpg` original no funciona; hace falta la "vista previa MP4" y la app lo avisa.
  - Con un MP4 de 1080p60 de 6 h, cada salto puede tardar ~0.1–0.3 s. Es solo una vista previa: no cambia el export.
- **Silencio de groserías en la vista:** usa los tiempos de whisper con 0.06 s de aire más 0.15 s de margen. El export calcula el aire con la palabra vecina, así que puede variar unas centésimas. En la vista se calla un poco más, nunca menos.
- **J (atrás)** salta cada 120 ms; con videos pesados puede verse a tirones.
- **El historial vive en el navegador:** en otro navegador o en modo incógnito no está (igual que los clips hoy).
- **Al recortar,** los clips de la derecha se recorren (como en CapCut), así que si arrastras mucho, el borde no siempre queda bajo el ratón.

## Qué falta / ideas
- Que la línea del tiempo se desplace sola al recortar cuando el ratón llega a la orilla con zoom.
- Mini-mapa del directo completo arriba de la línea del tiempo (§3.4 de la investigación).
- Marcas de entrada/salida (I/O) y marcadores (M): `keyAction` ya reconoce esas teclas, falta conectarlas.
- Visto de paso (ya pasa en `main`, no es de esta rama): al abrir la app sin estado sale en consola `Cannot read properties of null (reading 'filmstrip')`.
