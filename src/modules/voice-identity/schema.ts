/** HTTP reference-audio input and redacted output. */
import { z } from "zod";
export const VoiceReferenceInput = z.object({
  audioBase64: z.string().min(1).max(1_500_000),
});
export const VoiceReferenceView = z.object({
  id: z.string().uuid(),
  durationSeconds: z.number(),
});
