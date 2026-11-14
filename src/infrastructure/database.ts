/** SQLite composition and transaction boundary; existing tables and durable task envelopes remain unchanged. */
import { DatabaseSync } from "node:sqlite";
import { AuthRepository } from "../modules/auth/repository.js";
import { JobRepository } from "../modules/transcription-jobs/repository.js";
import { TranscriptRepository } from "../modules/transcripts/repository.js";
export type { StoredJob } from "../modules/transcription-jobs/repository.js";
/** Own a single database connection and inject it into business-specific repositories. */
export class Repository {
  readonly db: DatabaseSync;
  readonly auth: AuthRepository;
  readonly jobs: JobRepository;
  readonly transcripts: TranscriptRepository;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tokens(hash TEXT PRIMARY KEY,owner TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,source_id TEXT NOT NULL,input TEXT NOT NULL,state TEXT NOT NULL,tasks TEXT NOT NULL DEFAULT '{}',results TEXT NOT NULL DEFAULT '{}',lease INTEGER NOT NULL DEFAULT 0,generation INTEGER NOT NULL DEFAULT 0,error TEXT,UNIQUE(owner,source_id));
      CREATE TABLE IF NOT EXISTS words(seq INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,source_id TEXT NOT NULL,recorded_at INTEGER NOT NULL,begin_at INTEGER NOT NULL,end_at INTEGER NOT NULL,chars INTEGER NOT NULL,text TEXT NOT NULL,speaker TEXT,emotion TEXT,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS words_owner_time ON words(owner,begin_at,seq);
`);
    this.auth = new AuthRepository(this.db);
    this.jobs = new JobRepository(this.db);
    this.transcripts = new TranscriptRepository(this.db);
  }
  /** Commit or roll back one synchronous business operation without exposing SQL transaction commands. */
  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
