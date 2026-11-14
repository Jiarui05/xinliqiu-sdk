/**
 * @file transcripts.schema.ts
 * @description 定义转录查询的输入校验和响应契约，不执行数据读取。
 *
 * 职责与入口：
 * - 输入输出结构 → 本文件导出的 Zod schema
 *
 * 边界：仅定义输入和输出校验，不发起网络请求或修改存储。
 */
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

/** 校验完成文字的批量镜像输入。 */
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
