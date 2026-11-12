/** Public transcript contract. Times are epoch/relative milliseconds; model labels are observations, not identity. */
import { z } from "@hono/zod-openapi";
export const Emotion = z.enum([
  "surprised",
  "neutral",
  "happy",
  "sad",
  "disgusted",
  "angry",
  "fearful",
]);
export const Filters = z
  .object({
    from: z.coerce.number().int().nonnegative().default(0),
    to: z.coerce.number().int().positive().default(8640000000000000),
    sourceId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    speaker: z.string().max(80).optional(),
    emotion: Emotion.optional(),
    q: z.string().max(100).optional(),
  })
  .refine((v) => v.to > v.from, "to must be after from");
export const Word = z
  .object({
    text: z.string().min(1).max(256),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(),
    speaker: z.string().nullable(),
    emotion: Emotion.nullable(),
    timing: z.enum(["character", "word", "sentence"]),
    speakerSource: z.enum(["provider", "overlap", "unknown", "voiceprint"]),
  })
  .refine((v) => v.endMs >= v.startMs, "invalid time interval");
export const Row = z.object({
  sourceId: z.string(),
  recordedAt: z.number(),
  word: Word,
});
export const Stats = z.object({
  wordCount: z.number(),
  charCount: z.number(),
  from: z.number().nullable(),
  to: z.number().nullable(),
});
export const Read = z.object({
  ...Filters.shape,
  cursor: z.coerce.number().int().nonnegative().default(0),
  maxChars: z.coerce.number().int().min(256).max(8000).default(2000),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export const Page = z.object({
  items: z.array(Row),
  charCount: z.number(),
  nextCursor: z.number().nullable(),
  truncated: z.boolean(),
});
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
export const ErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
  }),
});
/** Parsed filters are shared by HTTP and CLI; owner always comes from authentication. */
export type QueryFilters = z.infer<typeof Filters>;
/** Timing precision is preserved rather than manufacturing per-character alignment. */
export type TimedWord = z.infer<typeof Word>;
/** Durable job input, only accepted after an explicit batch submission. */
export type RecordingInput = z.infer<typeof Recording>;
