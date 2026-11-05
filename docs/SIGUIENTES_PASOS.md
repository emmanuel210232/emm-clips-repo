# Emm Clips — Resumen de la sesión en la nube y siguientes pasos

> Para retomar en una sesión normal de Claude Code. Fecha: 5 nov 2026. **Nada se subió a `main`**; todo está en ramas `nube/...`. `version.json` y `APP_VERSION` no se tocaron (main va en 1.27.13).

## 1. Qué hay en cada rama

| Rama | Estado | Qué trae | Reporte |
|---|---|---|---|
| `nube/calidad` | ✅ | Respaldo antes de actualizar (`data/backups/`, últimos 3), botón "Volver a la versión anterior", versión mala pausada, `.cmd` de emergencia, `tools-dev/check_manifest.js`, `docs/rollback.md`. Revisado por código (8 bugs corregidos). También `lib/seek.js` (corte exacto) y `tools-dev/check_cut.js`. | `REPORTE_calidad.md`, `REPORTE_corte-exacto.md` |
| `nube/diseno` | ✅ | Rediseño: pasos a la izquierda, reproductor al centro, ajustes a la derecha, línea del tiempo abajo, tema oscuro. `tests/ids.test.js`. Arreglo de contraste. | `REPORTE_diseno.md` |
| `nube/timeline` | ✅ | Zoom, recorte con imán, Espacio/J/K/L/S, deshacer/rehacer guardado, "Vista de la edición". 4 bugs corregidos por revisión. | `REPORTE_timeline.md` |
| `nube/integracion` | ✅ | main 1.27.13 + calidad + diseño + timeline fusionados y probados (91/92 pruebas; la saltada es la de siempre). | `REPORTE_integracion.md` |
| `nube/export-intro` | 🟡 | Intro de avance "PRÓXIMAMENTE..." + **corte exacto en todo el export** + GPU (NVDEC) con caída a CPU. | `REPORTE_export-intro.md`, `REPORTE_corte-exacto-export.md` |
| `nube/export-rapido` | ✅ | `lib/hwaccel.js` + `tools-dev/bench_export.js` (ya copiados a export-intro). | `REPORTE_export-rapido.md` |
| `nube/miniaturas-cola` | 🟡 | Galería de fotogramas, PNG exacto, caras expresivas (MediaPipe), cola de exports, Shorts con corte exacto. | `REPORTE_miniaturas-cola.md` |
| `nube/teaser-ia` | 🟡 | Sonnet propone el fragmento del avance sin el remate (sale de export-intro). | `REPORTE_teaser-ia.md` |
| `nube/autozoom` | 🟡 lógica | `lib/autozoom.js` (zoom en cortes 1.00/1.10, centro en cara). Falta conectarlo. | `REPORTE_autozoom.md` |
| `nube/ritmo` | 🟡 lógica | `lib/pace.js` + `/api/pace/*` (ritmo y márgenes de silencios). Falta la interfaz. | `REPORTE_ritmo.md` |
| `nube/muletillas` | 🟡 lógica | `lib/fillers.js` (muletillas en español, conservador). Falta la interfaz. | `REPORTE_muletillas.md` |
| `nube/investigacion` | ✅ | `docs/investigacion.md` (comparativa y roadmap). | — |

Los reportes viven en `docs/` de cada rama: `git show origin/<rama>:docs/<REPORTE>.md`.

## 2. Hallazgo importante: los cortes NO caían en el cuadro pedido
Con `-ss <antes> -i` + `trim` **relativo** (método de main), en MPEG-TS el corte caía hasta **~1.4 s (≈85 cuadros) antes** de lo pedido, y los Shorts empezaban 0.5–0.75 s tarde (subtítulos desfasados). La sincronía A/V sí sale bien porque audio y video se recorren juntos. Arreglo: `-copyts` + `trim`/`atrim` en **tiempo absoluto** (`lib/seek.js`); medido: 0 cuadros de diferencia y 4.7 ms de sincronía. Está aplicado en `nube/export-intro` y `nube/miniaturas-cola`, **pero falta verificarlo en Windows con el ffmpeg de los usuarios y un directo real**.

## 3. Orden recomendado para seguir (en una sesión normal)
1. **Verificar el corte exacto en la PC** (lo más importante; toca el corazón del export):
   ```bash
   runtime\node.exe tools-dev\check_cut.js --src "D:\ruta\directo.mpg" --times 600,3600,7200
   ```
   y en `nube/export-intro`: `node tools-dev/teaser_e2e.js 240 ABC` (casos Cortar, Silenciar y tandas; mide duración, sincronía, cuadro exacto y groserías calladas).
2. **Juntar en `nube/integracion`**, en este orden: `nube/export-intro` → `nube/miniaturas-cola` → `nube/teaser-ia` → otra vez `nube/diseno` y `nube/timeline` (traen arreglos posteriores a la integración). Guía de conflictos en `REPORTE_integracion.md`: conservar la estructura del rediseño (`#stage`, `#inspector`, `#timelineHost`, `#inspectorHost`). Ojo: export-intro y miniaturas-cola aplicaron el corte exacto a los Shorts en funciones distintas (`renderShort` vs `renderShortClip`); quedarse con `renderShortClip` + corte exacto.
3. **Correr todo** después de cada fusión: `for f in tests/*.test.js; do node "$f"; done`, `node tests/ids.test.js`, Playwright en 1366×768 y 1920×1080.
4. **Medir la GPU en la RTX 3070**: `runtime\node.exe tools-dev\bench_export.js --seconds 240 --runs 3`. Dejar GPU por defecto solo si SSIM ≥ 0.999 contra CPU, sincronía en ±1 cuadro y menos tiempo.
5. **Publicar** (ver §5).
6. Terminar las mejoras a medias (§4).

## 4. Lo que quedó pendiente
### Por verificar (hecho pero sin probar de punta a punta)
- Export completo con corte exacto: **caso A sí se corrió** con el código nuevo (fuente MPEG-TS 1080p60 de 120 s, Cortar + avance): duración exacta (119.5 s), **cuadro exacto** (error máximo 17 ms = 1 cuadro en 99 destellos del video y 20 del avance), 0 errores de decodificación, grosería callada. Sale `ok:false` solo porque la sincronía máxima fue 21.4 ms (límite 17.2 ms): coincide con el desfase entre el inicio del audio y el del video de la fuente; el arreglo (restar el mismo inicio absoluto a audio y video, ver `REVISION_FINAL.md` → `lib/seek.js` punto 3) falta aplicarlo y medirlo. Casos B (Silenciar) y C (tandas) **no** se corrieron con el código nuevo (la corrida del agente chocó en el puerto 4188 con esta).
- "Exportar frame" con el servidor real.
- Interfaz de miniaturas y cola en el navegador; subtítulos del Short contra la voz con una transcripción real. (La cola con 2 Shorts reales **sí pasó**: duración exacta, primer cuadro correcto y sincronía 4.7 ms.)
- Avance de la IA con la API real (solo se probó con respuestas de ejemplo).
- GPU real (en la nube no hay NVDEC).
- Arreglos de la revisión de la línea del tiempo en el navegador.
- Diseño en 1920×1080 y 1000×800, Configuración, Requisitos, tarjetas de Shorts y editor de tomas.

### Por terminar
- **Ritmo**: interfaz (slider Ritmo, márgenes antes/después con candado, resumen en vivo, Aplicar).
- **Muletillas**: interfaz (lista con casillas, ▶ escuchar, "Quitar las marcadas").
- **Auto zoom**: conectar `cropZoomFilter` al export, botón en la UI, centro en la cara con MediaPipe, vista previa.
- **Intro/outro sin doble codificación** (`finalizeExport` reencoda todo con x264): mayor ganancia de velocidad pendiente.
- Silenciar + avance reencoda todo el directo (1–2 h en 6 h): opción de codificar solo el avance.

### Bugs conocidos sin arreglar
- **Cuota de localStorage** (línea del tiempo): el historial guarda hasta 1.5 MB por video y nunca borra el de otros; con 3–4 videos **los clips pueden dejar de guardarse sin aviso**. Arreglo: al fallar por cuota, borrar `eirl_hist_*` de otros videos y reintentar. **Prioridad alta.**
- `buildTimeline` no limita `tlZoom` al agrandar la ventana (ancho > 4 M px).
- J durante la Vista de la edición se pelea con los saltos; dos saltos en < 150 ms pueden terminar la vista antes; la vista pedida desde un fragmento puede arrancar sola en otro video; el retroceso de J sigue al cambiar de video.
- Diseño: subtítulo "— marca lo que quieras aplicar" (Paso 4, tema claro) con contraste 2.86:1.
- `check_manifest.js` no ve los archivos que la página carga con `<script>` (p. ej. `lib/timeline-core.js`): enseñarle `staticFiles`.
- La cola detecta el fin de un export revisando cada 0.7 s: rara condición de carrera si otro proceso arranca justo ahí.
- **`docs/REVISION_FINAL.md` tiene todo lo que encontraron los 7 revisores finales**, por rama y prioridad. Lo más importante:
  - `lib/seek.js`: start_time negativo cerca de la vuelta de 33 bits → corte vacío (comprobado); saltos de marcas en directos reconectados; desfase A/V por `PTS-STARTPTS` por stream.
  - miniaturas-cola: dos exports a la vez (cola + botón), cola que se pierde al cerrar, galería que no se reinicia al cambiar de video, "Mejores momentos" que no funciona.
  - export-intro: `runDec` decide mal cuándo es falla de GPU; demasiadas entradas con GPU en el camino SEG.
  - teaser-ia: con IA local se pierden momentos en resúmenes largos.
  - muletillas/ritmo/autozoom: errores en lógica aún no conectada (ver documento).
  - Al cerrar la sesión se lanzaron agentes para corregir varios de estos; ver `git log` de cada rama.

## 5. Antes de publicar en `main` (checklist)
- [ ] Agregar a `version.json` → `files` lo que use la versión (si falta uno que `server.js` requiere, **la app no arranca**):
  `lib/updater.js`, `Volver a la version anterior.cmd`, `lib/timeline-core.js`, `lib/seek.js`, `lib/hwaccel.js`, `lib/teaser.js`, `lib/thumbs.js`, `lib/queue.js`, `miniaturas.js`, `cola.js` y, cuando se conecten, `lib/pace.js`, `lib/autozoom.js`, `lib/fillers.js`.
- [ ] Subir `version.json` **y** `APP_VERSION` al mismo número nuevo (más alto que 1.27.13; nunca reutilizar uno).
- [ ] `node tools-dev/check_manifest.js` sin problemas.
- [ ] Todas las pruebas pasan.
- [ ] Probar la actualización con el servidor falso (`EMM_UPDATE_URL`, ver `docs/rollback.md` §4), nunca publicando para probar.
- [ ] Recordar: la **primera** versión con el respaldo la instala el actualizador viejo (sin respaldo); si sale mala, el plan B es `git revert` + versión más alta (`docs/rollback.md`).
- [ ] Publicar por partes (primero calidad + rollback, luego corte exacto, luego lo visual) para poder regresar fácil.

## 6. Recomendaciones e ideas que pueden servir
- **Publicar primero `nube/calidad`** (rollback) sola: así cualquier versión siguiente ya tiene red de seguridad.
- Probar el corte exacto también con un `.mp4` normal (no MPEG-TS) y con un directo de 5–6 h (vuelta de marcas de tiempo de 33 bits ≈ 26.5 h).
- Del roadmap de `docs/investigacion.md` que no se tocó: panel "Mostrar cortes" por tipo con "regresar" (§3.2), edición por texto (§3.1), línea del tiempo doble/minimapa para directos largos (§3.4), "receta de un clic" (§3.10), proxies y miniaturas automáticos en segundo plano (§4.2-E), caché de tandas y tandas en paralelo con NVENC (§4.2-C/D), smart cut en modo Cortar (§4.2-A, grande y delicado).
- Mantener `tools-dev/check_cut.js`, `tools-dev/avsync.js`, `tools-dev/teaser_e2e.js` y `tools-dev/bench_export.js` como pruebas obligatorias antes de cualquier cambio de export.
- Las groserías se siguen **silenciando** (sin bip), por decisión de los usuarios.

## 7. Herramientas útiles que quedaron
| Herramienta | Para qué |
|---|---|
| `tools-dev/check_manifest.js` | Revisar `version.json` antes de publicar |
| `tools-dev/check_cut.js` | ¿El corte cae en el cuadro pedido? |
| `tools-dev/avsync.js` | Fuente sintética con destello+bip y medición de sincronía, PSNR/SSIM |
| `tools-dev/teaser_e2e.js` (export-intro) | Prueba de punta a punta del export con avance |
| `tools-dev/bench_export.js` | Tiempo, calidad y sincronía CPU vs GPU |
| `node lib/updater.js respaldos` / `volver` | Respaldos y regreso de versión desde terminal |
| `EMM_UPDATE_URL` + `EDITOR_IRL_PORT` | Probar actualizaciones con servidor falso en otro puerto |
