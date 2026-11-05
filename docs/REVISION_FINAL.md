# Revisión final (7 revisores, solo lectura) — hallazgos por rama

> Ninguno de estos arreglos está aplicado todavía. Orden: prioridad dentro de cada rama. Ver también `docs/SIGUIENTES_PASOS.md`.

## nube/integracion — sin bugs de la fusión
- Sin marcadores de conflicto, ids duplicados, listeners o funciones duplicadas; orden de scripts correcto; un solo handler de teclado.
- Menor: con la Vista de la edición y el modal de requisitos abiertos, un Esc cierra los dos (app.js:1010 y :704). Arreglo: `stopImmediatePropagation()` tras `closeRequirements()` y que el handler de app.js:691 ignore teclas si `#reqModal` está visible.

## Seguridad (calidad, export-intro, miniaturas-cola, ritmo) — sin problemas reales
- Rutas de actualización, rollback, miniaturas, cola y ritmo validan rutas y parámetros; ffmpeg siempre con argumentos en arreglo, sin shell.
- Menor: `saveThumbPng` (miniaturas-cola, server.js:~1837) sobrescribe un PNG con el mismo nombre en `exports/` si se guarda dos veces el mismo cuadro → agregar `_${Date.now()}` o revisar si existe.
- Menor: el rollback no borra archivos nuevos que trajo la actualización (`meta.added`); inofensivo.

## nube/teaser-ia
1. **Media — con IA local (Ollama) se pierden momentos en resúmenes largos** (server.js:980, `NP=useCloud?8000:3000`): cada momento ahora pide ~40 tokens más; con 30 min o más (`want` ≥ 38) la respuesta no cabe en 3000 tokens y se pierde ~1/3 de los momentos. Arreglo: pedir el bloque AVANCE solo con la nube, o `NP = Math.max(3000, want*110)` (revisando `num_ctx`). La barra de progreso de la nube (server.js:985) se queda corta (cosmético).
2. **Baja-media — tiempo absoluto tomado como relativo** en momentos de los primeros ~2 min (lib/teaser.js:134): p. ej. momento 30–120 s, IA da 25–33 → se convierte en 55–63 (pedazo no elegido, puede traer el remate). Arreglo: tratarlo como relativo solo si ambos valores quedan antes del momento y, sumado, cae dentro; si no, rechazar o recortar como absoluto.
3. Diseño: `refineAvance` corta al final del segmento de whisper, no de la palabra; con segmentos largos puede entrar el remate.

## nube/muletillas (lib/fillers.js)
1. **Alta — `removeFromClips` cuadrático** (:171-183): 20 000 clips × 20 000 cortes = 25.7 s (congela la UI). Arreglo: ordenar y un solo barrido con dos punteros.
2. **Alta — una muletilla propia vacía ("", "...", "¿?") truena la detección** (:106-108, :132): `parts=[]` → TypeError. Arreglo: descartar entradas sin partes y precalcular `parts`.
3. Media — "¿Eh?" (pregunta) se marca sola como 'siempre' (:64): con "?" o "¡" bajarla a 'revisar'.
4. Media — "¿Por qué no?", "¿Tú no?", "¿Sí o no?" se sugieren como coletilla (:97-100): exigir `¿no?` literal o coma antes.
5. Baja — el filtro `>0.1` borra clips chicos que ningún corte tocó (:180).
6. Baja — `'si si'` en una expresión de una sola palabra es código muerto (:93).

## nube/ritmo (lib/pace.js)
1. **Media — `plan()` truena con `silences:null`** (lo que regresa `/api/pace/silences` sin escaneo) (:60/:68): `for (const s of silences || [])`.
2. **Media — video casi todo silencio → `keep:[]`** (clip vacío; export o línea del tiempo pueden fallar) (:72, :89): si queda vacío, regresar el video completo.
3. Baja-media — la cola final < `minClip` se descarta (puede ser voz) y `cuts`/`keep` no cuadran (:89): alargar el último `keep`.
4. Baja — voz < 0.15 s al inicio se va con el corte aunque haya palabras confiables (:83).
5. Baja — la regex de silencedetect no acepta notación científica (`2.08333e-05`) (:22): `(-?[\d.]+(?:e[-+]?\d+)?)`. Ojo: con ffmpeg < 7, en directos > 2.8 h los tiempos salen con precisión de 0.1 s.
6. Baja — la búsqueda binaria supone palabras ordenadas por final (:48).
- Rendimiento bien: 20 000 silencios + 20 000 palabras en 7 ms.
- server.js: si `durationOf` falla se guarda `total:0` y se pierde el silencio final.

## nube/autozoom (lib/autozoom.js)
1. **Media — `zoom:1` sale como 1.12×** (:25 `zoomValue`): cualquier valor ≤ 1.001 distinto de 0 regresa el zoom viejo. Arreglo: `Number.isFinite(z) ? (z > 1.001 ? clamp(z,1.01,MAX_Z) : 1) : OLD_Z`.
2. **Media — `removeAutoZoom` borra zooms manuales** (:117): une un pedazo `autoSplit` aunque tenga `zoomManual`. Arreglo: no unir si alguno tiene `zoomManual`, o quitar `autoSplit` al editarlo.
3. Baja — `isPeak`/`phrases.find` lineales (31 ms con 20 000; aceptable).
- Bien: recortes pares y dentro del cuadro, tope 1.25× respetado, sin bucles infinitos, vista previa coincide con ffmpeg.

## nube/miniaturas-cola
1. **Alta — "Mejores momentos" nunca funciona** (miniaturas.js:23 / lib/thumbs.js:32): el `<select>` manda `'bestof'` y `sampleTimes` compara con `'best'`. Arreglo: aceptar ambos.
2. **Alta — la galería no se reinicia al cambiar de video** (miniaturas.js:72 y :142): `window.state` siempre es `undefined` (`let state` de app.js no queda en `window`) → al abrir otro video, un clic o "Guardar PNG" guarda **el cuadro del video nuevo** con la galería del viejo. Arreglo: `const st = typeof state !== 'undefined' ? state : null;`.
3. **Alta — la cola se puede perder al cerrar la app** (server.js:1851, :1870, :40): se guarda cada 700 ms con `writeFileSync` directo; si se corta a media escritura, el JSON queda roto y al abrir se sobrescribe con una cola vacía. Arreglo: guardar solo si cambió, escribir a `.tmp` + `renameSync`, y si no se puede leer renombrarlo a `.bad`.
4. **Alta — pueden correr dos exports a la vez** (server.js:421 vs :1874): `exportVideo` revisa `job` y luego hace `await durationOf()` antes de marcarlo; en ese hueco la cola arranca un Short → dos ffmpeg, `job` sobrescrito y resultados cruzados. Arreglo: reservar `job` de forma síncrona antes del primer `await` (o candado `starting`).
5. Media — cancelar justo al empezar no detiene el export (server.js:1911-1913): se resuelve con el punto 4.
6. Media — procesos de miniaturas sin límite de tiempo (server.js:1386, :1819): si dos ffmpeg se cuelgan (disco USB/red), la galería se bloquea para siempre. Arreglo: matar a los ~30 s.
7. Media — JPEG a medias en caché (server.js:1826): escribir a `.tmp` y renombrar.
8. Menor — los videos de la cola leen cortes/ajustes/transcripción al exportar, no al encolar; y un trabajo ajeno que arranque en los ~700 ms entre items se le puede asignar a la cola.
- Bien: sin path traversal, recuperación al reiniciar como se diseñó, sin ids inexistentes, scripts en buen orden.
- Además (agente B): prueba real de la cola con 2 Shorts **pasó**: ambos "Listo", duración exacta, primer cuadro correcto (+1 cuadro esperado por el start_time del video) y sincronía 4.7 ms. Antes empezaban 30–45 cuadros tarde.

## nube/export-intro (corte exacto en el export + GPU)
Sin bugs que rompan sincronía, calidad o cortes: todos los comandos con `-copyts` cortan cada entrada con trim absoluto, ninguno usa `-c:v copy`; filtros relativos (groserías, afade, xfade, drawtext) quedan después de `setpts=PTS-STARTPTS`; `fmtStart` aplicado en todos los cortes; el reintento por CPU reusa args sin `-hwaccel`.
1. **Media — `runDec` (server.js:154): la regla de 30 s está al revés.** Una falla temprana que no es de NVDEC (NVENC no disponible, error de filtro) apaga la GPU toda la sesión con mensaje equivocado; una falla real de CUDA después de 30 s no se detecta (`run` guarda solo 700 caracteres de stderr) y el export termina en error. Arreglo: guardar ~5000 caracteres de stderr y reintentar por CPU solo si `isHwaccelFailure(stderr)`.
2. Media — memoria de video en el camino SEG (server.js:614-617): hasta 130 entradas con `-hwaccel cuda` llenan 8 GB. Arreglo: sin GPU si hay > 16 entradas de video.
3. Menor — `startTimeOf` ignora start_time negativo y su caché usa solo la ruta (ver la sección de `lib/seek.js`).
- La prueba de punta a punta A/B/C **no verificó** el export: el puerto 4188 estaba ocupado por un servidor viejo. Repetirla con el puerto libre.

## lib/seek.js (método de corte exacto)
1. **Alta (comprobado) — start_time negativo cerca de la vuelta de 33 bits del MPEG-TS** (≈ 95 443.7 s): libavformat da start_time negativo (p. ej. −22.3 s) y `startTimeOf` lo cambia a 0 → **el corte sale vacío** (0 cuadros). Con el valor real, ffmpeg corta bien aunque cruce la vuelta. También .mp4 con B-frames/priming AAC (−0.02 a −0.07 s → 1–4 cuadros corridos). Arreglo: aceptar cualquier valor finito; si ffprobe falla, **no** usar 0 en silencio (lanzar error o volver al método sin `-copyts`).
2. **Alta — saltos de marcas de tiempo** (directo que se reconecta, segmentos HLS perdidos): con `-copyts` ffmpeg no corrige saltos y "absoluto = fmtStart + t" deja de valer → cortes en otro punto o vacíos. Arreglo: detectar saltos (muestreo de `pts_time` o duración vs pts final − inicial) y, si hay, remuxear a marcas continuas antes de cortar.
3. Media — `setpts=PTS-STARTPTS` por stream convierte en desfase A/V la diferencia de inicio de audio y video (explica los 4.7–16 ms). Arreglo: restar el mismo inicio absoluto a ambos (`setpts=PTS-<a>/TB`, `asetpts=PTS-<a>/TB`) + `aresample=async=1:first_pts=0`.
4. Media — redondeo a 4 decimales en 60 fps puede saltarse 1 cuadro con tiempos ajustados a cuadro. Arreglo: correr los límites medio cuadro antes o usar `trim=start_pts=` en ticks.
5. Baja — GOP de más de 15 s: subir PRE según el GOP medido.
6. Baja — `absTrims` con muchos pedazos en una sola entrada es lento y gasta memoria si no van en orden.
7. ffprobe y ffmpeg deben ser el **mismo binario** (`tools/`). Probar en Windows con `-output_ts_offset 95420` y un directo real.
8. `check_cut.js` no cubre lo anterior: agregar casos de vuelta de 33 bits, salto de marcas y medición de audio.

## Arreglos en curso al cerrar la sesión
Se lanzaron agentes para corregir: miniaturas-cola (1–5), export-intro (runDec, límite de entradas GPU, startTimeOf), teaser-ia (1–2), muletillas (1–4), ritmo (1–4) y autozoom (1–2). Revisar con `git log` de cada rama qué alcanzó a subirse.
