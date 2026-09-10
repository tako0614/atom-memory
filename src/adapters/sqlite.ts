import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { AtomRevision, Ref } from '../contracts.js';
import type { ScanQuery, StorageAdapter } from './storage.js';
import { uid } from '../core/util.js';
/** Local durable adapter. SQLite coordinates concurrent processes through short write transactions. */
export class SqliteStorage implements StorageAdapter {
  readonly capabilities = { snapshot: true, atomicBatch: true, queryGuards: true };
  readonly id: string;
  #db: DatabaseSync;
  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS am_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO am_state VALUES ('sequence','0');
      CREATE TABLE IF NOT EXISTS am_revisions (
        atom_id TEXT NOT NULL, revision_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL,
        policy TEXT NOT NULL, schema_name TEXT NOT NULL, state TEXT NOT NULL, body_text TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS am_history ON am_revisions(atom_id, sequence DESC);
      CREATE INDEX IF NOT EXISTS am_scope ON am_revisions(policy, schema_name, atom_id);
      CREATE TABLE IF NOT EXISTS am_slots (revision_id TEXT NOT NULL, target_id TEXT NOT NULL, role TEXT NOT NULL, target_revision TEXT);
      CREATE INDEX IF NOT EXISTS am_relations ON am_slots(target_id, role, revision_id);
      CREATE TABLE IF NOT EXISTS am_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS am_purged (atom_id TEXT PRIMARY KEY);
    `);
    this.#db.prepare("INSERT OR IGNORE INTO am_state VALUES ('id',?)").run(uid('sqlite'));
    this.id = (
      this.#db.prepare("SELECT value FROM am_state WHERE key='id'").get() as { value: string }
    ).value;
  }
  watermark(): number {
    return Number(
      (
        this.#db.prepare("SELECT value FROM am_state WHERE key='sequence'").get() as {
          value: string;
        }
      ).value,
    );
  }
  transaction<T>(fn: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
  get(ref: Ref, at: number): AtomRevision | undefined {
    if (this.isPurged(ref.atomId)) return;
    const params: SQLInputValue[] = [ref.atomId, at];
    if (ref.kind === 'pinned') params.push(ref.revisionId);
    const row = this.#db
      .prepare(
        `SELECT data FROM am_revisions WHERE atom_id=? AND sequence<=? ${ref.kind === 'pinned' ? 'AND revision_id=?' : ''} ORDER BY sequence DESC LIMIT 1`,
      )
      .get(...params) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as AtomRevision) : undefined;
  }
  scan(q: ScanQuery, at: number): AtomRevision[] {
    if (!q.policies.length || q.limit === 0 || q.schema?.length === 0) return [];
    const clauses = [
      'r.sequence<=?',
      'r.sequence=(SELECT MAX(h.sequence) FROM am_revisions h WHERE h.atom_id=r.atom_id AND h.sequence<=?)',
      "r.state='active'",
      `r.policy IN (${q.policies.map(() => '?').join(',')})`,
    ];
    const args: SQLInputValue[] = [at, at, ...q.policies];
    if (q.after !== undefined) {
      clauses.push('r.atom_id>?');
      args.push(q.after);
    }
    if (q.schema) {
      clauses.push(`r.schema_name IN (${q.schema.map(() => '?').join(',')})`);
      args.push(...q.schema);
    }
    if (q.relation) {
      let slot = 's.revision_id=r.revision_id AND s.target_id=?';
      args.push(q.relation.target.atomId);
      if (q.relation.role) {
        slot += ' AND s.role=?';
        args.push(q.relation.role);
      }
      if (q.relation.target.kind === 'pinned') {
        slot += ' AND (s.target_revision IS NULL OR s.target_revision=?)';
        args.push(q.relation.target.revisionId);
      }
      clauses.push(`EXISTS(SELECT 1 FROM am_slots s WHERE ${slot})`);
    }
    if (q.text?.length) {
      clauses.push(`(${q.text.map(() => 'instr(r.body_text,?)>0').join(' OR ')})`);
      args.push(...q.text);
    }
    args.push(q.limit);
    return (
      this.#db
        .prepare(
          `SELECT r.data FROM am_revisions r WHERE ${clauses.join(' AND ')} ORDER BY r.atom_id LIMIT ?`,
        )
        .all(...args) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as AtomRevision);
  }
  history(after: string | undefined, limit: number): AtomRevision[] {
    return (
      this.#db
        .prepare('SELECT data FROM am_revisions WHERE revision_id>? ORDER BY revision_id LIMIT ?')
        .all(after ?? '', limit) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as AtomRevision);
  }
  append(revisions: readonly AtomRevision[]): void {
    const sequence = this.watermark() + 1;
    const insert = this.#db.prepare('INSERT INTO am_revisions VALUES (?,?,?,?,?,?,?,?)');
    const slot = this.#db.prepare('INSERT INTO am_slots VALUES (?,?,?,?)');
    for (const r of revisions) {
      insert.run(
        r.atomId,
        r.revisionId,
        sequence,
        r.policyId,
        r.schema,
        r.state,
        JSON.stringify(r.body).normalize('NFKC').toLowerCase(),
        JSON.stringify(r),
      );
      for (const s of r.slots)
        slot.run(
          r.revisionId,
          s.target.atomId,
          s.role,
          s.target.kind === 'pinned' ? s.target.revisionId : null,
        );
    }
    this.#db.prepare("UPDATE am_state SET value=? WHERE key='sequence'").run(String(sequence));
  }
  metaGet<T>(key: string): T | undefined {
    const row = this.#db.prepare('SELECT value FROM am_metadata WHERE key=?').get(key) as
      { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  metaSet(key: string, value: unknown): void {
    this.#db
      .prepare(
        'INSERT INTO am_metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value));
  }
  metaEntries<T>(prefix: string): [string, T][] {
    return (
      this.#db
        .prepare('SELECT key,value FROM am_metadata WHERE substr(key,1,?)=?')
        .all(prefix.length, prefix) as { key: string; value: string }[]
    ).map((r) => [r.key, JSON.parse(r.value) as T]);
  }
  metaDelete(key: string): void {
    this.#db.prepare('DELETE FROM am_metadata WHERE key=?').run(key);
  }
  isPurged(atomId: string): boolean {
    return !!this.#db.prepare('SELECT 1 FROM am_purged WHERE atom_id=?').get(atomId);
  }
  erase(atomIds: readonly string[]): void {
    for (const id of atomIds) {
      this.#db.prepare('INSERT OR IGNORE INTO am_purged VALUES (?)').run(id);
      this.#db
        .prepare(
          'DELETE FROM am_slots WHERE revision_id IN (SELECT revision_id FROM am_revisions WHERE atom_id=?)',
        )
        .run(id);
      this.#db.prepare('DELETE FROM am_revisions WHERE atom_id=?').run(id);
    }
  }
  /** Logical erasure is immediate; this also reclaims pages in this database and its WAL. External backups are host-owned. */
  compact(): void {
    this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
  }
  blobRange(blobId: string, start: number, length: number): Uint8Array | undefined {
    const offset = start % 3;
    const row = this.#db
      .prepare(
        "SELECT substr(json_extract(value,'$.bytes'),?,?) AS part FROM am_metadata WHERE key=?",
      )
      .get(
        Math.floor(start / 3) * 4 + 1,
        Math.ceil((offset + length) / 3) * 4,
        `blob:${blobId}`,
      ) as { part: string } | undefined;
    return row ? Buffer.from(row.part, 'base64').subarray(offset, offset + length) : undefined;
  }
  close(): void {
    this.#db.close();
  }
}
