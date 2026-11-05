# Reporte — Muletillas en español (rama `nube/muletillas`) — **A MEDIAS: falta la interfaz**

## Qué hice
- **`lib/fillers.js`** (Node y navegador, como `window.EmmFillers`):
  - Lista editable por defecto. **Seguras** (se marcan solas): `eh`, `ehh`, `eeeh`, `em`, `emm`, `mmm`, `hmm`. **Para revisar** (se listan sin marcar): `este…`, `o sea`, `bueno`, `pues`, `¿no?`, `ah`.
  - Criterio **conservador** (mejor no marcar que cortar de más). No se marcan: "este video" (sin pausa), "está bueno"/"muy bueno"/"bueno es…", "pues sí/no/claro/ya", "o sea que…" sin pausa, la "e" que es "y" ("e iba"), el "no" al inicio de una respuesta.
  - "este" solo con pausa, coma, "…" o repetido; "Bueno," solo al empezar a hablar y con pausa; "¿no?" solo como coletilla al final.
  - Con tiempos aproximados (SRT o pedazo de varias palabras) **nunca** se marca sola.
  - Muletillas propias del usuario: frase exacta, solo si viene seguida de pausa.
  - Tramo a quitar: la palabra con 0.03 s de margen; si junto hay un silencio ≥ 0.15 s también se lo come, dejando 0.08 s junto a la palabra vecina (sin huecos que se noten).
  - Funciones: `findFillers`, `fillerCuts`, `removeFromClips` (quita tramos de los clips cerrando el hueco como `cutRange` de `app.js`) e `isRemoved`.
- **`tests/fillers.test.js`**: 6 pruebas. Todas las pruebas de `tests/` pasan.

## Cómo probarlo
```bash
node tests/fillers.test.js
```

## Qué falta
1. **Interfaz** en el Paso 2 (tarjeta plegable debajo de "Pausas largas"): "Buscar muletillas" con contador; lista con casillas y ▶ para escuchar 1 s antes/después; "Marcar solo las seguras" / "Desmarcar todas"; "Quitar las marcadas" (un solo paso de deshacer); lista editable de muletillas propias; aviso de que Whisper a veces no escribe las muletillas; aviso de que conviene el modo **Cortar**.
2. Servir el archivo: `'/lib/fillers.js'` en `staticFiles` de `server.js` y `<script src="/lib/fillers.js">` en `index.html`.
3. Probarlo con una transcripción real y ajustar las reglas con los usuarios.

## Riesgos
- Whisper tiende a "limpiar" las muletillas: puede que salgan pocas.
- Las reglas de "este", "bueno" y "pues" son heurísticas; por eso nunca se marcan solas.

## Antes de publicar en `main`
Agregar `lib/fillers.js` a `version.json` → `files` cuando la interfaz lo use.
