// Purga el contenido de un store de WAHA (GOWS) y compacta el archivo.
// NO toca las tablas de device/crypto: el pairing se conserva.
//
// Requisitos: la sesión debe estar DETENIDA y hay que tener un backup del .db.
//
// Uso:
//   docker cp purgar-store.js <container>:/tmp/
//   docker exec <container> node /tmp/purgar-store.js /app/.sessions/gows/<sesion>/gows.db
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const file = process.argv[2];
if (!file) {
  console.error('uso: node purgar-store.js <ruta al .db>');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error(`no existe: ${file}`);
  process.exit(1);
}

// Tablas de contenido. Las de device/crypto (whatsmeow_device, keys, sessions, pre_keys,
// identity_keys) quedan intactas porque sostienen el pairing.
const TABLES = [
  'gows_messages',
  'whatsmeow_message_secrets',
  'whatsmeow_app_state_mutation_macs',
  'gows_labels',
  'gows_label_associations',
  'gows_chat_ephemeral_setting',
];

const before = fs.statSync(file).size;
const db = new DatabaseSync(file);
for (const table of TABLES) {
  try {
    db.exec(`DELETE FROM "${table}"`);
    console.log('purgada', table);
  } catch (e) {
    console.log('skip', table, e.message);
  }
}
try {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
} catch (e) {
  console.log('checkpoint:', e.message);
}
db.exec('VACUUM');
const after = fs.statSync(file).size;
console.log(
  `${(before / 1048576).toFixed(1)} MB -> ${(after / 1048576).toFixed(1)} MB (liberado ${(
    (before - after) / 1048576
  ).toFixed(1)} MB)`,
);
