/** HTTP validation and response schemas for transcript queries. */
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
