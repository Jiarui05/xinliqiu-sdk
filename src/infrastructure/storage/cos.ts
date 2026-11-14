/** Private COS storage adapter and deployment credential loading. */
import COS from "cos-nodejs-sdk-v5";
import YAML from "yaml";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ReferenceStorage } from "../../modules/voice-identity/domain.js";
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
