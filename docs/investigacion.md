# Investigación: qué hacen los editores populares y qué le conviene a Emm Clips

> Rama: `nube/investigacion` · Fecha: noviembre 2026 · Documento de trabajo para el equipo que programa Emm Clips.
> Todo lo que dice "Emm Clips hoy" se revisó en el código (`index.html`, `app.js`, `server.js`, `lib/*.js`) de `main`.
> Las fuentes van al final de cada sección. Donde una herramienta no publica un dato (p. ej. el % exacto de zoom de Gling), se dice claramente y se da una recomendación propia.

---

## 0. Resumen en 1 minuto

- Emm Clips ya cubre el flujo central de los usuarios (abrir directo → transcribir local → silenciar/cortar groserías → quitar silencios → resumen con IA → Shorts 9:16 con seguimiento de quien habla → exportar con NVENC). Pocas herramientas comerciales juntan **censura de groserías en español + directos de 6 h + todo local**.
- Donde más se queda atrás frente a Gling/Descript/Premiere es en la **edición por texto** (borrar palabras en la transcripción y que se corte el video), la **revisión de cortes** ("ver lo que se quitó y regresarlo"), los **zooms automáticos en cada corte** y la **velocidad de exportación en modo Cortar** (hoy reencoda TODO el video).
- Las 3 cosas con mejor impacto/esfuerzo:
  1. **Zooms estilo Gling en cada corte de silencio** (alternar 1.00× / 1.10×, centrado en la cara). Ya existe casi toda la tubería (`zoomOf`, MediaPipe en `vision.js`).
  2. **Pitido opcional + máscara en subtítulos** para groserías (además de "silenciar").
  3. **"Smart render" en modo Cortar**: copiar sin reencodear los GOPs que no se tocan y reencodear solo alrededor de cada corte. En exportes de resumen/groserías con tramos largos puede bajar el tiempo de horas a minutos sin perder calidad. (En "quitar silencios" con clips de ~4 s ayuda menos; ver §3.)

---

## 1. Qué hace Emm Clips hoy (base para comparar)

| Área | Cómo está hecho hoy |
|---|---|
| Abrir video | Explorador de Windows o ruta; no copia el archivo. Vista previa MP4 opcional (960 px, x264 ultrafast) para MPG/TS. Miniaturas ("filmstrip") y forma de onda bajo demanda. |
| Transcripción | whisper.cpp local (large-v3-turbo q5 o small), GPU si hay `tools-gpu`. Importar SRT/JSON. Clic en palabra → salta el video. |
| Groserías | Diccionario editable de palabras completas; lista de coincidencias con casillas; ajuste de bordes; cortes manuales por segundos. Export **Silenciar** (`volume=0` con margen 0.15 s, video en `-c:v copy`) o **Cortar**. "Silenciar TODAS las del diccionario". No hay pitido ni máscara en subtítulos del video largo. |
| Silencios | `silencedetect` (4 niveles: 1 s / 0.6 s / 0.35 s / 0.25 s, margen 0.12 s) → se convierten en clips de la línea de tiempo. "Pausas largas" (≥1.5 s) aparte en el Paso 2. Opción "Suavizar cortes" (crossfade). No detecta muletillas ni tomas repetidas. |
| Línea de tiempo | Estilo CapCut: scrub en regla, dividir (D), borrar (Supr), trim por bordes, mover/reordenar, multiselección (Ctrl+clic), unir con crossfade, zoom por clip (Z), transición por tema (IA), deshacer (Ctrl+Z, solo en memoria, sin rehacer). |
| Zoom | "Sugerir zooms": picos de volumen RMS (1 s), máx. ~1 cada 45 s, ventana de 2.2 s. Zoom **estático** `crop=iw/1.12` al **centro** (no a la cara), sin animación. |
| Resumen del directo | Transcribe saltando silencios y Claude Sonnet 5.5 (o modelo local) propone mejores momentos; se aprueban, se reordenan y se mandan al editor con transición. |
| Shorts 9:16 | Propuestas 30–60 s con "gancho" (IA local o nube), subtítulos con palabras clave resaltadas, gancho al inicio estilo Opus, director de cámara con MediaPipe (`lib/director.js`: tomas, histéresis, zoom máx. 1.8×). |
| Audio | Reducir ruido, compresor, normalizar −16 LUFS, DeepFilterNet ("voz Estudio"). |
| Exportar | Original (copia de video si se puede) / 1080p60 / 1080p30 / comprimido. NVENC (`p5`/`p6`, `-cq`, spatial AQ) con caída a CPU. Modo Cortar: siempre reencoda; >120 clips → por tandas de 100 con lectura por "tramos" y unión sin reencodear. Intro/outro con @usuario, 15 efectos de entrada/salida. |
| Extra | Revisión de contenido sensible con visión (gemma3 / Sonnet), investigación de competencia, comprobación de requisitos, actualizador automático. |

---

## 2. Tabla comparativa de funciones

Leyenda: ✅ lo tiene · 🟡 parcial · ❌ no lo tiene · — no aplica

| Función | CapCut PC | DaVinci Resolve (Cut) | Descript | Opus Clip | Gling | Submagic | Premiere (texto) | **Emm Clips hoy** |
|---|---|---|---|---|---|---|---|---|
| Transcripción automática | ✅ | ✅ (60+ idiomas en v20) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (local, whisper.cpp) |
| Editar video borrando texto | 🟡 | ✅ | ✅ (núcleo del producto) | ✅ | ✅ | 🟡 | ✅ | 🟡 (clic en palabra salta; no corta al borrar texto) |
| Quitar silencios | ✅ | ✅ (IntelliCut) | ✅ (acortar huecos) | — | ✅ (Pace + Padding) | ✅ | ✅ (filtro "Pausa") | ✅ |
| Control de ritmo del silencio (cuánto dejar) | 🟡 | 🟡 | ✅ | — | ✅ (slider Pace "Keep all pauses") | 🟡 | 🟡 | 🟡 (4 niveles + margen fijo) |
| Margen antes/después por separado | ❌ | 🟡 | 🟡 | — | ✅ (Padding Start/End enlazable) | ❌ | ❌ | ❌ (0.12 s fijo) |
| Quitar muletillas ("este…", "o sea", "eh") | ✅ | ❌ | ✅ (solo inglés) | — | ✅ | 🟡 | ✅ (beta) | ❌ |
| Quitar tomas malas / repetidas | 🟡 | ❌ | ✅ (Remove Retakes / Edit for Clarity) | — | ✅ | ❌ | ❌ | ❌ |
| Ver lo cortado y "regresarlo" | 🟡 | ✅ | ✅ (tachado/"Ignore") | 🟡 | ✅ ("Show cuts" + "Uncut") | 🟡 | ✅ | 🟡 (Ctrl+Z y re-seleccionar) |
| Censura de groserías: silenciar | ❌ | ❌ | ❌ (pedido abierto) | ❌ | ❌ (no documentado) | ❌ | ❌ | ✅ |
| Censura: pitido / máscara en subtítulos | ❌ | ❌ | ❌ | ❌ | ❌ | 🟡 | ❌ | 🟡 (Shorts silencian; sin pitido) |
| Zooms automáticos en cortes | 🟡 (manual con keyframes) | 🟡 (Close Up con IA) | 🟡 | ✅ (en clips) | ✅ (Auto zoom: Magnitude, Start/End zoom, Center to face, Smooth) | ✅ (6 estilos, ligados al texto) | ❌ | 🟡 (estático 1.12× al centro, por picos de volumen) |
| Encuadre 9:16 con seguimiento | ✅ (Auto Reframe) | ✅ (Smart Reframe) | ✅ | ✅ (ReframeAnything) | ✅ | ✅ | ✅ (Auto Reframe) | ✅ (MediaPipe + director de cámara) |
| Clips/Shorts automáticos con puntaje | ✅ | ❌ | ✅ | ✅ (Virality Score 1–100) | ✅ | ✅ (Magic Clips) | ❌ | ✅ (Sonnet; gancho /10) |
| Subtítulos animados | ✅ | ✅ (Animated Subtitles v20) | ✅ | ✅ | ✅ | ✅ (su fuerte) | ✅ | ✅ (Shorts) / ❌ (video largo) |
| Detector de partes aburridas | ❌ | ✅ (Boring Detector) | ❌ | 🟡 | ❌ | ❌ | ❌ | ❌ |
| Mejora de voz con IA | ✅ | ✅ (Voice Isolation) | ✅ (Studio Sound) | ❌ | ✅ | ❌ | ✅ (Enhance Speech) | ✅ (DeepFilterNet) |
| Proxies / vista previa ligera | ✅ (Proxy mode) | ✅ | ✅ (nube) | — (nube) | — (nube) | — | ✅ | 🟡 (MP4 960 px manual) |
| Decodificación por GPU | ✅ | ✅ | — | — | — | — | ✅ | ❌ (no usa `-hwaccel`) |
| Exportar sin reencodear lo intacto | ❌ | 🟡 ("Bypass re-encode") | ❌ | — | ❌ | — | 🟡 (Smart Render, solo códecs intermedios) | 🟡 (solo modo Silenciar) |
| Exportar a otro editor (XML/FCPXML) | ❌ | ✅ | ✅ | ✅ (XML Premiere) | ✅ (Premiere/Resolve/FCP/CapCut) | ❌ | — | ❌ |
| Deshacer / rehacer persistente | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 (deshacer en memoria; sin rehacer) |
| Todo local / sin subir videos | ✅ | ✅ | ❌ | ❌ | ❓ (no verificado) | ❌ | ✅ | ✅ (IA en nube opcional, solo texto/frames) |
| Directos de 4–6 h | 🟡 (pesado) | ✅ | 🟡 | 🟡 (límites por plan) | 🟡 | ❌ | ✅ | ✅ (diseñado para eso) |

**Conclusión de la tabla:** la ventaja de Emm Clips es censura en español + directos largos + local. Lo que falta son los "detalles de editor de YouTuber" que Gling hizo famosos: ritmo de silencios ajustable, muletillas/tomas malas, ver y regresar cortes, zooms automáticos en cada corte y exportar a Premiere/Resolve.

Fuentes: [Gling silencios](https://gling.ai/silence-remover), [Gling ayuda – Pace/Padding](https://www.gling.ai/help/adjust-silence-cuts), [Gling ayuda – Restaurar](https://www.gling.ai/help/restore-removed-speech), [Gling ayuda – zoom](https://www.gling.ai/help/zoom-and-framing), [Gling ayuda – índice/exportes](https://www.gling.ai/help), [Descript muletillas](https://help.descript.com/script-editing/filler-words), [Descript Edit for Clarity](https://www.descript.com/ai/edit-for-clarity), [Descript pedido "bleep profanity"](https://feedback.descript.com/feature-requests/p/bleep-profanity), [CapCut Desktop IA](https://www.capcut.com/tools/desktop-ai-power), [DaVinci Resolve Cut](https://www.blackmagicdesign.com/products/davinciresolve/cut), [Resolve 20 IA](https://cined.com/davinci-resolve-20-released-with-handful-of-ai-assisted-features), [Premiere texto/pausas/muletillas](https://www.redsharknews.com/how-to-delete-pauses-and-filler-words-with-text-based-editing), [Opus Clip](https://makerstack.co/reviews/opus-clip-review/), [Submagic zooms](https://submagic.co/features/auto-zooms), [Submagic silencios](https://www.submagic.co/features/ai-silence-remover), [Captions censura](https://captions.ai/help/docs/audio/censor.md).

---

## 3. Patrones de interfaz que vale la pena adoptar

Cada punto trae: **qué es**, **dónde se ve**, y **cómo construirlo en Emm Clips**. No se copia diseño ni marca de nadie, solo el patrón.

### 3.1 Transcripción = línea de tiempo (edición por texto)
- **Qué es:** el texto es el editor. Seleccionar palabras y borrarlas corta ese pedazo del video; lo borrado se ve **tachado y gris** (no desaparece) y se puede regresar. Descript, Premiere, Gling y Resolve lo hacen.
- **Cómo construirlo:**
  - Ya existe `#transcript` con palabras clicables y `tokenizeTranscript()` con tiempos por palabra. Agregar selección por arrastre (rango de palabras) + tecla `Supr` → crea un "corte" `{start: w[i].start - padIn, end: w[j].end + padOut}` en el mismo modelo que `manualCuts`/clips.
  - Pintar cada palabra según su estado: normal / **tachada** (cortada) / **subrayada roja** (grosería) / **gris claro** (silencio quitado, mostrar como `[··· 1.4 s]`).
  - Clic en una palabra tachada → botón flotante "Regresar". Equivale al "Uncut" de Gling.
  - Mantener sincronía: un solo estado de verdad (`clips` = intervalos a conservar) y la transcripción y la línea de tiempo se derivan de él.

### 3.2 Panel de revisión de cortes por tipo ("Mostrar cortes")
- **Qué es:** Gling separa lo que la IA quitó en categorías (silencios, muletillas, tomas malas) y permite ver cada una y regresarla.
- **Cómo:** una barra arriba de la transcripción con chips: `Silencios (312 · −18:40)` `Groserías (57)` `Muletillas (140)` `Tomas repetidas (9)`. Cada chip prende/apaga esa categoría completa y abre una lista con ▶ (reproducir 1 s antes → 1 s después **saltando el corte**, igual que `reviewCut` hoy). Mostrar siempre "el video pasa de 4:12:00 a 3:31:10".

### 3.3 Control de ritmo (Pace) y márgenes (Padding) en vez de niveles fijos
- **Qué es:** Gling tiene un slider "Pace" (desde "Keep all pauses" hasta muy apretado) y dos sliders de margen Inicio/Fin que se pueden enlazar. Se aplica con "Apply" y se escucha.
- **Cómo:** reemplazar el `<select>` de sensibilidad por:
  - **Ritmo**: slider continuo 0.20 s … 2.0 s ("Dejar todas las pausas" en el extremo). Internamente = `minSil` de `detectSilences`.
  - **Margen antes / después**: dos sliders 0–300 ms, candado para enlazarlos (hoy `pad` = 0.12 fijo en ambos lados). Recomendado por defecto: **antes 80 ms, después 150 ms** (las colas de palabra en español se cortan más que los ataques).
  - **Clave:** no volver a correr `silencedetect` al mover el slider. Correrlo UNA vez con el umbral más sensible (`d=0.2`) y guardar todos los silencios con duración; el slider solo filtra en el navegador → respuesta instantánea.

### 3.4 Línea de tiempo doble (vista completa + zona de trabajo)
- **Qué es:** en el Cut page de Resolve, arriba se ve TODO el programa y abajo un acercamiento alrededor del cabezal; "nunca tienes que hacer zoom". Ideal para directos de 4–6 h.
- **Cómo:** agregar una franja delgada (24 px) arriba de `#timeline` con el directo completo: clips conservados en color, cortes en gris, groserías como marcas rojas, zooms como marcas azules, y un rectángulo que indica la ventana visible de abajo. Arrastrar el rectángulo = navegar.

### 3.5 Detector de partes aburridas
- **Qué es:** Resolve marca en la línea de tiempo tramos demasiado largos sin cambios (gris) y cortes demasiado rápidos (rojo).
- **Cómo (barato):** marcar tramos > 25–30 s sin corte, sin zoom y con energía de voz baja (ya hay RMS por segundo en `suggestZooms`) → sugerencia "aquí va un zoom o un corte". Con la nube, se puede pedir a Sonnet que marque "partes de relleno" usando la transcripción (como el resumen, pero al revés).

### 3.6 Inspector a la derecha
- **Qué es:** CapCut/Resolve muestran las propiedades del clip seleccionado en un panel fijo (zoom, posición, velocidad, volumen, transición).
- **Cómo:** cuando hay `selectedClipIdx`, mostrar un panel con: Zoom (1.00–1.30×, slider), Centro (auto cara / centro / manual con clic en el visor), Animación (ninguna / acercamiento lento / golpe), Transición de entrada (corte / fundido 0.2 s / disolver 0.5 s), Volumen. Hoy esas opciones están dispersas en botones de la barra.

### 3.7 Atajos de teclado estándar (reproducción J/K/L)
Recomendado (lo usan Premiere, Resolve, CapCut con pequeñas variaciones):

| Tecla | Acción |
|---|---|
| Espacio | Reproducir / pausa |
| J / K / L | Atrás / pausa / adelante (pulsar L dos veces = 2×) |
| ← / → | 1 cuadro; con Shift = 1 s |
| I / O | Marcar entrada / salida (para corte manual o Short exacto) |
| D (ya) · Ctrl+B | Dividir |
| Supr (ya) / Shift+Supr | Borrar dejando hueco / borrar cerrando hueco |
| Z (ya) | Zoom en clip |
| Ctrl+Z / Ctrl+Shift+Z | Deshacer / **rehacer** (falta rehacer) |
| M | Marcador (para el teaser y para Shorts) |
| ? | Mostrar hoja de atajos |

### 3.8 Deshacer de verdad
- Hoy `clipUndo` es una pila en memoria solo para clips. Recomendación: una pila única de "comandos" (`{tipo, antes, después}`) para clips, cortes de groserías, zooms y selección del Paso 2; guardar los últimos 50 en `data/undo.json` para que sobreviva a recargar la página; agregar **rehacer**. Mostrar en el aviso qué se deshizo ("↶ Regresé 312 silencios").

### 3.9 Vista previa del resultado sin exportar
- **Qué es:** todos los editores reproducen la edición saltando lo cortado en tiempo real.
- **Cómo:** en el reproductor, modo "Ver como quedará": en `timeupdate`, si el cabezal cae dentro de un corte, `video.currentTime = fin del corte`; si cae en una grosería en modo Silenciar, `video.muted = true` durante ese rango. Con zooms: aplicar `transform: scale(1.1)` con `transform-origin` en la cara al `<video>`. Barato y elimina exportes de prueba.

### 3.10 Onboarding
- Proyecto de ejemplo de 2 min (un pedazo con groserías y silencios) para aprender sin abrir un directo de 6 h.
- Recordar el último ajuste usado (ritmo, márgenes, zoom, audio) por usuario: los dos YouTubers repiten la misma receta cada vez → botón "Usar mi receta de siempre" que hace todo el Paso 1–4 de un jalón y deja revisar al final (es el "one click" de Gling).
- Estimar tiempos antes de lanzar: "Transcribir ~25 min · Exportar ~40 min con GPU".

Fuentes: [Resolve Cut page](https://www.blackmagicdesign.com/products/davinciresolve/cut), [Gling Pace/Padding](https://www.gling.ai/help/adjust-silence-cuts), [Gling Uncut](https://www.gling.ai/help/restore-removed-speech), [Descript muletillas (Delete / Ignore / Avoid harsh cuts)](https://help.descript.com/script-editing/filler-words), [Premiere Extract vs Lift](https://www.redsharknews.com/how-to-delete-pauses-and-filler-words-with-text-based-editing), [CapCut Desktop](https://www.capcut.com/tools/desktop-ai-power).

---

## 4. Exportar rápido sin perder calidad

### 4.1 Qué hacen las otras herramientas
| Técnica | Quién | Qué hace | ¿Sirve con H.264 de Kick? |
|---|---|---|---|
| **Smart render** | Premiere | Copia sin reencodear los clips intactos si códec, tamaño, fps y bitrate coinciden con la salida. | En Premiere prácticamente **solo con ProRes/DNx**, no H.264. |
| **Bypass re-encode** | Resolve (Deliver) | Si la fuente y la salida coinciden, no reencoda. Útil cuando solo cambia el audio. | Funciona en casos simples; cualquier cambio de color/escala lo rompe. |
| **Smart cut** | LosslessCut (experimental), TMPGEnc Smart Renderer, VideoReDo | Reencoda solo el GOP alrededor de cada corte (~1–2 s) y copia el resto. | **Sí, es lo que aplica a Emm Clips.** Requiere que lo reencodado tenga parámetros compatibles con el original. |
| **Decodificar por GPU** | CapCut ("acelerar decodificación por hardware"), Premiere, Resolve | NVDEC decodifica el H.264 y libera CPU. | Sí: `-hwaccel cuda`. |
| **Proxies** | CapCut (Proxy mode), Resolve, Premiere | Copias ligeras para editar; se exporta del original. | Emm Clips ya tiene "vista previa MP4", pero manual. |
| **Render en segundo plano / caché** | Resolve (render cache), Premiere (previews) | Lo ya renderizado no se vuelve a renderizar. | Sí: cachear tandas por hash. |
| **Encoders en paralelo** | Servidores / Resolve Studio | Varias sesiones NVENC simultáneas. | GeForce permite hasta **8 sesiones** NVENC simultáneas con drivers actuales. |

### 4.2 Qué aplica al pipeline de Emm Clips (en orden de ganancia)

**A. Smart cut en modo Cortar (mayor ganancia en exportes con tramos largos)**
Hoy `exportVideo` en modo Cortar reencoda todo lo conservado. Propuesta:
1. Al abrir el video, sacar las posiciones de keyframes una vez y guardarlas en `data/`:
   `ffprobe -v error -select_streams v:0 -skip_frame nokey -show_entries frame=pts_time -of csv=p=0 video.mpg`
   (Kick pide a los streamers keyframe cada 2 s, así que se esperan GOPs de ~2 s; **medirlo**, no asumirlo).
2. Para cada intervalo conservado `[s, e]`: `K1` = primer keyframe ≥ s, `K2` = último keyframe ≤ e.
   - `[s, K1)` → reencodar (NVENC/x264) con los **mismos** parámetros que el original: resolución, fps, `pix_fmt`, perfil/nivel H.264 (leerlos con ffprobe).
   - `[K1, K2)` → `-c:v copy` (cero pérdida, velocidad de disco).
   - `[K2, e]` → reencodar.
   - Si el intervalo es < 2 GOPs (p. ej. clips de silencios de 3–4 s) → reencodarlo entero (no vale la pena partirlo).
3. Concatenar los pedazos de **video** en MPEG-TS (`-bsf:v h264_mp4toannexb`, concat demuxer) y remuxear a MP4.
4. El **audio NO se smart-cutea**: se arma completo aparte (como hoy en `exportBatched`: PCM por tramos + `aresample=async=1` + una sola codificación AAC al final) y se mezcla con el video. Así la sincronía queda igual que la versión actual, que ya está probada.
5. Validación obligatoria antes de activarlo por defecto: comparar duración de video vs audio (diferencia < 1 cuadro), revisar con `ffprobe -show_frames` que los PTS sean crecientes, y probar reproducción en VLC, navegador y subida a YouTube.
- **Ganancia esperada:** en un resumen de 20–60 min hecho de tramos de 30 s–3 min, ~90 % se copia → exporta en una fracción del tiempo y **la calidad del 90 % es idéntica al original** (mejor que hoy).
- **Ganancia baja** en "quitar silencios" (cientos de clips de 2–6 s): casi todo cae en la regla "< 2 GOPs". Ahí la ganancia viene de B y C.
- **Riesgos:** mezclar SPS/PPS distintos en un mismo stream puede dar problemas en algunos reproductores (YouTube suele aceptarlo porque reencoda todo). Mantener como opción "Exportación inteligente (beta)" con caída automática al método actual si la validación falla. Zooms, fundidos y efectos obligan a reencodar ese clip completo (es lo esperado).

**B. Decodificar con la GPU (NVDEC)**
- Hoy ningún comando usa `-hwaccel`. Agregar `-hwaccel cuda` antes de cada `-i` del directo en exportes y en la vista previa. Sin `-hwaccel_output_format cuda` los cuadros bajan a memoria normal, así que **los filtros actuales (trim, concat, crop, xfade) siguen funcionando sin cambios**; solo se quita al CPU el trabajo de decodificar 1080p60.
- Para el caso sin filtros de CPU (solo escalar), el camino completo en GPU es `-hwaccel cuda -hwaccel_output_format cuda … -vf scale_cuda=… -c:v h264_nvenc`.
- Con muchas entradas (`spans` de `exportBatched` abren hasta ~100 entradas): probar memoria de video; si falla, caer a decodificación por CPU (mismo patrón de caída que ya existe para NVENC).

**C. Tandas en paralelo**
- `exportBatched` hace las tandas una tras otra. Con NVENC se pueden lanzar 2–3 tandas simultáneas (límite GeForce: 8 sesiones). El cuello de botella pasa a ser la decodificación/CPU; con B se libera. Medir antes con `bench_export` (ya hay scripts de benchmark en el scratch del proyecto).

**D. Caché de tandas (re-exportar solo lo que cambió)**
- Nombrar cada tanda por un hash de `(ruta del video, inicio/fin de cada clip, zoom, filtros de audio, calidad)`. Si el usuario corrige 2 groserías y vuelve a exportar, solo se rehacen las tandas afectadas. Borrar la caché al cerrar el proyecto.

**E. Proxies automáticos en segundo plano**
- Generar la vista previa (y las miniaturas) solos al abrir el directo, con NVENC y prioridad baja, en vez de esperar al botón. No afecta la calidad final (se exporta del original).

**F. Parámetros de calidad NVENC**
- Ya están bien (p5/p6, `-cq`, spatial AQ). Agregar `-temporal-aq 1 -rc-lookahead 20 -bf 3 -b_ref_mode middle` (si la GPU lo soporta; RTX 20xx+) mejora detalle en movimiento IRL al mismo bitrate. Verificar con SSIM/VMAF como se hizo para el `cq 23`.
- YouTube reencoda todo: subir con bitrate alto (≥ 12 Mbps para 1080p60 SDR) es lo correcto; no comprimir de más.

Fuentes: [Frame.io: smart rendering](https://workflow.frame.io/guide/smart-rendering), [Larry Jordan: Smart Render en Premiere](https://larryjordan.com/articles/premiere-pro-export-faster-with-smart-render/), [Foro Adobe: qué permite smart render](https://community.adobe.com/t5/adobe-media-encoder-discussions/smart-rendering-in-media-encoder-premeire-what-affects-whether-it-is-used/td-p/11477105), [Foro Blackmagic: bypass re-encode](https://forum.blackmagicdesign.com/viewtopic.php?p=774461), [Smart cut de LosslessCut](https://blog.brightcoding.dev/2025/07/22/cut-and-trim-videos-without-quality-loss), [TMPGEnc Smart Renderer](https://tmpgenc.pegasys-inc.com/en/product/tmsr4_smartrendering.html), [NVIDIA: FFmpeg con GPU](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.1/ffmpeg-with-nvidia-gpu/index.html), [NVIDIA: guía de transcodificación](https://developer.nvidia.com/blog/nvidia-ffmpeg-transcoding-guide/), [Límite de sesiones NVENC](https://techgage.com/?p=59848), [CapCut: proxy y aceleración por hardware](https://grandavehousing.calpoly.edu/news/run-capcut-smoothly-on-pc), [Kick: keyframe 2 s](https://upstream.so/blog/kick-stream-key-obs-settings/), [YouTube: configuración de subida recomendada](https://support.google.com/youtube/answer/1722171).

---

## 5. Zooms automáticos estilo Gling

### 5.1 Cómo funciona en Gling (lo que está documentado)
- Se prende en **Enhance → Auto zoom**. Gling genera un **patrón** de zooms para todo el proyecto.
- **Magnitude**: controla qué tan fuerte es el patrón generado (se regenera con su botón **Apply**).
- Por cada zoom hay **Start zoom** y **End zoom** (1.00× = tamaño normal; más = más cerca). Si Start ≠ End, el zoom se **anima** durante el clip; **Smooth** suaviza esa animación.
- **Center to face**: el recorte se centra en la cara (no al centro del cuadro).
- Funciona como **"Jump Cut Zoom"**: los cambios de zoom caen en los **cortes** que dejó la quitada de silencios/tomas malas, para que el salto se vea como "cambio de cámara" y no como "faltan cuadros".
- **Apply to all** cambia todos; también se puede seleccionar un clip y editar solo ese. Apagar Auto zoom quita todos los zooms del proyecto.
- Gling **no publica** porcentajes exactos ni frecuencia.

### 5.2 Lo que dice la práctica de edición de YouTube
- En videos de "cabeza que habla" hay un corte cada **3–8 s**; el patrón que funciona es **alternar** "abierto, cerrado, abierto, cerrado" con el cerrado a **110–120 %**.
- Los cambios de zoom deben caer **al inicio de una frase**, nunca a media frase, y cada encuadre debe **sostenerse** un rato (si ciclan muy rápido cansan).
- Los "golpes" de zoom (punch-in) sirven para **remarcar** un chiste o una reacción fuerte.

### 5.3 Recomendación para Emm Clips (videos largos horizontales de IRL, fuente 1080p60)
La fuente es 1080p y la salida 1080p: todo zoom es un recorte reescalado. **1.10× ≈ 982 líneas reales; 1.20× ≈ 900 líneas**. Por eso los valores son más bajos que en contenido grabado en 4K.

| Parámetro | Valor recomendado | Por qué |
|---|---|---|
| Zoom "cerrado" en cortes | **1.10×** (rango del slider 1.05–1.20) | Se nota el cambio sin perder nitidez visible. |
| Zoom de énfasis (golpe) | **1.18×**, máx. 1.25× | Solo en picos de risa/grito; más se ve borroso en 1080p. |
| Patrón | Alternar 1.00 ↔ 1.10 en cada corte de silencio | Es el "jump cut zoom". |
| Duración mínima de un encuadre | **≥ 4 s**; si el clip dura < 2.5 s, **no cambiar** zoom (heredar el del anterior) | Evita parpadeo en ráfagas de cortes chiquitos. |
| Máx. tiempo sin variación | Si pasan **> 25 s** sin corte, meter un cambio en el siguiente inicio de frase (o un acercamiento lento) | Rompe la monotonía en tramos largos. |
| Acercamiento lento (Smooth) | **1.00 → 1.06×** a lo largo de **6–10 s**, con curva suave (ease-in-out) | Para tramos largos sin cortes; casi imperceptible pero da vida. |
| Cuándo cae | En el corte; si no hay corte, en el **inicio de palabra** después de una pausa (≥ 0.25 s) | Nunca a media palabra. |
| Centro del recorte | **Cara** (mediana de la posición de la cara en el clip, de MediaPipe), con límites para no salirse del cuadro; si no hay cara, tercio superior central | Las cámaras IRL se mueven; seguir cuadro a cuadro tiembla. Un centro fijo por clip se ve como cámara. |
| Densidad total | Máx. ~1 cambio cada 6–8 s en promedio; respetar los que el usuario puso/quitó a mano | Evita "efecto mareo". |
| Excluir | Tramos con texto en pantalla/alertas de donaciones en las orillas, y clips con mucho movimiento de cámara | El recorte se come las alertas; zoom sobre movimiento marea. |
| Modo Silenciar | Avisar que usar zooms obliga a reencodar (ya no es "copia rápida") | Hoy Silenciar es `-c:v copy`. |

### 5.4 Cómo construirlo (sobre lo que ya existe)
1. **Datos**: cada clip de la línea de tiempo ya tiene `.zoom`. Cambiarlo a objeto: `{z0:1.10, z1:1.10, cx:0.52, cy:0.38, ease:'none'|'smooth'}`.
2. **Generador "Auto zoom"** (nuevo botón junto a "Quitar silencios", o casilla "Agregar zooms en los cortes"): recorre los clips en orden y aplica la tabla de 5.3; usa la transcripción para no caer a media palabra y el RMS (ya calculado en `suggestZooms`) para los golpes de énfasis. Slider **Intensidad** (= Magnitude): Suave 1.06 / Normal 1.10 / Fuerte 1.15.
3. **Centro en la cara**: reutilizar `vision.js`/MediaPipe que ya corre para los Shorts, pero muestreando 1–2 cuadros por clip (barato); guardar `cx, cy`.
4. **Render**:
   - Zoom fijo: `crop=w=iw/Z:h=ih/Z:x=(iw-iw/Z)*cxClamp:y=(ih-ih/Z)*cyClamp,scale=W:H:flags=lanczos` (hoy siempre centra; solo agregar x/y).
   - Zoom animado: evitar `zoompan` (el código ya documenta que se desboca). Usar `scale` con `eval=frame` y luego `crop` de tamaño fijo, p. ej.
     `scale=w='trunc(iw*(Z0+(Z1-Z0)*min(t/D,1))/2)*2':h=-2:eval=frame:flags=bicubic,crop=W:H:x=…:y=…`.
     ⚠️ El redondeo a pixeles enteros puede dar un leve "temblor" en zooms muy lentos; si se nota, escalar primero a 2× o limitar a zooms fijos en la v1.
5. **Vista previa**: en el reproductor del navegador, `transform: scale(Z)` + `transform-origin: cx cy` (y animación CSS para el smooth). Cero costo.
6. **Revisión**: en la línea de tiempo, una marquita con el % sobre cada clip con zoom; clic → inspector (§3.6); "Quitar todos los zooms".

Fuentes: [Gling ayuda – zoom y encuadre](https://www.gling.ai/help/zoom-and-framing), [Gling – página de zoom](https://gling.ai/zoom-in), [Primal Video: tutorial Gling (center to face)](https://primalvideo.com/guides/gling-ai-tutorial/), [1of10: jump cuts 110–120 %, cada 3–8 s](https://1of10.com/blog/what-is-a-jump-cut/), [Vizard: punch-ins solo al inicio de frase](https://agent.vizard.ai/how-to/stop-the-punch-ins-cycling-too-fast-in-a-talking-head-edit.html), [Submagic: zooms ligados al texto](https://submagic.co/features/auto-zooms), [Resolve Close Up](https://www.blackmagicdesign.com/products/davinciresolve/cut).

---

## 6. Groserías: cómo lo manejan y qué agregar

- Ninguno de los editores grandes (Gling, Descript, Premiere, Resolve) tiene censura de groserías integrada; en Descript es un pedido abierto. Las apps de clips (Captions, Choppity) ofrecen: **pitido**, **silencio**, **bajar volumen** y **enmascarar en subtítulos** (`p***`). Esto es una ventaja real de Emm Clips.
- **YouTube (29 jul 2025)**: las groserías fuertes en los **primeros 7 s ya no** limitan anuncios; **siguen** afectando si están en **título o miniatura** o si se usan **con mucha frecuencia** en todo el video. Conclusión práctica: lo que importa es la **frecuencia total**, no solo el inicio → mantener "silenciar todas las del diccionario" como opción principal y mostrar un contador "quedan N groserías sin tratar".
- **Agregar:**
  1. Modo **Pitido** (además de Silenciar): `sine=f=1000` mezclado solo en los rangos (−18 dBFS, con fundido de 5 ms para que no truene). Igual de rápido que Silenciar (video en copia).
  2. **Máscara en subtítulos** de Shorts y del video largo (`ch***`).
  3. **Niveles del diccionario**: "fuerte" (siempre) / "leve" (opcional, p. ej. "güey") para no silenciar de más.
  4. **Revisión rápida**: reproducir las groserías una tras otra (1 s antes / 1 s después) con teclas ←/→ y Enter para aceptar — como el panel de §3.2.

Fuentes: [YouTube relaja reglas de groserías (ppc.land)](https://ppc.land/youtube-removes-strong-profanity-restrictions-from-first-7-seconds/), [vidIQ: reglas 2026](https://vidiq.com/es/blog/post/youtube-profanity-update), [Captions: censura](https://captions.ai/help/docs/audio/censor.md), [Choppity: censura automática](https://www.choppity.com/tools/auto-censor-profanity-tool/), [Descript: pedido de bleep](https://feedback.descript.com/feature-requests/p/bleep-profanity).

---

## 7. Intro "teaser" (avance de los mejores momentos al inicio)

### 7.1 Qué funciona en YouTube
- **Cold open**: empezar directo en lo más interesante; nada de "hola, bienvenidos" ni logos largos. Si hay intro de marca, ≤ 1–5 s.
- **Montaje "lo que viene"**: cortes rápidos de los mejores momentos al inicio, **sin contexto** (abre un "pendiente" que el espectador quiere cerrar). Las guías hablan de 5–10 s para videos normales; para un directo resumido de 20–60 min, un avance de **30–60 s** es razonable si es rápido y variado.
- **Estructura de los primeros 30 s**: 0–5 s gancho fuerte, 5–15 s se entiende de qué va, 15–30 s qué está en juego. Retención en los primeros 30 s: > 70 % es buena, > 80 % excelente; si cae < 50 % en 10–15 s, el gancho falla.
- **No spoilear el remate**: mostrar la **reacción** o la **situación** ("¿qué hace este señor aquí?") y cortar antes del desenlace.
- Lo que se promete en el título/miniatura debe aparecer en el avance y luego en el video.

### 7.2 Receta recomendada para "Resumen del directo"
| Parámetro | Valor |
|---|---|
| Duración total | **35–60 s** (slider 20–90 s) |
| Número de momentos | 5–8 |
| Duración por momento | 3–8 s (el primero puede ser 8–10 s: el más fuerte) |
| Orden | 1º el más fuerte (gancho), luego variar tipo (risa → pleito → sorpresa), último uno que deje pregunta abierta |
| Corte | Entrar al inicio de frase y salir **antes del remate** (usar tiempos por palabra) |
| Transición | Corte seco o flash blanco de 2–3 cuadros; al final un "golpe" (zoom 1.15× + fundido corto) y entra el video |
| Audio | Normalizar cada pedazo a la misma sonoridad; opcional música baja (−24 LUFS) solo si es libre de derechos |
| Groserías | Se censuran igual que en el video (pitido queda bien en el avance) |
| Texto | Opcional: una línea arriba tipo "Hoy en el directo…" (tipografía propia) |
| Zoom | Cada momento con zoom 1.05–1.12 al centro de la cara para que "se sienta" distinto al video |

### 7.3 Cómo construirlo
- El resumen ya recibe de Sonnet candidatos con tiempos y "gancho". Pedirle en el mismo llamado un campo extra por momento: `teaser: {start, end, porqué, spoiler:bool}` (3–8 s, el pedazo más "picante" **sin** el remate). Reglas al modelo: "no incluyas el desenlace; corta en frase completa".
- En la UI del resumen: casilla **"Empezar con un avance de los mejores momentos (≈45 s)"** + lista reordenable de los pedazos del avance (▶ para ver cada uno).
- Al mandar al editor: insertar esos pedazos como clips al principio de la línea de tiempo con `.trans` (ya existe) y marca `teaser:true` para pintarlos de otro color.
- También útil para el video largo normal (no solo resumen): botón "Crear avance" que use los Shorts propuestos (ya tienen puntaje) como candidatos.

Fuentes: [1of10: ganchar en los primeros 30 s](https://1of10.com/blog/how-to-hook-viewers-in-the-first-30-seconds-of-a-youtube-video), [Teleprompter: duración de intros](https://www.teleprompter.com/blog/how-long-should-a-youtube-intro-be), [Pixflow: edición para retención (montaje de avance)](https://pixflow.net/blog/?p=93140), [Joyspace: técnica de "open loop"](https://joyspace.ai/open-loop-technique-force-viewers-watch-end), [Gyre: intros](https://gyre.pro/blog/how-to-make-your-youtube-intro-and-outro-irresistible-with-examples), [Subscribr: retención buena](https://subscribr.ai/p/what-is-good-youtube-audience-retention).

---

## 8. Roadmap priorizado (impacto vs esfuerzo)

Esfuerzo: S = ≤ 1 día · M = 2–4 días · L = 1–2 semanas. Impacto pensado para el flujo de los dos usuarios (directos largos de Shifu).

| # | Qué | Impacto | Esfuerzo | Notas / dónde |
|---|---|---|---|---|
| 1 | **Auto zoom en cortes** (alternar 1.00/1.10, ≥ 4 s por encuadre, centro en la cara, slider Intensidad) | Alto | M | §5. `zoomOf` + nuevo generador + `vision.js` muestreado por clip. |
| 2 | **Pitido** como opción de censura + máscara en subtítulos | Alto | S | §6. Solo filtro de audio; video sigue en copia. |
| 3 | **Ritmo y márgenes** (slider continuo + margen antes/después, sin re-analizar) | Alto | S–M | §3.3. Correr `silencedetect` una vez con `d=0.2` y filtrar en el navegador. |
| 4 | **Vista previa de la edición en el reproductor** (salta cortes, silencia groserías, simula zoom) | Alto | S–M | §3.9. Evita exportes de prueba de 40 min. |
| 5 | **Decodificar por GPU** (`-hwaccel cuda`) en exportes, con caída a CPU | Medio–alto | S | §4.2-B. Medir antes/después en un directo de 2 h. |
| 6 | **Avance (teaser) en Resumen del directo** | Alto | M | §7. Campo extra en el prompt a Sonnet + clips al inicio. |
| 7 | **Panel "Mostrar cortes" por tipo + regresar** | Alto | M | §3.2. Junta silencios, groserías y (luego) muletillas. |
| 8 | **Smart cut (beta)** en modo Cortar: copiar GOPs intactos | Alto en resumen/groserías, bajo en silencios | L | §4.2-A. Con validación de sincronía y caída al método actual. |
| 9 | **Edición por texto** (seleccionar palabras → borrar → tachado) | Alto | L | §3.1. Unificar modelo de datos de clips y cortes. |
| 10 | **Muletillas en español** ("eh", "este", "o sea", "bueno", "¿no?") con revisión | Medio | M | Lista editable como el diccionario; whisper a veces las omite → avisar. |
| 11 | **Deshacer/rehacer persistente** | Medio | M | §3.8. |
| 12 | **Atajos J/K/L, I/O, M, ?** | Medio | S | §3.7. |
| 13 | **Línea de tiempo doble** (mini-mapa del directo completo) | Medio | M | §3.4. Muy útil en 4–6 h. |
| 14 | **Proxies y miniaturas automáticos** en segundo plano al abrir | Medio | S | §4.2-E. |
| 15 | **Caché de tandas** y **tandas en paralelo** | Medio | M | §4.2-C/D. |
| 16 | **Tomas repetidas** (frases dichas 2 veces: quedarse con la última) con Sonnet sobre la transcripción | Medio (en IRL hay pocas "tomas") | M | Menos relevante que en videos grabados; dejar para después. |
| 17 | **Detector de partes aburridas** | Medio | M | §3.5. |
| 18 | **Exportar XML a Premiere/Resolve** (FCPXML/XMEML con los cortes) | Bajo para estos usuarios | M | Útil si algún día pasan a otro editor. |
| 19 | **Receta guardada / "un clic"** | Alto en tiempo ahorrado | S–M | §3.10. Hacer después de 1–4 para que la receta incluya zoom y ritmo. |

**Orden sugerido de entrega:** 2 → 3 → 4 → 1 → 5 → 6 → 19 → 7 → 12 → 14 → 8 → 9 → resto.
(Primero cosas chicas que se notan, luego zooms y avance, después lo grande de exportación y edición por texto.)

---

## 9. Riesgos y cosas a medir antes de construir

- **Sincronía A/V**: cualquier cambio de exportación (smart cut, hwaccel, paralelo) debe pasar la misma prueba de sincronía que ya se usó para el problema de `-ss` en MPEG-TS de Kick (PRE = 15 s). No activar por defecto sin esa prueba.
- **Calidad**: los zooms reescalan 1080p; no pasar de 1.25× en el video largo. Medir SSIM de NVENC con `temporal-aq` antes de cambiar parámetros.
- **Memoria de GPU** con `-hwaccel cuda` y ~100 entradas por tanda: puede fallar en GPUs de 6 GB; dejar caída a CPU.
- **Muletillas**: whisper tiende a "limpiar" muletillas del texto; puede que no aparezcan en la transcripción. Probar con un pedazo real antes de prometer la función.
- **Datos no publicados**: los valores exactos de zoom/frecuencia de Gling no son públicos; los de §5.3 son recomendación propia basada en prácticas de edición y en la resolución de la fuente. Ajustar con los usuarios viendo 2–3 videos.
