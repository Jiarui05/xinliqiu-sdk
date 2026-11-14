/**
 * @file provider-settings.types.ts
 * @description 定义独立于 HTTP 校验实现的供应商配置领域类型。
 *
 * 职责与入口：
 * - 描述持久化的供应商配置版本及关联声纹，供任务固定引用 → ServiceConfig
 *
 * 边界：仅声明领域数据，不依赖 HTTP 上下文，不执行读写操作。
 */
import type { VoiceReference } from "../voice-identity/voice-identity.types.js";
/** 描述持久化的供应商配置版本及关联声纹，供任务固定引用。 */
export interface ServiceConfig {
  id: string;
  provider: "qwen" | "tencent" | "doubao";
  model: string;
  credentials: Record<string, string>;
  voiceIdentity?: { enabled: boolean; referenceId?: string };
  voiceReference?: VoiceReference;
  voiceprintId?: string;
}
