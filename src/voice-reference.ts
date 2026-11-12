/** Private reference-audio storage. Owner-bound immutable IDs never expose object URLs in settings. */
import COS from "cos-nodejs-sdk-v5";
import YAML from "yaml";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
export const VoiceReferenceInput = z.object({
  audioBase64: z.string().min(1).max(1_500_000),
});
export const VoiceReferenceView = z.object({
  id: z.string().uuid(),
  durationSeconds: z.number(),
});
export type VoiceReference = z.infer<typeof VoiceReferenceView> & {
  key: string;
};
/** Injected storage permits offline tests without cloud uploads. */
export interface ReferenceStorage {
  put(key: string, audio: Buffer): Promise<void>;
  url(key: string): string;
}
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
  constructor(
    private root: string,
    private storage?: ReferenceStorage,
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  get ready() {
    return Boolean(this.storage);
  }
  private folder(owner: string) {
    const p = join(this.root, createHash("sha256").update(owner).digest("hex"));
    mkdirSync(p, { recursive: true, mode: 0o700 });
    return p;
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
    if (existsSync(join(this.folder(owner), id + ".json"))) {
      const saved = this.get(owner, id);
      return { id: saved.id, durationSeconds: saved.durationSeconds };
    }
    await this.storage.put(key, audio);
    writeFileSync(
      join(this.folder(owner), id + ".json"),
      JSON.stringify({ id, key, durationSeconds }),
      { mode: 0o600, flag: "wx" },
    );
    return { id, durationSeconds };
  }
  get(owner: string, id: string): VoiceReference {
    z.string().uuid().parse(id);
    return JSON.parse(
      readFileSync(join(this.folder(owner), id + ".json"), "utf8"),
    );
  }
  url(reference: VoiceReference) {
    if (!this.storage) throw new Error("VOICE_STORAGE_NOT_CONFIGURED");
    return this.storage.url(reference.key);
  }
}
/** Deployment-only COS credentials are separate from transcription credentials; bucket objects stay private. */
export function cosReferenceStorage(): ReferenceStorage | undefined {
  let local:
    | { bucket: string; region: string; secretId: string; secretKey: string }
    | undefined;
  try {
    const parsed = YAML.parse(
      readFileSync(
        process.env.XQ_CONFIG ??
          join(homedir(), ".config/xinliqiu/client.yaml"),
        "utf8",
      ),
    );
    if (parsed?.storage?.cos)
      local = z
        .object({
          bucket: z.string().min(1),
          region: z.string().min(1),
          secretId: z.string().min(1),
          secretKey: z.string().min(1),
        })
        .parse(parsed.storage.cos);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("INVALID_COS_CONFIG");
  }
  const Bucket = local?.bucket ?? process.env.XQ_VOICE_COS_BUCKET,
    Region = local?.region ?? process.env.XQ_VOICE_COS_REGION,
    SecretId = local?.secretId ?? process.env.XQ_VOICE_COS_SECRET_ID,
    SecretKey = local?.secretKey ?? process.env.XQ_VOICE_COS_SECRET_KEY;
  if (!Bucket || !Region || !SecretId || !SecretKey) return undefined;
  const cos = new COS({ SecretId, SecretKey, Timeout: 30000 });
  return {
    async put(Key, Body) {
      await cos.putObject({
        Bucket,
        Region,
        Key,
        Body,
        ACL: "private",
        ContentType: "audio/wav",
      });
    },
    url(Key) {
      return cos.getObjectUrl({
        Bucket,
        Region,
        Key,
        Sign: true,
        Expires: 3600,
        Protocol: "https:",
      });
    },
  };
}
