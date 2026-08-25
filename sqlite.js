/**
 * SQLite driver adapter.
 *
 * Prefers `better-sqlite3` when it is installed and built. If it is not
 * available — commonly on Windows, where it needs Visual Studio build tools and
 * a Windows SDK to compile — it falls back to `node:sqlite`, the SQLite driver
 * built into Node 22.5+ (stable from Node 24). No compiler required.
 *
 * Both drivers expose the same small surface used by this app:
 *   db.exec(sql)
 *   db.pragma(str)
 *   db.prepare(sql).run(...params) -> { changes, lastInsertRowid }
 *   db.prepare(sql).get(...params) -> row | undefined
 *   db.prepare(sql).all(...params) -> row[]
 */

// ---- Option 1: better-sqlite3 (native) ----
try {
  const BetterSqlite3 = require('better-sqlite3');
  module.exports = BetterSqlite3;
  module.exports.driverName = 'better-sqlite3';
} catch (nativeError) {
  // ---- Option 2: node:sqlite (built in) ----
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (builtinError) {
    const version = process.versions.node;
    throw new Error(
      `No SQLite driver available.\n\n` +
        `  - better-sqlite3 is not installed or failed to build\n` +
        `  - node:sqlite is not available in Node ${version}\n\n` +
        `Fix by either upgrading to Node 22.5 or newer (recommended — no compiler needed),\n` +
        `or installing the Visual Studio build tools so better-sqlite3 can compile.\n`
    );
  }

  class Database {
    constructor(file) {
      this.db = new DatabaseSync(file);
    }

    exec(sql) {
      return this.db.exec(sql);
    }

    pragma(statement) {
      // better-sqlite3 takes 'journal_mode = WAL'; node:sqlite needs full SQL.
      try {
        return this.db.exec(`PRAGMA ${statement}`);
      } catch (err) {
        return null;
      }
    }

    prepare(sql) {
      return this.db.prepare(sql);
    }

    close() {
      return this.db.close();
    }
  }

  module.exports = Database;
  module.exports.driverName = 'node:sqlite';
}
