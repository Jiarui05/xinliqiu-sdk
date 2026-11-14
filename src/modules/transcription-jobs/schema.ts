/** HTTP job submission and public progress contracts. */
import { z } from "@hono/zod-openapi";
export const Recording = z.object({
  sourceId: z.string().regex(/^[a-f0-9]{64}$/),
  recordedAt: z.number().int().nonnegative(),
  audioUrl: z.string().url(),
  audioFormat: z.enum(["wav", "mp3", "ogg", "raw"]).optional(),
  serviceConfigId: z.string().uuid().optional(),
  mode: z.enum(["rich", "speakers", "emotion"]).default("rich"),
});
export const Batch = z.object({
  recordings: z.array(Recording).min(1).max(50),
});
export const Job = z.object({
  id: z.string(),
  sourceId: z.string(),
  state: z.string(),
  error: z.string().nullable(),
});
