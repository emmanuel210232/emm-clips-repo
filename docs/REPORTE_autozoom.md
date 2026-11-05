# Reporte — Zoom automático en los cortes (rama `nube/autozoom`) — **A MEDIAS: falta conectarlo**

## Qué hice
`lib/autozoom.js` (Node y navegador como `window.AutoZoom`) con 7 pruebas en `tests/autozoom.test.js`:
- `planAutoZoom(clips, {level, words, segments, energy, faceOf})`: alterna 1.00× / Z en cada corte (Suave 1.06, Normal 1.10, Fuerte 1.15); encuadre ≥ 4 s; clips < 2.5 s heredan el zoom anterior; máximo ~1 cambio cada 6 s; si pasan > 25 s sin cambio, parte el clip en el siguiente inicio de frase; golpe 1.18× en picos fuertes de voz, nunca más de 1.25×; centra en la cara sin salirse del cuadro (sin cara: tercio superior central); respeta los zooms puestos a mano (`zoomManual`).
- `removeAutoZoom`, `cropZoomFilter(clip, W, H)` (recorte con medidas pares + reescalado lanczos al tamaño original; compatible con los clips viejos `zoom:true` = 1.12× al centro), `previewTransform` (CSS para la vista previa) y `sanitizeSegmentZoom`.
- Probado con ffmpeg: `crop=1744:980:174:1,scale=1920:1080:flags=lanczos` sale 1920×1080, SAR 1:1, sin barras.

## Cómo probarlo
```bash
node tests/autozoom.test.js
```

## Qué falta (no cambia nada para el usuario todavía)
1. `server.js`, export modo Cortar: `zoom:!!s.zoom` → `...sanitizeSegmentZoom(s)`; `zoomOf` (`crop=iw/1.12…`) → `cropZoomFilter(k, ZW, ZH)`; `hasZoom` → `zoomValue(k) > 1`; servir `/lib/autozoom.js` en `staticFiles`; opcional: que `/api/suggest-zooms` regrese la energía por segundo.
2. `app.js` / `index.html`: botón "🔍 Zoom automático en los cortes" (Suave/Normal/Fuerte) y "Quitar zooms automáticos" junto a "Sugerir zooms"; mandar `zoom`, `zoomCx`, `zoomCy` en `segments`; `toggleZoom` marca `zoomManual: true`; vista previa con `previewTransform`; % de zoom en la marca 🔍 de cada clip.
3. Centro en la cara con MediaPipe (`vision.js`), 1 cuadro por clip, pasado como `faceOf`.
4. Export real con zoom: sincronía, tamaño y calidad. Con el corte exacto de `nube/export-intro`, el zoom va después del trim.

## Riesgos
- Lanczos cambia muy poco los zooms viejos `zoom:true` (antes bicúbico); nitidez igual o mejor.
- En 1080p, más de 1.15× ya pierde nitidez: tope 1.25×, golpe 1.18×.
- La vista previa en el navegador es aproximada.

## Archivos para version.json → files (al publicar)
`lib/autozoom.js`
