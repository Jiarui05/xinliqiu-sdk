/**
 * @file transcripts.service.ts
 * @description 计算转录内容指纹并调用持久化层完成镜像，不处理音频。
 *
 * 职责与入口：
 * - 正文镜像只发布完成结果，不调用供应商、不上传音频 → mirrorTranscripts()
 *
 * 边界：负责业务流程与约束；数据访问和外部通信使用已有 repository 或 adapter。
 */
import { createHash } from "node:crypto";
import type { Repository } from "../../infrastructure/database.js";
import type { MirroredTranscript } from "./transcripts.types.js";
/** 正文镜像只发布完成结果，不调用供应商、不上传音频。 */
export function mirrorTranscripts(
  repo: Repository,
  owner: string,
  input: { transcripts: MirroredTranscript[] },
) {
  const revisions = input.transcripts.map((source) => ({
    ...source,
    revision: createHash("sha256").update(JSON.stringify(source)).digest("hex"),
  }));
  return repo.mirrors.replace(owner, revisions);
}
