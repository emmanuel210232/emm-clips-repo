# Cómo regresar a una versión anterior

Hay dos casos:

- **Un usuario** quiere regresar en su PC → botón "Volver a la versión anterior" (o el `.cmd` de emergencia).
- **El equipo** quiere regresar la versión de **todos** → se hace desde el repo con `git revert` y se publica una versión con número **más alto**.

---

## 1. En la PC de un usuario

### Cómo se guardan los respaldos
Cada vez que la app se actualiza, **antes** de reemplazar archivos copia los actuales a:

```
data/backups/<versión>-<fecha>/
  meta.json        ← versión respaldada, fecha, archivos y a qué versión se actualizó
  files/...        ← copia de server.js, app.js, index.html, lib/*.js, etc.
```

Se conservan los **últimos 3** respaldos. `data/` nunca la toca el actualizador (ahí están proyectos, transcripciones y configuración), así que regresar de versión **no borra nada del usuario**.

Además, antes de instalar, la app:
- descarga **todos** los archivos primero (si se corta el internet a la mitad, no cambia nada),
- revisa que los `.js` no tengan errores de sintaxis, que los `.json` sean válidos y que cada `require('./...')` exista,
- si falla al escribir (disco lleno, antivirus), regresa sola lo respaldado.

### Botón "Volver a la versión anterior"
En **⚙️ Configuración de motores**, debajo de "Buscar actualizaciones":

1. Aparece **"↩️ Volver a la versión anterior (1.27.12)"** cuando hay un respaldo, con la fecha en que se guardó.
2. Al darle clic pide confirmación: *"¿Volver de la versión 1.28.0 a la 1.27.12?"*.
3. Restaura los archivos y pide **cerrar y volver a abrir la app**.
4. La versión de la que se regresó queda **pausada**: ya no sale el aviso de actualización para esa versión. Cuando se publique una versión **más nueva** (el arreglo), sí se ofrece normal.
5. Si alguien quiere probar otra vez la versión pausada: "Buscar actualizaciones" muestra *"La versión 1.28.0 está pausada…"* con el botón **"Instalar la 1.28.0 de todos modos"**.

Cada clic regresa **una** versión (el respaldo usado se borra porque ya es lo que está instalado). Con 3 respaldos se puede regresar hasta 3 versiones.

### Si la versión nueva ya ni abre
Doble clic en **`Volver a la version anterior.cmd`** (en la carpeta de la app). Muestra los respaldos, pregunta y regresa al más reciente. Equivale a:

```bash
node lib/updater.js respaldos
```

```bash
node lib/updater.js volver
```

> ⚠️ El `.cmd` y `lib/updater.js` llegan a los usuarios **solo si están en `version.json` → `files`** (ver §3).

---

## 2. Regresar la versión de TODOS desde el repo

El actualizador baja directo de `main` (`raw.githubusercontent.com/.../main/`) y **solo instala versiones con número mayor** a la que el usuario tiene. Por eso:

- ❌ **No** basta con regresar `main` a un commit viejo: `version.json` diría `1.27.12` y quien ya tiene la `1.28.0` **no recibiría nada** (1.27.12 < 1.28.0).
- ❌ **No** usar `git push --force` en `main`: rompe el historial y no arregla a quien ya actualizó.
- ✅ **Sí**: revertir con `git revert` y publicar con un número **nuevo y más alto**.

### Pasos (ejemplo: la 1.28.0 salió mala, la buena era la 1.27.12)

1. Traer `main` al día y ubicar el/los commits de la versión mala:

```bash
git checkout main
```

```bash
git pull origin main
```

```bash
git log --oneline -10
```

2. Revertir **sin** reescribir historial (un commit nuevo que deshace los cambios). Si la versión mala fue un solo commit:

```bash
git revert --no-edit <commit-malo>
```

   Si fueron varios commits seguidos (del más viejo `A` al más nuevo `B`):

```bash
git revert --no-commit A^..B
```

3. El revert deja `version.json` y `APP_VERSION` en `1.27.12`. **Súbelos a un número nuevo**, p. ej. `1.28.1`, en los dos lugares:
   - `version.json` → `"version": "1.28.1"` y unas `notes` claras, p. ej. *"Regresamos a como estaba la 1.27.12 mientras arreglamos X."*
   - `server.js` → `const APP_VERSION = '1.28.1';`

4. Revisar que el manifiesto esté completo y que las pruebas pasen:

```bash
node tools-dev/check_manifest.js
```

```bash
for f in tests/*.test.js; do node "$f" || exit 1; done
```

5. Commit y push a `main`:

```bash
git commit -am "1.28.1: regresar a la 1.27.12 (revert de la 1.28.0)"
```

```bash
git push origin main
```

### Qué pasa en cada PC
| Usuario tenía | Qué pasa |
|---|---|
| 1.28.0 (mala) | Le sale el aviso de la **1.28.1** y al instalarla vuelve al código bueno. Si ya había usado "Volver a la versión anterior", la 1.28.1 también se le ofrece (es más nueva que la pausada); instalarla no cambia nada visible. |
| 1.27.12 (no había actualizado) | Le sale la 1.28.1 (mismo código que ya tiene). Inofensivo. |

### Reglas para no volver a romper a todos
- **Nunca reutilizar un número de versión.** Siempre uno más alto que el último publicado.
- `version.json` y `APP_VERSION` siempre iguales (lo revisa `tools-dev/check_manifest.js`).
- Si un archivo nuevo se usa con `require('./...')`, **tiene que** estar en `files`, o la app de los usuarios no arranca. Lo revisa `tools-dev/check_manifest.js` (y desde esta versión el actualizador se niega a instalar algo así).
- Probar actualizaciones con el servidor falso (`EMM_UPDATE_URL`, ver abajo), **nunca** publicando en `main` para probar.

---

## 3. Antes de publicar la versión que trae este botón

Agregar a `version.json` → `files` (si no, a los usuarios les fallaría el arranque porque `server.js` usa `lib/updater.js`):

```json
"lib/updater.js",
"Volver a la version anterior.cmd"
```

`node tools-dev/check_manifest.js` avisa si falta `lib/updater.js`.

> Nota: los respaldos solo existen **a partir** de la primera actualización hecha con este actualizador nuevo. La actualización que lo instala la hace el actualizador viejo (sin respaldo), así que el botón aparece después de la siguiente versión.

---

## 4. Probar con un servidor de actualizaciones falso

La variable `EMM_UPDATE_URL` cambia de dónde baja las actualizaciones (por defecto, `main`). Ejemplo en una **copia** de la app:

```bash
mkdir -p /tmp/fake && cp server.js app.js index.html /tmp/fake/ && cp -r lib /tmp/fake/
```

Editar `/tmp/fake/version.json` con una versión mayor y la lista de archivos, y servir esa carpeta:

```bash
python3 -m http.server 4391 --bind 127.0.0.1 --directory /tmp/fake
```

Arrancar la copia de la app apuntando ahí:

```bash
EMM_UPDATE_URL=http://127.0.0.1:4391/ EDITOR_IRL_PORT=4392 node server.js
```

La prueba automática `tests/updater.test.js` hace todo esto sola (servidor falso + `server.js` real en una carpeta temporal).
