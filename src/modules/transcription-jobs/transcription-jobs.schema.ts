/**
 * @file transcription-jobs.schema.ts
 * @description 定义转录任务的 HTTP 提交契约和公开进度结构。
 *
 * 职责与入口：
 * - 输入输出结构 → 本文件导出的 Zod schema
 *
 * 边界：仅定义输入和输出校验，不发起网络请求或修改存储。
 */
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
