/** DashScope adapters keep asynchronous ASR separate from AI SDK text generation. Never log signed URLs. */
import { z } from "zod";
import type { JobInput } from "../domain.js";
import {
  Emotion,
  Word,
  type TimedWord,
  type RecordingInput,
} from "../../../contracts.js";
export type Pass = "emotion" | "speakers" | "transcription";
/** Remote boundaries are injected for offline failure tests. */
export interface Provider {
  passes?(input: JobInput): Pass[];
  finish?(
    results: Partial<Record<Pass, unknown>>,
    input: JobInput,
  ): TimedWord[];
  submit(input: JobInput, pass: Pass): Promise<string | { completed: unknown }>;
  poll(id: string, pass: Pass): Promise<unknown | null>;
}
const Token = z.object({
  text: z.string(),
  begin_time: z.number().int().nonnegative(),
  end_time: z.number().int().nonnegative(),
  punctuation: z.string().optional(),
});
const Sentence = Token.extend({
  speaker_id: z.union([z.string(), z.number()]).optional(),
  emotion: z.string().optional(),
  words: z.array(Token).optional(),
});
const Result = z.object({
  transcripts: z.array(z.object({ sentences: z.array(Sentence) })),
});
/** Normalize real timestamps; unknown labels stay null and sentence fallback remains explicitly coarse. */
export function normalize(raw: unknown): TimedWord[] {
  const result: TimedWord[] = [];
  for (const t of Result.parse(raw).transcripts)
    for (const s of t.sentences) {
      const tokens = s.words?.length ? s.words : [s];
      for (const w of tokens) {
        const text = w.text + (w.punctuation ?? "");
        const chars = Array.from(text);
        for (let i = 0; i < chars.length; i += 256)
          result.push(
            Word.parse({
              text: chars.slice(i, i + 256).join(""),
              startMs: w.begin_time,
              endMs: w.end_time,
              speaker: s.speaker_id === undefined ? null : String(s.speaker_id),
              emotion: Emotion.safeParse(s.emotion).success ? s.emotion : null,
              timing: !s.words?.length
                ? "sentence"
                : Array.from(w.text).length === 1
                  ? "character"
                  : "word",
              speakerSource:
                s.speaker_id === undefined ? "unknown" : "provider",
            }),
          );
      }
    }
  return result.sort((a, b) => a.startMs - b.startMs);
}
/** Align independent diarization by time overlap; do not invent speakers in gaps or ambiguous overlaps. */
export function combine(emotion: unknown, speakers: unknown): TimedWord[] {
  const spans = Result.parse(speakers).transcripts.flatMap((t) => t.sentences);
  return normalize(emotion).map((w) => {
    const scores = new Map<string, number>();
    for (const s of spans)
      if (s.speaker_id !== undefined) {
        const n = Math.max(
          0,
          Math.min(w.endMs, s.end_time) - Math.max(w.startMs, s.begin_time),
        );
        const key = String(s.speaker_id);
        scores.set(key, Math.max(scores.get(key) ?? 0, n));
      }
    const ranked = [...scores].sort((a, b) => b[1] - a[1]);
    const best = ranked[0];
    return best &&
      best[1] >= Math.max(1, (w.endMs - w.startMs) * 0.6) &&
      best[1] > (ranked[1]?.[1] ?? 0)
      ? { ...w, speaker: best[0], speakerSource: "overlap" }
      : w;
  });
}
/** Bound JSON response sizes and avoid forwarding credentials to result-file origins. */
export async function jsonResponse(r: Response) {
  if (!r.ok) throw new Error(`PROVIDER_HTTP_${r.status}`);
  const reader = r.body?.getReader();
  if (!reader) throw new Error("PROVIDER_EMPTY");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const v = await reader.read();
      if (v.done) break;
      size += v.value.length;
      if (size > 32 * 1024 * 1024) throw new Error("PROVIDER_RESULT_TOO_LARGE");
      chunks.push(v.value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, any>;
}
/** Region/workspace endpoint is explicit; missing credentials cannot silently select a remote account. */
export class DashScope implements Provider {
  constructor(
    private base: string,
    private key: string,
    private allowedResultHosts: string[],
    private model = "qwen3-asr-flash-filetrans",
  ) {
    const u = new URL(base);
    if (u.protocol !== "https:" || !key)
      throw new Error("PROVIDER_NOT_CONFIGURED");
  }
  async submit(input: JobInput, pass: Pass) {
    const audioUrl =
      (pass === "transcription" ? undefined : input.temporaryUrls?.[pass]) ??
      input.audioUrl;
    const temporary = audioUrl.startsWith("oss://dashscope-instant/");
    const body =
      pass === "emotion"
        ? {
            model: this.model,
            input: { file_url: audioUrl },
            parameters: {
              enable_words: true,
              enable_itn: false,
              channel_id: [0],
            },
          }
        : {
            model: "fun-asr",
            input: { file_urls: [audioUrl] },
            parameters: { diarization_enabled: true, channel_id: [0] },
          };
    const result = await jsonResponse(
      await fetch(`${this.base}/services/audio/asr/transcription`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.key}`,
          "Content-Type": "application/json",
          "X-DashScope-Async": "enable",
          ...(temporary ? { "X-DashScope-OssResourceResolve": "enable" } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
        redirect: "error",
      }),
    );
    return z.string().min(1).parse(result.output?.task_id);
  }
  async poll(id: string, pass: Pass) {
    const result = await jsonResponse(
      await fetch(`${this.base}/tasks/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${this.key}` },
        signal: AbortSignal.timeout(20000),
        redirect: "error",
      }),
    );
    if (["PENDING", "RUNNING"].includes(result.output?.task_status))
      return null;
    if (result.output?.task_status !== "SUCCEEDED")
      throw new Error("PROVIDER_TASK_FAILED");
    const file =
      pass === "emotion" ? result.output.result : result.output.results?.[0];
    if (pass === "speakers" && file?.subtask_status !== "SUCCEEDED")
      throw new Error("PROVIDER_FILE_FAILED");
    const url = new URL(z.string().url().parse(file?.transcription_url));
    // OSS result links can advertise HTTP; retain the signed resource/query while requiring TLS.
    if (
      url.protocol === "http:" &&
      !url.port &&
      this.allowedResultHosts.includes(url.hostname) &&
      /^dashscope-result-[a-z0-9-]+\.oss-[a-z0-9-]+\.aliyuncs\.com$/.test(
        url.hostname,
      )
    )
      url.protocol = "https:";
    if (
      url.protocol !== "https:" ||
      url.port ||
      !this.allowedResultHosts.includes(url.hostname) ||
      url.username ||
      url.password
    )
      throw new Error("RESULT_HOST_NOT_ALLOWED");
    return jsonResponse(
      await fetch(url, {
        signal: AbortSignal.timeout(20000),
        redirect: "error",
      }),
    );
  }
}
