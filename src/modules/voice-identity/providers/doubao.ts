/** Doubao voice-registration HTTP adapter with sanitized provider errors. */
import { jsonResponse } from "../../transcription-jobs/providers/qwen.js";
export class DoubaoEnrollmentApi {
  constructor(private request: typeof fetch = fetch) {}
  /** Validate business codes, with no provider message or signed audio URL in errors. */
  async call(apiKey: string, action: string, body: object) {
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
}
