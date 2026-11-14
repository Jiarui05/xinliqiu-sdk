/** Durable job persistence and atomic publication of completed transcripts. */
import { DomainError } from "../../shared/errors.js";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { TimedWord } from "../transcripts/domain.js";
import { mappedWords, validateSources, type JobInput } from "./domain.js";
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
/** Leases and completed file revisions are persisted in one SQLite connection. */
export class JobRepository {
  constructor(private db: DatabaseSync) {}
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
        throw new DomainError(
          "SOURCE_CONFLICT",
          "Source metadata conflicts with an existing task",
        );
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
        throw new DomainError("STALE_LEASE", "Task lease is no longer current");
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
}
