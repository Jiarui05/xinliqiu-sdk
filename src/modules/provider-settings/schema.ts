/** Validate provider settings at the application boundary. */
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

/** Redacted provider configuration and input-field presentation contracts. */
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
