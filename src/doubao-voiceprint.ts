/** Durable Doubao voiceprint registration. A lost response never triggers a second biometric enrollment. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { jsonResponse } from "./provider.js";
/** The registered ID is provider-owned; it is not an anonymous per-file speaker number. */
const Record = z.object({
  state: z.enum(["submitting", "registered", "verified"]),
  id: z.string().uuid().optional(),
});
/** Owner, reference and credential scope isolate enrollments and make retrying settings idempotent. */
export class DoubaoVoiceprints {
  constructor(
    private root: string,
    private request: typeof fetch = fetch,
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  /** Validate business codes, with no provider message or signed audio URL in errors. */
  private async call(apiKey: string, action: string, body: object) {
    const response = await this.request(
      `https://openspeech.bytedance.com/api/proxy/invoke/?Action=${action}`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(20000),
        headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) throw new Error(`VOICEPRINT_HTTP_${response.status}`);
    const result = await jsonResponse(response);
    if (result.ResponseMetadata?.Error || result.Result?.Code !== 1000)
      throw new Error("VOICEPRINT_PROVIDER_REJECTED");
    return result.Result;
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
    const path = join(this.root, digest + ".yaml");
    let record: z.infer<typeof Record>;
    try {
      record = Record.parse(YAML.parse(readFileSync(path, "utf8")));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("VOICEPRINT_STATE_INVALID");
      record = { state: "submitting" };
      // Exclusive creation also prevents parallel requests and other processes from enrolling twice.
      try {
        writeFileSync(path, YAML.stringify(record), {
          flag: "wx",
          mode: 0o600,
        });
      } catch {
        throw new Error("VOICEPRINT_REGISTRATION_PENDING");
      }
      const result = await this.call(apiKey, "UpdateVoiceprint", {
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
      this.write(path, record);
    }
    if (!record.id) throw new Error("VOICEPRINT_REGISTRATION_UNKNOWN");
    if (record.state !== "verified") {
      const result = await this.call(apiKey, "GetVoiceprint", {
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
      this.write(path, { ...record, state: "verified" });
    }
    return record.id;
  }
  /** Publish the completed state atomically; no raw biometric embedding is retained locally. */
  private write(path: string, value: unknown) {
    const temp = path + "." + randomUUID() + ".tmp";
    writeFileSync(temp, YAML.stringify(value), { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  }
}
