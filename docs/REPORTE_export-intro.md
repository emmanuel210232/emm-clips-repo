# Reporte — Tarea 2: Intro de avance "PRÓXIMAMENTE..." (rama `nube/export-intro`)
No toca `version.json` ni `APP_VERSION`.

## Qué hace
Nueva opción **"🎞️ Empezar con un avance de los mejores momentos (≈1 min)"**, en el Paso de Exportar y en el Resumen del directo (ahí viene marcada por defecto y, al mandar al editor, deja la casilla de exportar puesta igual). El video empieza con 6 fragmentos de 10 s:
- en orden cronológico, en **blanco y negro**;
- fundidos de 0.5 s entre fragmentos y fundido desde/hacia negro;
- **audio original** con la misma mejora de voz que el video;
- groserías **silenciadas** (sin bip), con los mismos rangos y el mismo margen de 0.15 s que el video;
- letrero **"PRÓXIMAMENTE..."** abajo a la izquierda.

Dura unos 57.5 s y después sigue el video normal. El botón **"👀 Ver qué momentos entran"** muestra los fragmentos (▶ verlo, 🗑️ quitarlo); si revisaste la lista, se exportan esos fragmentos mientras no cambies los clips.

**De dónde salen los momentos**, en orden: 1) `data/bestof.json` del video abierto, por score; 2) la energía del audio (potencia lineal) guardada en `data/energy.json` (el Resumen del directo también la guarda); 3) la transcripción, como último recurso. Dentro de cada momento se toma la ventana de 10 s más fuerte, ajustada al inicio de una frase.

**Nunca se enseña lo que el video quitó:** los huecos de ≥ 1.5 s entre clips se evitan; los huecos chicos (un silencio o una grosería cortada) pueden caer dentro de un fragmento, pero ahí se silencian.

Lógica pura en `lib/teaser.js` con 18 pruebas en `tests/teaser.test.js`. Si falta `lib/teaser.js`, la app arranca igual y solo la opción del avance avisa.

## Cómo se arma
- Cada fragmento es una entrada propia de ffmpeg abierta **15 s antes** y cortada con `trim`/`atrim`, igual que el export normal.
- Al audio de cada fragmento (menos el último) se le quita al final lo que dura el fundido, para que cada pedazo suene justo cuando aparece; `apad,atrim` deja el audio del avance igual de largo que su imagen.
- **Cortar, ≤ 120 clips:** avance y video en una sola pasada (el avance se pega después de los efectos de entrada/salida y antes del reescalado).
- **Cortar por tandas (> 120 clips):** el avance es la "parte 0", con los mismos parámetros que las tandas, y se une sin reencodear. Si la GPU falla, todo el export pasa a CPU.
- **Silenciar:** una sola pasada que silencia, pega el avance y codifica con la calidad alta de siempre. No se une sin reencodear porque el SPS/PPS del H.264 de OBS cambia entre directos (riesgo de cuadros rotos y desfase).
- Si salen menos de 2 fragmentos, se exporta sin avance y el mensaje final lo dice.

## Cómo probarlo
```bash
node tests/teaser.test.js
```

```bash
for f in tests/*.test.js; do node "$f"; done
```

```bash
node tools-dev/teaser_e2e.js 240 ABC
```
La prueba e2e copia la app a una carpeta temporal y prueba Cortar (A), Silenciar (B) y Tandas (C): duración, sincronía con destellos y bips, errores de decodificación y que la grosería quede callada. Con el ffmpeg 6.x de Ubuntu hace falta `FFMPEG_BIN` apuntando a una envoltura que cambie `-/filter_complex` por `-filter_complex_script`.

## Mediciones (nube, CPU, sin GPU)
- La fuente sintética ya trae 21.2 ms de desfase por sí sola (arranque del AAC en MPEG-TS).
- **Caso A** (Cortar, 3 clips + avance desde `bestof.json` + normalizar volumen): duración 249.000 s = esperada; 0 errores de decodificación; grosería callada; **avance: 4.7 ms en 27 pares**; video principal: entre 4.7 y 21.4 ms. La diferencia entre clips (17.2 ms) rebasa por 0.5 ms el límite de la prueba (17.17 ms), por eso A salió `ok:false`. El clip que empieza en 0 conserva el desfase de la fuente y los abiertos con `-ss` dan 4.7 ms: viene del método de corte que ya existía, **pero falta confirmarlo corriendo el mismo export sin avance**.
- **Casos B (Silenciar + avance por energía) y C (133 clips por tandas):** pendientes; seguían corriendo al cerrar la sesión.

## Riesgos
- Al publicar hay que agregar **`lib/teaser.js`** a `version.json` → `files`.
- Silenciar + avance reencoda todo el directo: en la RTX 3070 con NVENC, un directo de 6 h puede tardar 1–2 h. La interfaz lo avisa.
- NVENC no se probó (no hay GPU en la nube).
- **No se comprobó que el primer cuadro de cada fragmento sea exactamente el del tiempo pedido.** En la rama de miniaturas, `-ss` + `trim` en MPEG-TS dio un cuadro distinto a mitad de la grabación; aquí solo se midió sincronía y duración. Verificarlo con una fuente que tenga el número de cuadro dibujado (y revisar si afecta también al export normal).
- Letra: Arial Black → Arial Bold → Luckiest Guy → la de ffmpeg.
- Solo se probó audio estéreo a 48 kHz.
- La primera vez en un directo largo sin Resumen, medir la energía lee todo el audio. Con música o alertas ruidosas, la energía puede elegir partes ruidosas que no son las mejores.

## Qué falta
- Terminar y anotar los casos B y C; confirmar el caso A contra un export sin avance.
- Medir en la RTX 3070 con un directo real.
- Pedirle a Sonnet un campo `teaser` por momento, sin el remate (investigación §7.3).
- Modo Silenciar que solo codifique el avance.
- Editar los tiempos de cada fragmento en la lista.
- Integrar `lib/hwaccel.js` de `nube/export-rapido` (tarea 3).
