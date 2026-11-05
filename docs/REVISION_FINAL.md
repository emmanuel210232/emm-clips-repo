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

## Pendientes de llegar
- nube/export-intro (corte exacto en el export y GPU), nube/miniaturas-cola (cola y miniaturas), método `lib/seek.js`.
