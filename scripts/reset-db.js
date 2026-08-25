/**
 * Wipes the database and lets db.js rebuild it from scratch with fresh seed
 * data. Useful when a schema change leaves an old file in an odd state, or
 * before recording a demo.
 *
 * Usage: npm run reset-db
 */
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const targets = ['app.db', 'app.db-wal', 'app.db-shm', 'smoke.db', 'smoke.db-wal', 'smoke.db-shm'];

let removed = 0;
targets.forEach((name) => {
  const file = path.join(dataDir, name);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    removed++;
    console.log(`  removed data/${name}`);
  }
});

const outbox = path.join(dataDir, 'outbox');
if (fs.existsSync(outbox)) {
  const count = fs.readdirSync(outbox).length;
  fs.rmSync(outbox, { recursive: true, force: true });
  console.log(`  removed data/outbox/ (${count} simulated emails)`);
}

console.log(removed ? '\nDatabase cleared. Start the server to rebuild it.\n' : '\nNothing to clear.\n');

// Rebuilding immediately means the next `npm start` is instant and any schema
// error surfaces here rather than on the first page load.
require('../db');
console.log('Rebuilt with seed workshops and the default admin account.\n');
process.exit(0);
