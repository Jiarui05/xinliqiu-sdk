/** Replicate completed local text to an authenticated cloud owner without transferring audio or ASR jobs. */
import { z } from "@hono/zod-openapi";
import { createHash } from "node:crypto";
import { Word } from "./contracts.js";
import type { Repository } from "./repository.js";

export const MirrorBatch = z.object({
  transcripts: z
    .array(
      z.object({
        sourceId: z.string().regex(/^[a-f0-9]{64}$/),
        recordedAt: z.number().int().nonnegative().max(8640000000000000),
        words: z.array(Word).max(10000),
      }),
    )
    .min(1)
    .max(25),
});

/** Atomically replace changed source revisions; repeated uploads are no-ops and never enqueue paid work. */
export function mirrorTranscripts(
  repo: Repository,
  owner: string,
  input: z.infer<typeof MirrorBatch>,
) {
  repo.db.exec(`CREATE TABLE IF NOT EXISTS transcript_mirrors(
    owner TEXT NOT NULL, source_id TEXT NOT NULL, revision TEXT NOT NULL,
    PRIMARY KEY(owner, source_id))`);
  let changed = 0;
  repo.db.exec("BEGIN IMMEDIATE");
  try {
    for (const source of input.transcripts) {
      const revision = createHash("sha256")
        .update(JSON.stringify(source))
        .digest("hex");
      const prior = repo.db
        .prepare(
          "SELECT revision FROM transcript_mirrors WHERE owner=? AND source_id=?",
        )
        .get(owner, source.sourceId) as { revision: string } | undefined;
      if (prior?.revision === revision) continue;
      repo.db
        .prepare("DELETE FROM words WHERE owner=? AND source_id=?")
        .run(owner, source.sourceId);
      const insert = repo.db.prepare(
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
      repo.db
        .prepare("INSERT OR REPLACE INTO transcript_mirrors VALUES(?,?,?)")
        .run(owner, source.sourceId, revision);
      changed++;
    }
    repo.db.exec("COMMIT");
    return { changed, received: input.transcripts.length };
  } catch (e) {
    repo.db.exec("ROLLBACK");
    throw e;
  }
}
