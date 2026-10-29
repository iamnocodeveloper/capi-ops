// Inspecciona los archivos del store de WAHA dentro de un contenedor. Solo lectura.
// Uso: docker cp inspect-store.js <container>:/tmp/ && docker exec <container> node /tmp/inspect-store.js [/app/.sessions]
const fs = require('fs');
const path = require('path');

const base = process.argv[2] || '/app/.sessions';

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(base)
  .map((f) => ({ f, size: fs.statSync(f).size }))
  .sort((a, b) => b.size - a.size);

const total = files.reduce((acc, x) => acc + x.size, 0);
console.log(`${base}: ${(total / 1048576).toFixed(1)} MB en ${files.length} archivos`);

for (const item of files.filter((x) => /\.(db|sqlite3)$/.test(x.f))) {
  console.log(`\n--- ${item.f}  ${(item.size / 1048576).toFixed(2)} MB`);
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(item.f);
    const tables = db.prepare("select name from sqlite_master where type='table' order by name").all();
    const rows = [];
    for (const t of tables) {
      let count = 0;
      try {
        count = db.prepare(`select count(*) c from "${t.name}"`).get().c;
      } catch {}
      if (count > 0) rows.push([t.name, count]);
    }
    rows.sort((a, b) => b[1] - a[1]);
    for (const [name, count] of rows) console.log(String(count).padStart(9), name);
  } catch (e) {
    console.log('sqlite error:', e.message);
  }
}
