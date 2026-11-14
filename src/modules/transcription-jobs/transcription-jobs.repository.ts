/**
 * @file transcription-jobs.repository.ts
 * @description 持久化任务状态，并原子发布完成后的转录文字。
 *
 * 职责与入口：
 * - 定义数据库中的任务记录 → StoredJob
 * - 创建不可变的来源任务 → JobRepository.enqueue()
 * - 公开任务进度不包含签名音频地址、供应商原始响应或凭据 → JobRepository.publicJob()
 * - 读取所属用户的任务状态，不暴露音频地址或供应商原文 → JobRepository.job()
 * - 提交阶段租约到期表示结果未知，不自动重提，避免重复计费 → JobRepository.claim()
 * - 更新任务前核对租约代次，防止过期执行者覆盖新状态 → JobRepository.update()
 * - 在同一事务中发布规范化词项并标记任务完成 → JobRepository.complete()
 *
 * 边界：仅负责所属业务的持久化；用户身份由调用方传入，不调用外部模型。
 */
import { DomainError } from "../../shared/errors.js";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { TimedWord } from "../transcripts/transcripts.types.js";
import {
  mappedWords,
  validateSources,
  type JobInput,
} from "./transcription-jobs.types.js";
/** 定义数据库中的任务记录；供应商任务 ID 必须能跨进程重启恢复。 */
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
/** 在同一 SQLite 连接中维护任务租约和已完成文字。 */
export class JobRepository {
  constructor(private db: DatabaseSync) {}
  /** 创建不可变的来源任务；重复提交复用任务，元数据冲突则拒绝。 */
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
  /** 公开任务进度不包含签名音频地址、供应商原始响应或凭据。 */
  publicJob(j: StoredJob) {
    return { id: j.id, sourceId: j.source_id, state: j.state, error: j.error };
  }
  /** 读取所属用户的任务状态，不暴露音频地址或供应商原文。 */
  job(owner: string, id: string) {
    const j = this.db
      .prepare("SELECT * FROM jobs WHERE owner=? AND id=?")
      .get(owner, id) as StoredJob | undefined;
    return j ? this.publicJob(j) : undefined;
  }
  /** 提交阶段租约到期表示结果未知，不自动重提，避免重复计费。 */
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
  /** 更新任务前核对租约代次，防止过期执行者覆盖新状态。 */
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
  /** 在同一事务中发布规范化词项并标记任务完成。 */
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
