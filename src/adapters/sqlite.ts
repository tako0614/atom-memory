import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { AtomRevision, Ref } from '../contracts.js';
import type {
  ScanQuery,
  StorageAdapter,
  StoredRevision,
  ChangePosition,
  VectorQuery,
} from './storage.js';
import { uid } from '../core/util.js';
import { vectorBuckets } from '../core/vector-buckets.js';
function prefixEnd(prefix: string): string | undefined {
  const points = [...prefix];
  while (points.length) {
    const last = points.pop()!.codePointAt(0)!;
    if (last < 0x10ffff)
      return points.join('') + String.fromCodePoint(last === 0xd7ff ? 0xe000 : last + 1);
  }
  return undefined;
}
/** Local durable adapter. SQLite coordinates concurrent processes through short write transactions. */
export class SqliteStorage implements StorageAdapter {
  retainSnapshot(at: number, until: number): string {
    const token = uid('retained');
    // All immutable rows survive reopen; explicit erase remains authoritative.
    this.metaSet(`retained:${token}`, {
      at,
      until,
      generation: this.metaGet<number>('retention-generation') ?? 0,
    });
    return token;
  }
  retainedSnapshot(token: string): { at: number; until: number } | undefined {
    const value = this.metaGet<{ at: number; until: number; generation: number }>(
      `retained:${token}`,
    );
    return value &&
      value.until > Date.now() &&
      value.generation === (this.metaGet<number>('retention-generation') ?? 0)
      ? value
      : undefined;
  }
  readonly capabilities = { snapshot: true, atomicBatch: true, queryGuards: true };
  readonly id: string;
  #db: DatabaseSync;
  #synchronous: 'FULL' | 'NORMAL';
  constructor(path: string, options: { synchronous?: 'FULL' | 'NORMAL' } = {}) {
    this.#synchronous = options.synchronous ?? 'FULL';
    if (!['FULL', 'NORMAL'].includes(this.#synchronous))
      throw new TypeError('Invalid SQLite synchronous mode');
    this.#db = new DatabaseSync(path);
    this.#db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=${this.#synchronous}; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS am_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO am_state VALUES ('sequence','0');
      CREATE TABLE IF NOT EXISTS am_revisions (
        atom_id TEXT NOT NULL, revision_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL,
        policy TEXT NOT NULL, schema_name TEXT NOT NULL, state TEXT NOT NULL, body_text TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS am_history ON am_revisions(atom_id, sequence DESC);
      CREATE INDEX IF NOT EXISTS am_scope ON am_revisions(policy, schema_name, atom_id);
      CREATE INDEX IF NOT EXISTS am_scope_order ON am_revisions(policy, atom_id);
      CREATE INDEX IF NOT EXISTS am_changes ON am_revisions(policy,sequence,revision_id);
      CREATE TABLE IF NOT EXISTS am_slots (revision_id TEXT NOT NULL, target_id TEXT NOT NULL, role TEXT NOT NULL, target_revision TEXT);
      CREATE INDEX IF NOT EXISTS am_relations ON am_slots(target_id, role, revision_id);
      CREATE INDEX IF NOT EXISTS am_slot_revision ON am_slots(revision_id);
      CREATE TABLE IF NOT EXISTS am_purge_edges (owner_id TEXT NOT NULL,target_id TEXT NOT NULL,PRIMARY KEY(owner_id,target_id));
      CREATE INDEX IF NOT EXISTS am_purge_target ON am_purge_edges(target_id,owner_id);
      CREATE TABLE IF NOT EXISTS am_receipt_inputs (receipt_id TEXT NOT NULL,target_id TEXT NOT NULL,PRIMARY KEY(receipt_id,target_id));
      CREATE INDEX IF NOT EXISTS am_receipt_target ON am_receipt_inputs(target_id,receipt_id);
      CREATE TABLE IF NOT EXISTS am_receipt_owners (receipt_id TEXT NOT NULL,owner_id TEXT NOT NULL,PRIMARY KEY(receipt_id,owner_id));
      CREATE INDEX IF NOT EXISTS am_receipt_owner ON am_receipt_owners(owner_id,receipt_id);
      CREATE TABLE IF NOT EXISTS am_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS am_vector_buckets (config TEXT NOT NULL,policy TEXT NOT NULL,band INTEGER NOT NULL,bucket INTEGER NOT NULL,revision_id TEXT NOT NULL,PRIMARY KEY(config,policy,band,bucket,revision_id));
      CREATE INDEX IF NOT EXISTS am_vector_revision ON am_vector_buckets(revision_id);
      CREATE TRIGGER IF NOT EXISTS am_vector_revision_delete AFTER DELETE ON am_revisions BEGIN
        DELETE FROM am_vector_buckets WHERE revision_id=old.revision_id;
      END;
      CREATE TRIGGER IF NOT EXISTS am_vector_metadata_delete AFTER DELETE ON am_metadata WHEN substr(old.key,1,10)='sdk:index:' BEGIN
        DELETE FROM am_vector_buckets WHERE revision_id=substr(old.key,11);
      END;
      CREATE TABLE IF NOT EXISTS am_purged (atom_id TEXT PRIMARY KEY);
      CREATE TRIGGER IF NOT EXISTS am_purge_revision_insert AFTER INSERT ON am_revisions BEGIN
        INSERT INTO am_purge_edges SELECT new.atom_id,json_extract(value,'$.target.atomId') FROM json_each(new.data,'$.slots') WHERE true ON CONFLICT DO NOTHING;
        INSERT INTO am_purge_edges SELECT new.atom_id,json_extract(value,'$.source.atomId') FROM json_each(new.data,'$.origins') WHERE true ON CONFLICT DO NOTHING;
        INSERT INTO am_receipt_owners SELECT json_extract(new.data,'$.provenance.inputReceiptId'),new.atom_id WHERE json_extract(new.data,'$.provenance.inputReceiptId') IS NOT NULL ON CONFLICT DO NOTHING;
      END;
      CREATE TRIGGER IF NOT EXISTS am_purge_revision_delete AFTER DELETE ON am_revisions WHEN NOT EXISTS(SELECT 1 FROM am_revisions WHERE atom_id=old.atom_id) BEGIN
        DELETE FROM am_purge_edges WHERE owner_id=old.atom_id OR target_id=old.atom_id;
        DELETE FROM am_receipt_owners WHERE owner_id=old.atom_id;
      END;
      CREATE TRIGGER IF NOT EXISTS am_purge_receipt_insert AFTER INSERT ON am_metadata WHEN substr(new.key,1,8)='receipt:' BEGIN
        INSERT INTO am_receipt_inputs SELECT substr(new.key,9),json_extract(value,'$.atomId') FROM json_each(new.value,'$.reads') WHERE true ON CONFLICT DO NOTHING;
      END;
      CREATE TRIGGER IF NOT EXISTS am_purge_receipt_update AFTER UPDATE OF value ON am_metadata WHEN substr(new.key,1,8)='receipt:' BEGIN
        DELETE FROM am_receipt_inputs WHERE receipt_id=substr(new.key,9);
        INSERT INTO am_receipt_inputs SELECT substr(new.key,9),json_extract(value,'$.atomId') FROM json_each(new.value,'$.reads') WHERE true ON CONFLICT DO NOTHING;
      END;
      CREATE TRIGGER IF NOT EXISTS am_purge_receipt_delete AFTER DELETE ON am_metadata WHEN substr(old.key,1,8)='receipt:' BEGIN
        DELETE FROM am_receipt_inputs WHERE receipt_id=substr(old.key,9);
      END;
    `);
    this.#db.prepare("INSERT OR IGNORE INTO am_state VALUES ('id',?)").run(uid('sqlite'));
    this.id = (
      this.#db.prepare("SELECT value FROM am_state WHERE key='id'").get() as { value: string }
    ).value;
    if (!this.#db.prepare("SELECT 1 FROM am_state WHERE key='purge-index-v1'").get()) {
      this.transaction(() => {
        this.#db.exec(`
          INSERT OR IGNORE INTO am_purge_edges SELECT r.atom_id,json_extract(s.value,'$.target.atomId') FROM am_revisions r,json_each(r.data,'$.slots') s;
          INSERT OR IGNORE INTO am_purge_edges SELECT r.atom_id,json_extract(o.value,'$.source.atomId') FROM am_revisions r,json_each(r.data,'$.origins') o;
          INSERT OR IGNORE INTO am_receipt_owners SELECT json_extract(data,'$.provenance.inputReceiptId'),atom_id FROM am_revisions WHERE json_extract(data,'$.provenance.inputReceiptId') IS NOT NULL;
          INSERT OR IGNORE INTO am_receipt_inputs SELECT substr(m.key,9),json_extract(r.value,'$.atomId') FROM am_metadata m,json_each(m.value,'$.reads') r WHERE m.key>='receipt:' AND m.key<'receipt;';
          INSERT INTO am_state VALUES('purge-index-v1','1');
        `);
      });
    }
  }
  /**
   * NORMAL is for replayable imports. Its commits remain atomic, but callers
   * must flush before acknowledging an external source or durable checkpoint.
   * A real FULL commit syncs all preceding WAL writes before returning.
   */
  flush(): void {
    if (this.#synchronous === 'FULL') return;
    this.#db.exec('PRAGMA synchronous=FULL');
    try {
      this.transaction(() => this.metaSet('sqlite:durability-barrier', uid('flush')));
    } finally {
      this.#db.exec('PRAGMA synchronous=NORMAL');
    }
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
  changes(
    policies: readonly string[],
    after: ChangePosition,
    limit: number,
    at: number,
  ): StoredRevision[] {
    if (!policies.length) return [];
    return (
      this.#db
        .prepare(
          `SELECT data,sequence FROM am_revisions
      WHERE policy IN (${policies.map(() => '?').join(',')}) AND sequence<=?
      AND (sequence,revision_id)>(?,?) ORDER BY sequence,revision_id LIMIT ?`,
        )
        .all(...policies, at, after.sequence, after.revisionId, limit) as {
        data: string;
        sequence: number;
      }[]
    ).map((row) => ({ revision: JSON.parse(row.data), sequence: row.sequence }));
  }
  vectorCandidates(query: VectorQuery, at: number): AtomRevision[] {
    if (!query.policies.length || !query.vectors.length || query.limit < 1) return [];
    const probes = new Set<string>();
    for (const vector of query.vectors)
      for (const [band, bucket] of vectorBuckets(vector).entries()) {
        probes.add(`${band}:${bucket}`);
        for (let bit = 0; bit < 12; bit++) probes.add(`${band}:${bucket ^ (1 << bit)}`);
      }
    const values = [...probes].flatMap((value) => value.split(':').map(Number));
    // Only bucket hits load Atom bodies. Scope and current head checks happen
    // before LIMIT, so old revisions and private neighbors cannot crowd it out.
    return (
      this.#db
        .prepare(
          `WITH probes(band,bucket) AS (VALUES ${[...probes].map(() => '(?,?)').join(',')})
      SELECT r.data FROM probes p JOIN am_vector_buckets b ON b.band=p.band AND b.bucket=p.bucket
      JOIN am_revisions r ON r.revision_id=b.revision_id
      WHERE b.config=? AND b.policy IN (${query.policies.map(() => '?').join(',')})
      AND r.sequence<=? AND r.state='active' AND NOT EXISTS(SELECT 1 FROM am_purged x WHERE x.atom_id=r.atom_id)
      AND r.sequence=(SELECT MAX(h.sequence) FROM am_revisions h WHERE h.atom_id=r.atom_id AND h.sequence<=?)
      GROUP BY r.revision_id ORDER BY count(*) DESC,r.atom_id LIMIT ?`,
        )
        .all(...values, query.config, ...query.policies, at, at, query.limit) as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  metaGet<T>(key: string): T | undefined {
    const row = this.#db.prepare('SELECT value FROM am_metadata WHERE key=?').get(key) as
      { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  indexEntries(
    policies: readonly string[],
    configs: readonly string[],
    after: string | undefined,
    limit: number,
  ): [string, { config: string; hash: string; policyId: string; vectors: number[][] }][] {
    if (!policies.length || !configs.length) return [];
    const rows = this.#db
      .prepare(
        `SELECT m.key,m.value FROM am_vector_buckets b
      JOIN am_metadata m ON m.key='sdk:index:'||b.revision_id
      WHERE b.config IN (${configs.map(() => '?').join(',')}) AND b.policy IN (${policies.map(() => '?').join(',')})
      AND b.band=0 AND m.key>? GROUP BY m.key ORDER BY m.key LIMIT ?`,
      )
      .all(...configs, ...policies, after ?? '', limit) as { key: string; value: string }[];
    return rows.map((row) => [row.key, JSON.parse(row.value)]);
  }
  metaSet(key: string, value: unknown): void {
    this.#db
      .prepare(
        'INSERT INTO am_metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value));
    if (key.startsWith('sdk:index:')) {
      const index = value as { config: string; policyId?: string; vectors?: number[][] };
      const revisionId = key.slice(10);
      this.#db.prepare('DELETE FROM am_vector_buckets WHERE revision_id=?').run(revisionId);
      if (index.policyId && index.vectors) {
        const insert = this.#db.prepare(
          'INSERT OR IGNORE INTO am_vector_buckets VALUES (?,?,?,?,?)',
        );
        for (const vector of index.vectors)
          for (const [band, bucket] of vectorBuckets(vector).entries())
            insert.run(index.config, index.policyId, band, bucket, revisionId);
      }
    }
  }
  metaEntries<T>(prefix: string): [string, T][] {
    // A prefix is a binary key range. substr(key, ...) forces every source/index
    // metadata row through a table scan during ordinary cache maintenance.
    const upper = prefixEnd(prefix);
    return (
      this.#db
        .prepare(
          `SELECT key,value FROM am_metadata WHERE key>=?${upper === undefined ? '' : ' AND key<?'} ORDER BY key`,
        )
        .all(...(upper === undefined ? [prefix] : [prefix, upper])) as {
        key: string;
        value: string;
      }[]
    ).map((r) => [r.key, JSON.parse(r.value) as T]);
  }
  metaDelete(key: string): void {
    this.#db.prepare('DELETE FROM am_metadata WHERE key=?').run(key);
  }
  metaUnbackedEntries<T>(prefix: string, backingPrefix: string): [string, T][] {
    const upper = prefixEnd(prefix);
    // The inner scan uses only metadata keys. Large durable trace bodies never
    // enter JS or the outer table lookup during transient retention maintenance.
    const args: SQLInputValue[] = upper === undefined ? [prefix] : [prefix, upper];
    args.push(backingPrefix, [...prefix].length + 1);
    return (
      this.#db
        .prepare(
          `SELECT key,value FROM am_metadata WHERE key IN (
      SELECT t.key FROM am_metadata t WHERE t.key>=?${upper === undefined ? '' : ' AND t.key<?'}
      AND NOT EXISTS(SELECT 1 FROM am_metadata p WHERE p.key=? || substr(t.key,?))
    ) ORDER BY key`,
        )
        .all(...args) as { key: string; value: string }[]
    ).map((r) => [r.key, JSON.parse(r.value) as T]);
  }
  metaDeletePrefix(prefix: string): void {
    const upper = prefixEnd(prefix);
    this.#db
      .prepare(`DELETE FROM am_metadata WHERE key>=?${upper === undefined ? '' : ' AND key<?'}`)
      .run(...(upper === undefined ? [prefix] : [prefix, upper]));
  }
  purgePlan(atomId: string): { revisions: AtomRevision[]; receiptKeys: string[] } {
    const closure = `WITH RECURSIVE affected(atom_id) AS (
      SELECT ? UNION SELECT e.owner_id FROM am_purge_edges e JOIN affected a ON e.target_id=a.atom_id
      UNION SELECT o.owner_id FROM am_receipt_inputs i JOIN affected a ON i.target_id=a.atom_id
        JOIN am_receipt_owners o ON o.receipt_id=i.receipt_id
    ) `;
    const revisions = (
      this.#db
        .prepare(
          closure + 'SELECT data FROM am_revisions WHERE atom_id IN (SELECT atom_id FROM affected)',
        )
        .all(atomId) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as AtomRevision);
    const receipts = this.#db
      .prepare(
        closure +
          'SELECT DISTINCT i.receipt_id FROM am_receipt_inputs i JOIN affected a ON i.target_id=a.atom_id',
      )
      .all(atomId) as { receipt_id: string }[];
    return { revisions, receiptKeys: receipts.map((r) => `receipt:${r.receipt_id}`) };
  }
  isPurged(atomId: string): boolean {
    return !!this.#db.prepare('SELECT 1 FROM am_purged WHERE atom_id=?').get(atomId);
  }
  erase(atomIds: readonly string[]): void {
    if (atomIds.length)
      this.metaSet('retention-generation', (this.metaGet<number>('retention-generation') ?? 0) + 1);
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
