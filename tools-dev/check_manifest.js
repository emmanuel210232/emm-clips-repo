'use strict';
// Revisa version.json ANTES de publicar una versión en main:
// - que cada archivo de "files" exista en el repo y tenga un tipo permitido,
// - que cada require('./...') de esos archivos apunte a un archivo que TAMBIÉN venga en "files"
//   (si falta, a los usuarios se les rompería la app al actualizar),
// - que los .js no tengan errores de sintaxis,
// - que la versión de version.json sea la misma que APP_VERSION de server.js.
// Uso:  node tools-dev/check_manifest.js        (sale con código 1 si hay problemas)
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { safeRel, missingRequires } = require('../lib/updater');

const root = path.resolve(__dirname, '..');
// En las PCs de los usuarios ya existen aunque no vengan en "files" (los puso el instalador).
const PREINSTALLED = new Set(['channel_style.json']);

function check() {
  const problems = [];
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf8'));
  const staged = new Map();
  for (const rel of manifest.files || []) {
    let s; try { s = safeRel(rel); } catch (e) { problems.push(e.message); continue; }
    const f = path.join(root, s);
    if (!fs.existsSync(f)) { problems.push(`No existe en el repo: ${s}`); continue; }
    staged.set(s, fs.readFileSync(f, 'utf8'));
    if (s.endsWith('.js')) { const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' }); if (r.status !== 0) problems.push(`Error de sintaxis en ${s}: ${String(r.stderr).split('\n').slice(0, 3).join(' ')}`); }
  }
  for (const m of missingRequires(staged, rel => PREINSTALLED.has(rel))) problems.push(`Falta en version.json "files": ${m.require} (lo usa ${m.file})`);
  const srv = staged.get('server.js') || '';
  const appVer = (srv.match(/const APP_VERSION\s*=\s*'([^']+)'/) || [])[1];
  if (appVer && appVer !== manifest.version) problems.push(`version.json dice ${manifest.version} pero APP_VERSION en server.js dice ${appVer}`);
  return { version: manifest.version, files: staged.size, problems };
}

module.exports = { check };
if (require.main === module) {
  const r = check();
  if (!r.problems.length) { console.log(`OK: version.json ${r.version} con ${r.files} archivos, sin problemas.`); process.exit(0); }
  console.log(`Problemas en version.json ${r.version}:`); for (const p of r.problems) console.log('  - ' + p);
  process.exit(1);
}
