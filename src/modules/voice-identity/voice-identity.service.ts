/**
 * @file voice-identity.service.ts
 * @description 校验和保存参考音频；公开设置只展示元数据，不暴露对象地址。
 *
 * 职责与入口：
 * - 检查实际 RIFF 数据块、PCM 格式和时长，只接受符合要求的单声道录音 → validateReference()
 * - 验证参考音频并保存私有对象及元数据，返回可公开的标识和时长 → VoiceReferences.save()
 * - 读取属于指定用户的参考音频元数据 → VoiceReferences.get()
 * - 生成短期私有下载地址，调用方不得记录或公开该地址 → VoiceReferences.url()
 *
 * 边界：负责业务流程与约束；数据访问和外部通信使用已有 repository 或 adapter。
 */
import { createHash } from "node:crypto";
import { VoiceRepository } from "./voice-identity.repository.js";
import type {
  VoiceReference,
  ReferenceStorage,
} from "./voice-identity.types.js";
export type {
  VoiceReference,
  ReferenceStorage,
} from "./voice-identity.types.js";
export { cosReferenceStorage } from "../../infrastructure/storage/cos.js";
/** 检查实际 RIFF 数据块、PCM 格式和时长，只接受符合要求的单声道录音。 */
export function validateReference(audio: Buffer): number {
  if (
    audio.length > 1_100_000 ||
    audio.length < 44 ||
    audio.toString("ascii", 0, 4) !== "RIFF" ||
    audio.toString("ascii", 8, 12) !== "WAVE" ||
    audio.readUInt32LE(4) + 8 !== audio.length
  )
    throw new Error("INVALID_VOICE_WAV");
  let fmt = false,
    bytes = 0,
    dataSeen = false,
    offset = 12;
  while (offset + 8 <= audio.length) {
    const tag = audio.toString("ascii", offset, offset + 4),
      n = audio.readUInt32LE(offset + 4);
    offset += 8;
    if (offset + n > audio.length) throw new Error("INVALID_VOICE_WAV");
    if (tag === "fmt ") {
      if (
        fmt ||
        n < 16 ||
        audio.readUInt16LE(offset) !== 1 ||
        audio.readUInt16LE(offset + 2) !== 1 ||
        audio.readUInt32LE(offset + 4) !== 16000 ||
        audio.readUInt32LE(offset + 8) !== 32000 ||
        audio.readUInt16LE(offset + 12) !== 2 ||
        audio.readUInt16LE(offset + 14) !== 16
      )
        throw new Error("INVALID_VOICE_FORMAT");
      fmt = true;
    }
    if (tag === "data") {
      if (dataSeen || n % 2) throw new Error("INVALID_VOICE_WAV");
      bytes = n;
      dataSeen = true;
    }
    offset += n + (n % 2);
  }
  const duration = bytes / 32000;
  if (
    offset !== audio.length ||
    !fmt ||
    !dataSeen ||
    duration < 10 ||
    duration > 30
  )
    throw new Error("INVALID_VOICE_DURATION");
  return duration;
}
/** 参考音频保持不可变，避免改变已经入队任务使用的身份依据。 */
export class VoiceReferences {
  private records: VoiceRepository;
  constructor(
    private root: string,
    private storage?: ReferenceStorage,
  ) {
    this.records = new VoiceRepository(root);
  }
  get ready() {
    return Boolean(this.storage);
  }
  /** 验证参考音频并保存私有对象及元数据，返回可公开的标识和时长。 */
  async save(owner: string, base64: string) {
    if (!this.storage) throw new Error("VOICE_STORAGE_NOT_CONFIGURED");
    const audio = Buffer.from(base64, "base64");
    if (audio.toString("base64") !== base64)
      throw new Error("INVALID_VOICE_WAV");
    const durationSeconds = validateReference(audio),
      hash = createHash("sha256").update(owner).update(audio).digest("hex"),
      id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
      key = `voice-references/${createHash("sha256").update(owner).digest("hex")}/${id}.wav`;
    if (this.records.exists(owner, id)) {
      const saved = this.get(owner, id);
      return { id: saved.id, durationSeconds: saved.durationSeconds };
    }
    await this.storage.put(key, audio);
    this.records.put(owner, { id, key, durationSeconds });
    return { id, durationSeconds };
  }
  /** 读取属于指定用户的参考音频元数据。 */
  get(owner: string, id: string) {
    return this.records.get(owner, id);
  }
  /** 生成短期私有下载地址，调用方不得记录或公开该地址。 */
  url(reference: VoiceReference) {
    if (!this.storage) throw new Error("VOICE_STORAGE_NOT_CONFIGURED");
    return this.storage.url(reference.key);
  }
}
