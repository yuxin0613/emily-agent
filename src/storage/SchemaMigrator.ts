import { runSqliteWithRetry, type SqliteDatabase } from "./Sqlite.ts";

export interface Migration {
  version: number;
  name: string;
  up: () => void;
}

export class SchemaMigrator {
  db: SqliteDatabase;
  namespace: string;

  constructor({ db, namespace }: { db: SqliteDatabase; namespace: string }) {
    this.db = db;
    this.namespace = namespace;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        namespace TEXT NOT NULL,
        version INTEGER NOT NULL,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        PRIMARY KEY (namespace, version)
      );
    `);
  }

  apply(migrations: Migration[]): void {
    const ordered = [...migrations].sort((a, b) => a.version - b.version);
    runSqliteWithRetry(() => this.db.exec("BEGIN IMMEDIATE"));
    try {
      for (const migration of ordered) {
        if (this.hasMigration(migration.version)) continue;
        migration.up();
        this.db
          .prepare("INSERT INTO schema_migrations (namespace, version, name, applied_at) VALUES (?, ?, ?, ?)")
          .run(this.namespace, migration.version, migration.name, new Date().toISOString());
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original migration error when rollback cannot run.
      }
      throw error;
    }
  }

  hasMigration(version: number): boolean {
    const row = this.db
      .prepare("SELECT version FROM schema_migrations WHERE namespace = ? AND version = ?")
      .get(this.namespace, version);
    return Boolean(row);
  }
}
