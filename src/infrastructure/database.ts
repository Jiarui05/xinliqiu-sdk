/**
 * @file database.ts
 * @description 组装 SQLite 连接与事务边界，保留既有表结构和任务记录格式。
 *
 * 职责与入口：
 * - 原子提交或回滚同步业务操作，调用方无需拼接事务 SQL → Repository.transaction()
 *
 * 边界：具体读写和执行时机以各入口为准；凭据与用户数据不得进入日志或发行包。
 */
import { DatabaseSync } from "node:sqlite";
import { AuthRepository } from "../modules/auth/auth.repository.js";
import { JobRepository } from "../modules/transcription-jobs/transcription-jobs.repository.js";
import { MirrorRepository } from "../modules/transcripts/transcripts.repository.js";
import { TranscriptRepository } from "../modules/transcripts/transcripts.repository.js";
export type { StoredJob } from "../modules/transcription-jobs/transcription-jobs.repository.js";
/** 持有一个数据库连接，并注入各业务模块的 repository。 */
export class Repository {
  readonly db: DatabaseSync;
  readonly auth: AuthRepository;
  readonly jobs: JobRepository;
  readonly transcripts: TranscriptRepository;
  readonly mirrors: MirrorRepository;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tokens(hash TEXT PRIMARY KEY,owner TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,source_id TEXT NOT NULL,input TEXT NOT NULL,state TEXT NOT NULL,tasks TEXT NOT NULL DEFAULT '{}',results TEXT NOT NULL DEFAULT '{}',lease INTEGER NOT NULL DEFAULT 0,generation INTEGER NOT NULL DEFAULT 0,error TEXT,UNIQUE(owner,source_id));
      CREATE TABLE IF NOT EXISTS words(seq INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,source_id TEXT NOT NULL,recorded_at INTEGER NOT NULL,begin_at INTEGER NOT NULL,end_at INTEGER NOT NULL,chars INTEGER NOT NULL,text TEXT NOT NULL,speaker TEXT,emotion TEXT,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS words_owner_time ON words(owner,begin_at,seq);
`);
    this.mirrors = new MirrorRepository(this.db);
    this.auth = new AuthRepository(this.db);
    this.jobs = new JobRepository(this.db);
    this.transcripts = new TranscriptRepository(this.db);
  }
  /** 原子提交或回滚同步业务操作，调用方无需拼接事务 SQL。 */
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
