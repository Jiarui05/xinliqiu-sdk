/** Private reference-audio storage. Owner-bound immutable IDs never expose object URLs in settings. */
import { createHash } from "node:crypto";
import { VoiceRepository } from "./repository.js";
import type { VoiceReference, ReferenceStorage } from "./domain.js";
export type { VoiceReference, ReferenceStorage } from "./domain.js";
export { cosReferenceStorage } from "../../infrastructure/storage/cos.js";
/** Validate actual RIFF chunks and PCM duration before storing a single-channel reference. */
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
/** References remain immutable for already queued jobs. */
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
  /** Load an owner-bound reference. */
  get(owner: string, id: string) {
    return this.records.get(owner, id);
  }
  url(reference: VoiceReference) {
    if (!this.storage) throw new Error("VOICE_STORAGE_NOT_CONFIGURED");
    return this.storage.url(reference.key);
  }
}
