// Comprueba que cada id que usan app.js / vision.js / investigar.js exista en index.html.
// Sirve para que un cambio de diseño (mover paneles, renombrar contenedores) no rompa
// ningún botón: si falta un id, esta prueba falla y dice cuál.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SCRIPTS = ['app.js', 'vision.js', 'investigar.js'];
const html = read('index.html');

// ids que existen en el HTML estático
function htmlIds(src) {
  const ids = [];
  for (const m of src.matchAll(/\sid\s*=\s*["']([^"']+)["']/g)) ids.push(m[1]);
  return ids;
}

// ids que el propio JS crea en tiempo de ejecución (plantillas `id="x"` o `el.id = 'x'`).
// Esos no tienen por qué estar en index.html (p. ej. el panel de Investigar se pinta entero desde investigar.js).
function jsCreatedIds(src) {
  const ids = new Set();
  for (const m of src.matchAll(/\bid\s*=\s*\\?["']([A-Za-z][\w-]*)\\?["']/g)) ids.add(m[1]);
  for (const m of src.matchAll(/\.id\s*=\s*["'`]([A-Za-z][\w-]*)["'`]/g)) ids.add(m[1]);
  return ids;
}

// ids que el JS busca: $('x'), getElementById('x'), on('x', …) y listas ['a','b'].forEach(id => $(id) …)
function jsReferencedIds(src) {
  const ids = new Set();
  for (const m of src.matchAll(/\$\(\s*["'`]([^"'`$]+)["'`]\s*\)/g)) ids.add(m[1]);
  for (const m of src.matchAll(/getElementById\(\s*["'`]([^"'`$]+)["'`]\s*\)/g)) ids.add(m[1]);
  for (const m of src.matchAll(/\bon\(\s*["']([A-Za-z][\w-]*)["']\s*,/g)) ids.add(m[1]);
  for (const m of src.matchAll(/\[((?:\s*["'][\w-]+["']\s*,?)+)\]\s*\.forEach\(\s*\(?\s*id\s*\)?\s*=>/g)) {
    for (const s of m[1].matchAll(/["']([\w-]+)["']/g)) ids.add(s[1]);
  }
  return ids;
}

test('cada id que usa el JS existe en index.html (o lo crea el propio JS)', () => {
  const inHtml = new Set(htmlIds(html));
  const created = new Set();
  for (const f of SCRIPTS) for (const id of jsCreatedIds(read(f))) created.add(id);
  const missing = [];
  for (const f of SCRIPTS) {
    for (const id of jsReferencedIds(read(f))) {
      if (!inHtml.has(id) && !created.has(id)) missing.push(`${f}: #${id}`);
    }
  }
  assert.deepEqual(missing, [], 'Faltan estos ids en index.html:\n' + missing.join('\n'));
});

test('el detector encuentra los ids (sanidad: no está leyendo vacío)', () => {
  const refs = jsReferencedIds(read('app.js'));
  assert.ok(refs.size > 100, 'app.js debería referenciar más de 100 ids, encontró ' + refs.size);
  for (const id of ['video', 'timeline', 'export', 'notice', 'jobBar']) assert.ok(refs.has(id), 'no detectó #' + id);
});

test('no hay ids repetidos en index.html', () => {
  const seen = new Set(), dup = new Set();
  for (const id of htmlIds(html)) { if (seen.has(id)) dup.add(id); seen.add(id); }
  assert.deepEqual([...dup], [], 'ids repetidos: ' + [...dup].join(', '));
});

test('existen los contenedores para módulos externos (línea de tiempo e inspector)', () => {
  const ids = new Set(htmlIds(html));
  assert.ok(ids.has('timelineHost'), 'falta <div id="timelineHost"> en la zona de la línea de tiempo');
  assert.ok(ids.has('inspectorHost'), 'falta <div id="inspectorHost"> en el inspector');
});
