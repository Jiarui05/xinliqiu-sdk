/**
 * @file provider-settings.schema.ts
 * @description 定义供应商设置的输入校验规则。
 *
 * 职责与入口：
 * - 输入输出结构 → 本文件导出的 Zod schema
 *
 * 边界：仅定义输入和输出校验，不发起网络请求或修改存储。
 */
import { z } from "zod";
export const ProviderId = z.enum(["qwen", "tencent", "doubao"]);
export const ServiceInput = z.object({
  provider: ProviderId,
  model: z.string().trim().min(1).max(120),
  credentials: z.record(z.string(), z.string().max(4096)),
  voiceIdentity: z
    .object({ enabled: z.boolean(), referenceId: z.string().uuid().optional() })
    .optional(),
});

/** 定义脱敏配置及设置表单字段的公开契约。 */
export const configView = z.object({
  id: z.string(),
  provider: z.enum(["qwen", "tencent", "doubao"]),
  model: z.string(),
  credentials: z.record(z.string(), z.string()),
  secrets: z.array(z.string()),
  voiceIdentity: z.object({
    enabled: z.boolean(),
    referenceId: z.string().optional(),
    durationSeconds: z.number().optional(),
  }),
});
export const field = z.object({
  key: z.string(),
  label: z.string(),
  secret: z.boolean(),
  required: z.boolean(),
  defaultValue: z.string(),
});
