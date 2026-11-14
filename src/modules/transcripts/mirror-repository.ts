/** Idempotent, transactional persistence of completed source text. */
import type { DatabaseSync } from "node:sqlite";
import type { MirroredTranscript } from "./domain.js";
export class MirrorRepository {
  constructor(private db: DatabaseSync) {}
  /** Apply only changed revisions, retaining previous text if any write fails. */
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
