/** Local single-host SQLite persistence. Transactions own jobs, active transcript revisions and bounded transcript queries. */
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type { QueryFilters, TimedWord } from "./contracts.js";
import { mappedWords, validateSources, type JobInput } from "./job-input.js";
/** Hash opaque session tokens; neither provider keys nor application tokens are stored in plaintext. */
export function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
/** Persistent job envelope; provider IDs survive process restarts. */
export type StoredJob = {
  id: string;
  owner: string;
  source_id: string;
  input: string;
  state: string;
  tasks: string;
  results: string;
  lease: number;
  generation: number;
  error: string | null;
};
/** SQL access is owner-scoped. A leased job cannot be completed by a stale worker. */
export class Repository {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tokens(hash TEXT PRIMARY KEY,owner TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,source_id TEXT NOT NULL,input TEXT NOT NULL,state TEXT NOT NULL,tasks TEXT NOT NULL DEFAULT '{}',results TEXT NOT NULL DEFAULT '{}',lease INTEGER NOT NULL DEFAULT 0,generation INTEGER NOT NULL DEFAULT 0,error TEXT,UNIQUE(owner,source_id));
      CREATE TABLE IF NOT EXISTS words(seq INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,source_id TEXT NOT NULL,recorded_at INTEGER NOT NULL,begin_at INTEGER NOT NULL,end_at INTEGER NOT NULL,chars INTEGER NOT NULL,text TEXT NOT NULL,speaker TEXT,emotion TEXT,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS words_owner_time ON words(owner,begin_at,seq);
`);
  }
  /** Register a root application token (permanent unless explicitly given an expiry) supplied on stdin by the operator. */
  token(token: string, owner: string, expires = Number.MAX_SAFE_INTEGER) {
    if (token.length < 32 || token.length > 512)
      throw new Error("token must have at least 32 characters");
    this.db
      .prepare("INSERT OR REPLACE INTO tokens VALUES(?,?,?)")
      .run(digest(token), owner, expires);
  }
  /** Resolve identity only from a nonexpired stored token digest. */
  owner(token: string): string | undefined {
    return (
      this.db
        .prepare("SELECT owner FROM tokens WHERE hash=? AND expires>?")
        .get(digest(token), Date.now()) as { owner: string } | undefined
    )?.owner;
  }
  /** Revoke one token immediately. */
  revoke(token: string) {
    this.db.prepare("DELETE FROM tokens WHERE hash=?").run(digest(token));
  }
  /** Insert one immutable recording job, rejecting conflicting resubmissions. */
  enqueue(owner: string, input: JobInput) {
    if (input.sources) validateSources(input.sources);
    const existing = this.db
      .prepare("SELECT * FROM jobs WHERE owner=? AND source_id=?")
      .get(owner, input.sourceId) as StoredJob | undefined;
    if (existing) {
      const before = JSON.parse(existing.input) as JobInput;
      if (
        before.recordedAt !== input.recordedAt ||
        before.mode !== input.mode ||
        before.serviceConfigId !== input.serviceConfigId ||
        JSON.stringify(before.sources ?? []) !==
          JSON.stringify(input.sources ?? [])
      )
        throw new Error("SOURCE_CONFLICT");
      return this.publicJob(existing);
    }
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO jobs(id,owner,source_id,input,state) VALUES(?,?,?,?,'queued')",
      )
      .run(id, owner, input.sourceId, JSON.stringify(input));
    return { id, sourceId: input.sourceId, state: "queued", error: null };
  }
  /** Do not expose signed audio URLs, raw provider responses or credentials in job polling. */
  publicJob(j: StoredJob) {
    return { id: j.id, sourceId: j.source_id, state: j.state, error: j.error };
  }
  job(owner: string, id: string) {
    const j = this.db
      .prepare("SELECT * FROM jobs WHERE owner=? AND id=?")
      .get(owner, id) as StoredJob | undefined;
    return j ? this.publicJob(j) : undefined;
  }
  /** Expired submissions are uncertain, never automatically repeated and billed again. */
  claim(now = Date.now()): StoredJob | undefined {
    this.db
      .prepare(
        "UPDATE jobs SET state='submission_unknown',error='Submission interrupted; reconcile provider task before resubmitting' WHERE state='submitting' AND lease<=?",
      )
      .run(now);
    return this.db
      .prepare(
        "UPDATE jobs SET lease=?,generation=generation+1 WHERE id=(SELECT id FROM jobs WHERE state IN ('queued','running') AND lease<=? ORDER BY rowid LIMIT 1) RETURNING *",
      )
      .get(now + 120000, now) as StoredJob | undefined;
  }
  /** Compare the lease generation before changing durable state. */
  update(
    j: StoredJob,
    state: string,
    tasks: object,
    results: object,
    error: string | null = null,
    delay = 0,
  ) {
    this.db
      .prepare(
        "UPDATE jobs SET state=?,tasks=?,results=?,error=?,lease=? WHERE id=? AND generation=?",
      )
      .run(
        state,
        JSON.stringify(tasks),
        JSON.stringify(results),
        error,
        Date.now() + delay,
        j.id,
        j.generation,
      );
  }
  /** Publish normalized words and mark completion in one atomic transaction. */
  complete(j: StoredJob, words: TimedWord[]) {
    const input = JSON.parse(j.input) as JobInput;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db
        .prepare("SELECT generation,state FROM jobs WHERE id=?")
        .get(j.id) as { generation: number; state: string };
      if (current.generation !== j.generation || current.state === "completed")
        throw new Error("STALE_LEASE");
      const sources = [
        ...new Set(input.sources?.map((s) => s.sourceId) ?? [input.sourceId]),
      ];
      for (const source of sources) {
        this.db
          .prepare("DELETE FROM words WHERE owner=? AND source_id=?")
          .run(j.owner, source);
      }

      const insert = this.db.prepare(
        "INSERT INTO words(owner,source_id,recorded_at,begin_at,end_at,chars,text,speaker,emotion,data) VALUES(?,?,?,?,?,?,?,?,?,?)",
      );
      for (const { sourceId, recordedAt, word: w } of mappedWords(input, words))
        insert.run(
          j.owner,
          sourceId,
          recordedAt,
          recordedAt + w.startMs,
          recordedAt + w.endMs,
          Array.from(w.text).length,
          w.text,
          w.speaker,
          w.emotion,
          JSON.stringify(w),
        );
      this.db
        .prepare(
          "UPDATE jobs SET state='completed',results='{}',lease=0 WHERE id=? AND generation=?",
        )
        .run(j.id, j.generation);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  /** Build parameterized predicates for count and content for the same authenticated owner and filters. */
  private where(owner: string, f: QueryFilters, max: number) {
    let sql = "owner=? AND seq<=? AND end_at>=? AND begin_at<?";
    const values: (string | number)[] = [owner, max, f.from, f.to];
    for (const [column, value] of [
      ["source_id", f.sourceId],
      ["speaker", f.speaker],
      ["emotion", f.emotion],
    ] as const)
      if (value !== undefined) {
        sql += ` AND ${column}=?`;
        values.push(value);
      }
    if (f.q) {
      sql +=
        " AND source_id IN (SELECT source_id FROM (SELECT source_id,group_concat(text,'') AS body FROM (SELECT source_id,text FROM words WHERE owner=? AND seq<=? AND end_at>=? AND begin_at<? ORDER BY begin_at,seq) GROUP BY source_id) WHERE instr(body,?)>0)";
      values.push(owner, max, f.from, f.to, f.q);
    }
    return { sql, values };
  }
  /** Count matching text without issuing a temporary access credential. */
  stats(owner: string, f: QueryFilters) {
    const max = (
      this.db
        .prepare("SELECT coalesce(max(seq),0) AS n FROM words WHERE owner=?")
        .get(owner) as { n: number }
    ).n;
    const { sql, values } = this.where(owner, f, max);
    const result = this.db
      .prepare(
        `SELECT count(*) AS wordCount,coalesce(sum(chars),0) AS charCount,min(begin_at) AS "from",max(end_at) AS "to" FROM words WHERE ${sql}`,
      )
      .get(...values) as {
      wordCount: number;
      charCount: number;
      from: number | null;
      to: number | null;
    };
    return result;
  }
  /** Read current matching text using only root-token identity and bounded output budgets. */
  read(
    owner: string,
    filters: QueryFilters,
    cursor: number,
    maxChars: number,
    limit: number,
  ) {
    const { sql, values } = this.where(owner, filters, Number.MAX_SAFE_INTEGER);
    const rows = this.db
      .prepare(
        `SELECT source_id,recorded_at,data,chars FROM words WHERE ${sql} ORDER BY begin_at,seq LIMIT ? OFFSET ?`,
      )
      .all(...values, limit + 1, cursor) as {
      source_id: string;
      recorded_at: number;
      data: string;
      chars: number;
    }[];
    let charCount = 0;
    const items = [];
    for (const row of rows.slice(0, limit)) {
      if (charCount + row.chars > maxChars) break;
      charCount += row.chars;
      items.push({
        sourceId: row.source_id,
        recordedAt: row.recorded_at,
        word: JSON.parse(row.data) as TimedWord,
      });
    }
    const truncated = rows.length > items.length;
    return {
      items,
      charCount,
      nextCursor: truncated ? cursor + items.length : null,
      truncated,
    };
  }
}
