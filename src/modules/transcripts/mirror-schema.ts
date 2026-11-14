/** Validate completed transcript replication requests. */
import { z } from "@hono/zod-openapi";
import { Word } from "./schema.js";
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
