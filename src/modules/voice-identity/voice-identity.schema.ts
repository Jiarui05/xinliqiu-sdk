/**
 * @file voice-identity.schema.ts
 * @description 定义参考音频上传契约和脱敏返回结构。
 *
 * 职责与入口：
 * - 输入输出结构 → 本文件导出的 Zod schema
 *
 * 边界：仅定义输入和输出校验，不发起网络请求或修改存储。
 */
import { z } from "zod";
export const VoiceReferenceInput = z.object({
  audioBase64: z.string().min(1).max(1_500_000),
});
export const VoiceReferenceView = z.object({
  id: z.string().uuid(),
  durationSeconds: z.number(),
});
