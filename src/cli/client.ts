/** Token client for the portable CLI. Requests are same-origin and errors never echo credentials or signed URLs. */
import {
  getMe,
  getTranscriptionService,
  saveTranscriptionService,
  getTranscriptStats,
  getTranscripts,
  getJob,
  submitTranscriptionBatch,
} from "../generated/client.js";
import type { QueryFilters } from "../contracts.js";
/** Environment tokens are process-local; the application token is unrelated to the DashScope key. */
export class Client {
  constructor(private token: string) {
    const base = process.env.XQ_API_URL ?? "http://127.0.0.1:4317";
    const u = new URL(base);
    if (
      u.protocol !== "https:" &&
      !(
        u.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)
      )
    )
      throw new Error("HTTPS required for remote API");
    if (u.username || u.password || u.search || u.hash)
      throw new Error("Invalid API base");
  }
  /** Generated fetch paths are resolved against a configured server while preserving their route/query. */
  private options() {
    return {
      headers: { Authorization: `Bearer ${this.token}` },
      redirect: "error" as const,
      signal: AbortSignal.timeout(30000),
    };
  }
  /** Authenticate without reading transcript bodies. */
  async me() {
    return this.unwrap(await getMe(this.options()));
  }
  /** List providers and masked configuration without fetching any recording text. */
  async transcriptionService() {
    return this.unwrap(await getTranscriptionService(this.options()));
  }
  /** Save a provider configuration through the same generated contract as the desktop. */
  async saveTranscriptionService(
    body: Parameters<typeof saveTranscriptionService>[0],
  ) {
    return this.unwrap(await saveTranscriptionService(body, this.options()));
  }
  async stats(filters: Partial<QueryFilters>) {
    return this.unwrap(await getTranscriptStats(filters, this.options()));
  }
  async read(
    filters: Partial<QueryFilters> = {},
    cursor = 0,
    maxChars = 2000,
    limit = 100,
  ) {
    return this.unwrap(
      await getTranscripts(
        { ...filters, cursor, maxChars, limit },
        this.options(),
      ),
    );
  }
  async job(id: string) {
    return this.unwrap(await getJob(id, this.options()));
  }
  async submit(body: Parameters<typeof submitTranscriptionBatch>[0]) {
    return this.unwrap(await submitTranscriptionBatch(body, this.options()));
  }
  /** Generated clients return a discriminated HTTP response; reject error payloads before consumers see data. */
  private unwrap<T extends { status: number; data: unknown }>(
    response: T,
  ): Extract<T, { status: 200 | 202 }>["data"] {
    if (response.status < 200 || response.status >= 300)
      throw new Error(`API_HTTP_${response.status}`);
    return response.data as Extract<T, { status: 200 | 202 }>["data"];
  }
}
