/** Durable Doubao voiceprint registration. A lost response never triggers a second biometric enrollment. */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  EnrollmentRepository,
  type EnrollmentState,
} from "./enrollment-repository.js";
import { DoubaoEnrollmentApi } from "./providers/doubao.js";
/** Register, reconcile and verify voice identity using injected transport and durable state. */
export class DoubaoVoiceprints {
  private records: EnrollmentRepository;
  private provider: DoubaoEnrollmentApi;
  constructor(root: string, request: typeof fetch = fetch) {
    this.records = new EnrollmentRepository(root);
    this.provider = new DoubaoEnrollmentApi(request);
  }
  /** Persist before submission, then confirm the returned ID is active before allowing ASR to use it. */
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
      // Exclusive creation also prevents parallel requests and other processes from enrolling twice.
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
