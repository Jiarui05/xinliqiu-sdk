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
