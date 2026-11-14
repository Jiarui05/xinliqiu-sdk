/**
 * @file voice-identity.types.ts
 * @description 定义按用户隔离、不可变的参考音频元数据。
 *
 * 职责与入口：
 * - 定义按用户隔离、不可变的参考音频元数据 → VoiceReference
 * - 定义私有对象存储接口 → ReferenceStorage
 *
 * 边界：仅声明领域数据，不依赖 HTTP 上下文，不执行读写操作。
 */
export interface VoiceReference {
  id: string;
  durationSeconds: number;
  key: string;
}
/** 定义私有对象存储接口；签名地址不进入公开设置响应。 */
export interface ReferenceStorage {
  put(key: string, audio: Buffer): Promise<void>;
  url(key: string): string;
}
