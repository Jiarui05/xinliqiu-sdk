/** Persisted provider settings, independent of HTTP schema implementation. */
import type { VoiceReference } from "../voice-identity/domain.js";
export interface ServiceConfig {
  id: string;
  provider: "qwen" | "tencent" | "doubao";
  model: string;
  credentials: Record<string, string>;
  voiceIdentity?: { enabled: boolean; referenceId?: string };
  voiceReference?: VoiceReference;
  voiceprintId?: string;
}
