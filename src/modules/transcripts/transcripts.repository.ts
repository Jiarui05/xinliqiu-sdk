/**
 * @file transcripts.repository.ts
 * @description 封装按用户隔离的转录 SQL 和有界正文读取。
 *
 * 职责与入口：
 * - 统计匹配文本的数量与时间范围，不签发临时查询凭据 → TranscriptRepository.stats()
 * - 根据已认证身份和筛选条件读取当前正文，并限制词项数和字符数 → TranscriptRepository.read()
 * - 只替换内容有变化的来源 → MirrorRepository.replace()
 *
 * 边界：仅负责所属业务的持久化；用户身份由调用方传入，不调用外部模型。
 */
import type { DatabaseSync } from "node:sqlite";
import type {
  QueryFilters,
  TimedWord,
  MirroredTranscript,
} from "./transcripts.types.js";
/** 读取当前持久化正文，不依赖 HTTP 或供应商接口。 */
export class TranscriptRepository {
  constructor(private db: DatabaseSync) {}
  /** 使用同一身份与筛选条件生成参数化查询，避免拼接外部输入。 */
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
  /** 统计匹配文本的数量与时间范围，不签发临时查询凭据。 */
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
  /** 根据已认证身份和筛选条件读取当前正文，并限制词项数和字符数。 */
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

/** 在同一事务中替换发生变化的来源文字，失败时回滚旧数据。 */
export class MirrorRepository {
  constructor(private db: DatabaseSync) {}
  /** 只替换内容有变化的来源；任何写入失败都回滚并保留旧文字。 */
  replace(
    owner: string,
    sources: (MirroredTranscript & { revision: string })[],
  ) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS transcript_mirrors(
    owner TEXT NOT NULL, source_id TEXT NOT NULL, revision TEXT NOT NULL,
    PRIMARY KEY(owner, source_id))`);
    let changed = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const source of sources) {
        const revision = source.revision;
        const prior = this.db
          .prepare(
            "SELECT revision FROM transcript_mirrors WHERE owner=? AND source_id=?",
          )
          .get(owner, source.sourceId) as { revision: string } | undefined;
        if (prior?.revision === revision) continue;
        this.db
          .prepare("DELETE FROM words WHERE owner=? AND source_id=?")
          .run(owner, source.sourceId);
        const insert = this.db.prepare(
          "INSERT INTO words(owner,source_id,recorded_at,begin_at,end_at,chars,text,speaker,emotion,data) VALUES(?,?,?,?,?,?,?,?,?,?)",
        );
        for (const w of source.words)
          insert.run(
            owner,
            source.sourceId,
            source.recordedAt,
            source.recordedAt + w.startMs,
            source.recordedAt + w.endMs,
            Array.from(w.text).length,
            w.text,
            w.speaker,
            w.emotion,
            JSON.stringify(w),
          );
        this.db
          .prepare("INSERT OR REPLACE INTO transcript_mirrors VALUES(?,?,?)")
          .run(owner, source.sourceId, revision);
        changed++;
      }
      this.db.exec("COMMIT");
      return { changed, received: sources.length };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
