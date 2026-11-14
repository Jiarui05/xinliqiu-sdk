/** Owner-scoped transcript SQL and bounded text reads. */
import type { DatabaseSync } from "node:sqlite";
import type { QueryFilters, TimedWord } from "./domain.js";
/** Query the current persisted text; no transport or provider dependencies. */
export class TranscriptRepository {
  constructor(private db: DatabaseSync) {}
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
