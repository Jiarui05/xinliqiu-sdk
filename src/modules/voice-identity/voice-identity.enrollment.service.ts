/**
 * @file voice-identity.enrollment.service.ts
 * @description 编排持久化声纹注册流程；响应丢失时不重复提交注册。
 *
 * 职责与入口：
 * - 提交前先保存状态 → DoubaoVoiceprints.ensure()
 *
 * 边界：负责业务流程与约束；数据访问和外部通信使用已有 repository 或 adapter。
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  EnrollmentRepository,
  type EnrollmentState,
} from "./voice-identity.repository.js";
import { DoubaoEnrollmentApi } from "./providers/doubao.provider.js";
/** 使用注入的供应商接口与持久状态完成注册、恢复和身份验证。 */
export class DoubaoVoiceprints {
  private records: EnrollmentRepository;
  private provider: DoubaoEnrollmentApi;
  constructor(root: string, request: typeof fetch = fetch) {
    this.records = new EnrollmentRepository(root);
    this.provider = new DoubaoEnrollmentApi(request);
  }
  /** 提交前先保存状态；确认供应商返回的声纹已激活后才能用于转录。 */
  async ensure(
    owner: string,
    referenceId: string,
    apiKey: string,
    url: () => string,
  ): Promise<string> {
    const digest = createHash("sha256")
      .update(JSON.stringify([owner, referenceId, apiKey]))
      .digest("hex");
    let record: EnrollmentState;
    try {
      record = this.records.load(digest);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("VOICEPRINT_STATE_INVALID");
      record = { state: "submitting" };
      // 独占创建同时防止并发请求或其他进程重复提交声纹注册。
      try {
        this.records.create(digest, record);
      } catch {
        throw new Error("VOICEPRINT_REGISTRATION_PENDING");
      }
      const result = await this.provider.call(apiKey, "UpdateVoiceprint", {
        Action: 0,
        AudioUrl: url(),
        SpeakerName: "我",
      });
      record = {
        state: "registered",
        id: z
          .string()
          .uuid()
          .parse(result.SpeakID ?? result.SpeakId),
      };
      this.records.write(digest, record);
    }
    if (!record.id) throw new Error("VOICEPRINT_REGISTRATION_UNKNOWN");
    if (record.state !== "verified") {
      const result = await this.provider.call(apiKey, "GetVoiceprint", {
        SpeakIdList: [record.id],
      });
      const found = z
        .array(
          z.object({
            SpeakId: z.string().optional(),
            SpeakID: z.string().optional(),
            SpeakerName: z.string(),
            Status: z.number(),
          }),
        )
        .parse(result.AudioEmbedding)
        .some(
          (r) =>
            (r.SpeakID ?? r.SpeakId) === record.id &&
            r.SpeakerName === "我" &&
            r.Status === 1,
        );
      if (!found) throw new Error("VOICEPRINT_NOT_READY");
      this.records.write(digest, { ...record, state: "verified" });
    }
    return record.id;
  }
}
