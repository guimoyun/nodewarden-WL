// Local D1Database-compatible implementation backed by node:sqlite.
// Implements the surface actually used by NodeWarden:
//   prepare(sql).bind(...).all() / .run() / .first()
//   db.batch(statements)   db.exec(sql)
// plus meta.changes / meta.last_row_id used by storage repos.

import { DatabaseSync } from 'node:sqlite';

interface D1ResultMeta {
  changes: number;
  duration: number;
  last_row_id?: number;
}

interface D1Result {
  success: boolean;
  meta: D1ResultMeta;
  results?: unknown[];
  error?: string;
}

function toJsValue(value: unknown): unknown {
  // node:sqlite may return bigint for INTEGER columns; D1 returns numbers.
  if (typeof value === 'bigint') {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : value;
  }
  return value;
}

export class LocalD1Statement {
  private values: unknown[] = [];

  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string
  ) {}

  bind(...values: unknown[]): this {
    this.values = values.map((v) => (v === undefined ? null : v));
    return this;
  }

  private prepare() {
    const stmt = this.db.prepare(this.sql);
    const values = this.values;
    return {
      run: () => (values.length > 0 ? stmt.run(...values) : stmt.run()),
      all: () => (values.length > 0 ? stmt.all(...values) : stmt.all()),
      get: () => (values.length > 0 ? stmt.get(...values) : stmt.get()),
    };
  }

  /** D1 .all(): execute the statement and return result rows. */
  async all<T = unknown>(): Promise<{ results: T[]; success: boolean; meta: D1ResultMeta }> {
    const { all } = this.prepare();
    const rows = all() as unknown[];
    return {
      results: rows.map((row) => {
        if (row && typeof row === 'object') {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(row as Record<string, unknown>)) out[k] = toJsValue(v);
          return out as T;
        }
        return row as T;
      }),
      success: true,
      meta: { changes: 0, duration: 0 },
    };
  }

  /** D1 .first(): return the first row or null. */
  async first<T = unknown>(): Promise<T | null> {
    const { get } = this.prepare();
    const row = get() as Record<string, unknown> | undefined;
    if (!row) return null;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) out[k] = toJsValue(v);
    return out as T;
  }

  /** D1 .run(): execute a write statement and report affected rows. */
  async run(): Promise<{ success: boolean; meta: D1ResultMeta; results?: never[] }> {
    const { run } = this.prepare();
    const info = run() as { changes: number | bigint; lastInsertRowid: number | bigint };
    return {
      success: true,
      meta: {
        changes: Number(info.changes) || 0,
        duration: 0,
        last_row_id: Number(info.lastInsertRowid) || 0,
      },
      results: [],
    };
  }

  async raw<T = unknown>(): Promise<T[]> {
    const result = await this.all<T>();
    return result.results;
  }

  /** Internal single-execution helper used by db.batch(). */
  _execute(): { rows: unknown[]; changes: number } {
    const { all, run } = this.prepare();
    const rows = all() as unknown[];
    // all() already executed the statement (works for both SELECT and writes).
    // For writes the change count is not exposed by all(); re-derive conservatively:
    // run() again would double-execute, so we only report rows for batch consumers.
    void run;
    return { rows, changes: 0 };
  }
}

export class LocalD1Database {
  private readonly db: DatabaseSync;

  constructor(
    dbPathOrDb: string | DatabaseSync,
    private readonly enableWAL = true
  ) {
    this.db = typeof dbPathOrDb === 'string' ? new DatabaseSync(dbPathOrDb) : dbPathOrDb;
    if (typeof dbPathOrDb === 'string' && this.enableWAL) {
      try {
        this.db.exec('PRAGMA journal_mode=WAL');
        this.db.exec('PRAGMA foreign_keys=ON');
        this.db.exec('PRAGMA busy_timeout=5000');
      } catch {
        // WAL pragma is best-effort.
      }
    }
  }

  prepare(sql: string): LocalD1Statement {
    return new LocalD1Statement(this.db, sql);
  }

  async batch(statements: LocalD1Statement[]): Promise<D1Result[]> {
    const out: D1Result[] = [];
    this.db.exec('BEGIN');
    try {
      for (const stmt of statements) {
        const { rows } = stmt._execute();
        out.push({ success: true, meta: { changes: 0, duration: 0 }, results: rows });
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return out;
  }

  async exec(sql: string): Promise<D1Result> {
    this.db.exec(sql);
    return { success: true, meta: { changes: 0, duration: 0 } };
  }

  async dump(): Promise<Uint8Array> {
    return new Uint8Array();
  }

  close(): void {
    this.db.close();
  }
}
