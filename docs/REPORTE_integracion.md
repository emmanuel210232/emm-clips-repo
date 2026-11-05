# Reporte — Integración (rama `nube/integracion`)

## Qué se fusionó
Base `main` 1.27.13 + `nube/calidad` + `nube/diseno` + `nube/timeline`, con merges normales (sin reescribir historial). No se tocó `version.json` ni la línea de `APP_VERSION` (queda 1.27.13, igual que main).

## Conflictos y cómo se resolvieron
- **index.html (calidad × diseño):** "⚙️ Configuración de motores" quedó en el panel derecho del rediseño; la fila **"Volver a la versión anterior"** (`#rollbackRow`) va dentro de Configuración, debajo de "Buscar actualizaciones".
- **index.html (diseño × línea del tiempo):** se conservó la estructura del rediseño (`appShell`, `#stage`, `#inspector`, `#timelineHost`, `#inspectorHost`) y se acomodaron ahí los controles nuevos: `editViewBadge` en el reproductor; `tlZoomFit`, `tlZoomLevel` y `tlRate` junto al zoom; "Dividir (S)"; `tlRedo` y `tlEditView` después de Deshacer; ayuda de atajos en el plegable; `<script src="/timeline-core.js">` antes de `app.js`.
- **style.css:** primero el bloque de la línea del tiempo y **hasta abajo** el del rediseño.
- **app.js y server.js:** se fusionaron solos.

## Error encontrado y corregido
El **primer** cambio después de abrir un video (p. ej. dividir) no se podía deshacer: al abrir aún no se conoce la duración y el historial se quedaba sin punto de partida. Ahora `ensureClips` lo fija. El error sigue en `nube/timeline`; aquí ya está corregido.

## Pruebas
- `node --test tests/*.test.js`: 92 pruebas, 91 pasan, 0 fallan, 1 se salta (ya se saltaba en main; necesita el ffmpeg de Windows).
- Playwright (video de prueba de 40 s, respaldo 1.27.12 simulado): pasos 1–4, Resumen e Investigar sin scroll horizontal en 1366×768 y 1920×1080; Configuración muestra "↩️ Volver a la versión anterior (1.27.12)"; zoom de la línea del tiempo; S divide, Ctrl+Z deshace y tras recargar Ctrl+Y rehace; Vista de la edición; 0 errores de consola.
- Capturas: `docs/capturas/integracion_*.png` (9).

## Archivos que hay que agregar a version.json → files antes de publicar
- `lib/updater.js` (sin él la app **NO arranca**)
- `Volver a la version anterior.cmd`
- `lib/timeline-core.js` (sin él arranca, pero sin rehacer ni vista de la edición)
- Al sumar las otras ramas: `lib/teaser.js`, `lib/seek.js`, `lib/hwaccel.js` (export-intro); `lib/thumbs.js` y `lib/queue.js` (miniaturas-cola; sin ellos **NO arranca**), `miniaturas.js` y `cola.js`.

`node tools-dev/check_manifest.js` hoy no ve `lib/timeline-core.js` porque se carga con `<script>`, no con `require()`. Pendiente: que también revise los archivos de `staticFiles`.

## Riesgos
- La UI de miniaturas, la cola y la opción del avance se escribieron sobre el acomodo viejo: al sumarlas habrá conflictos en `index.html`, `app.js` y `style.css`.
- El historial de deshacer vive en el navegador (localStorage), igual que los clips.

## Pasos para sumar export-intro y miniaturas-cola (y las mejoras nuevas)
1. `git fetch origin nube/export-intro nube/miniaturas-cola` y `git checkout --detach origin/nube/integracion`.
2. `git merge --no-edit origin/nube/export-intro`: la casilla del avance y "👀 Ver qué momentos entran" van en la sección del Paso 4 dentro de `#inspector`, y la del Resumen en su sección.
3. `git merge --no-edit origin/nube/miniaturas-cola`: galería en el centro o en `#inspectorHost`, cola en el Paso 4.
4. Después: `nube/autozoom`, `nube/ritmo`, `nube/muletillas`, `nube/teaser-ia` (ver sus reportes).
5. Correr todas las pruebas, `node tests/ids.test.js`, revisión en navegador, `tools-dev/teaser_e2e.js` y `tools-dev/check_cut.js`. Push a `nube/integracion`, nunca a main.
