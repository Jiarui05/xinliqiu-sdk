/** Private TOS audio storage configured from local YAML; signed URLs never enter public settings or logs. */
import { TosClient, ACLType } from "@volcengine/tos-sdk";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { ReferenceStorage } from "./voice-reference.js";
const Config = z.object({
  bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  region: z.enum(["cn-beijing", "cn-shanghai", "cn-guangzhou"]),
  accessKeyId: z.string().min(1),
  accessKeySecret: z.string().min(1),
});
/** Read only the dedicated storage section; a malformed existing file must not silently disable storage. */
export function tosReferenceStorage(): ReferenceStorage | undefined {
  let raw;
  try {
    raw = readFileSync(
      process.env.XQ_CONFIG ?? join(homedir(), ".config/xinliqiu/client.yaml"),
      "utf8",
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("STORAGE_CONFIG_UNREADABLE");
  }
  let config;
  try {
    const value = YAML.parse(raw);
    if (!value?.storage?.tos) return undefined;
    config = Config.parse(value.storage.tos);
  } catch {
    throw new Error("INVALID_TOS_CONFIG");
  }
  const { bucket, region, accessKeyId, accessKeySecret } = config;
  const client = new TosClient({
    region,
    endpoint: `tos-${region}.volces.com`,
    accessKeyId,
    accessKeySecret,
    requestTimeout: 30000,
  });
  return {
    async put(key, body) {
      await client.putObject({
        bucket,
        key,
        body,
        acl: ACLType.ACLPrivate,
        contentType: "audio/wav",
      });
    },
    url(key) {
      return client.getPreSignedUrl({
        bucket,
        key,
        method: "GET",
        expires: 3600,
      });
    },
  };
}
