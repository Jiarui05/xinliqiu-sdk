/**
 * @file tos.ts
 * @description 从本机 YAML 配置私有 TOS 存储，签名地址不进入公开设置或日志。
 *
 * 职责与入口：
 * - 只读取专用存储配置段 → tosReferenceStorage()
 *
 * 边界：具体读写和执行时机以各入口为准；凭据与用户数据不得进入日志或发行包。
 */
import { TosClient, ACLType } from "@volcengine/tos-sdk";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { ReferenceStorage } from "../../modules/voice-identity/voice-identity.service.js";
const Config = z.object({
  bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  region: z.enum(["cn-beijing", "cn-shanghai", "cn-guangzhou"]),
  accessKeyId: z.string().min(1),
  accessKeySecret: z.string().min(1),
});
/** 只读取专用存储配置段；已有文件损坏时应报错，不静默禁用存储。 */
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
    /** 保存对象或元数据；调用方必须已经完成输入校验。 */
    async put(key, body) {
      await client.putObject({
        bucket,
        key,
        body,
        acl: ACLType.ACLPrivate,
        contentType: "audio/wav",
      });
    },
    /** 生成短期私有下载地址，调用方不得记录或公开该地址。 */
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
