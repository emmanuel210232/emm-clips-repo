# Verificación en la PC del dueño (Windows, ffmpeg 8 de `tools/`) — 5 nov 2026

## Corte exacto: el método ACTUAL de main ya cae en el cuadro pedido
`tools-dev/check_cut.js` con dos directos reales de Kick:

| Directo | Formato | start_time | min 5 | min 20 | min 40 |
|---|---|---|---|---|---|
| soypan (3 h 14) | `.mp4` que es MPEG-TS | 13019.083 s | 0 cuadros | 0 | 0 |
| shifu_conoce_a_su_maestro (2 h 12) | `.mpg` | 11187.366 s | 0 cuadros | 0 | 0 |

El método nuevo (`-copyts` + trim absoluto) también dio 0, pero **no mejora nada en las PCs de los usuarios** y agrega riesgos
(vuelta de 33 bits, saltos de marcas en directos reconectados, desfase por `PTS-STARTPTS` por stream; ver `REVISION_FINAL.md`).
El adelanto de ~1.4 s que se midió en la nube viene de su ffmpeg/fuente sintética, no se reproduce aquí.

**Decisión:** NO llevar a main el cambio de corte exacto (`lib/seek.js` en el export, Shorts y miniaturas). Mantener el método actual
(`-ss` 15 s antes + `trim` relativo), que ya está medido en sincronía (0 ms) y ahora también en cuadro (0 cuadros).
Si en el futuro se usa `lib/seek.js` para algo nuevo (p. ej. miniaturas), volver a medir con este script en la PC.

## Arreglo en la herramienta
- `check_cut.js`: `-vsync 0` ya no existe en ffmpeg 8 → cambiado a `-fps_mode passthrough`.
