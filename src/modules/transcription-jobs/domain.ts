/** Trusted local-import metadata. HTTP requests still accept only the public Recording contract. */
import { z } from "zod";
import type { TimedWord } from "../transcripts/domain.js";
/** Immutable transcription intent with a pinned provider configuration. */
export interface RecordingInput {
  sourceId: string;
  recordedAt: number;
  audioUrl: string;
  audioFormat?: "wav" | "mp3" | "ogg" | "raw";
  serviceConfigId?: string;
  mode: "rich" | "speakers" | "emotion";
}
const Segment = z.object({
  sourceId: z.string().regex(/^[a-f0-9]{64}$/),
  recordedAt: z.number().int().nonnegative(),
  offsetMs: z.number().int().nonnegative(),
  durationMs: z.number().int().positive(),
});
/** One original recording's placement in a concatenated, lossless ASR input. */
export type SourceSegment = z.infer<typeof Segment>;
/** Temporary URLs are bound independently to each model; local imports retain their source clock map. */
export type JobInput = RecordingInput & {
  temporaryUrls?: { emotion: string; speakers: string };
  sources?: SourceSegment[];
  localAudio?: { path: string; sha256: string };
};
/** Require a continuous input map with unique source identities; original wall-clock gaps remain in recordedAt. */
export function validateSources(sources: SourceSegment[]) {
  let end = 0;
  const ids = new Set<string>();
  for (const value of sources) {
    const s = Segment.parse(value);
    if (s.offsetMs !== end || ids.has(s.sourceId))
      throw new Error("INVALID_SOURCE_MAP");
    end += s.durationMs;
    ids.add(s.sourceId);
  }
  if (!sources.length || sources.length > 500 || end > 7200000)
    throw new Error("INVALID_SOURCE_MAP");
}
/** Assign each token by its real start time; preserve an end that crosses a physical recording boundary. */
export function mappedWords(input: JobInput, words: TimedWord[]) {
  if (!input.sources)
    return words.map((word) => ({
      sourceId: input.sourceId,
      recordedAt: input.recordedAt,
      word,
    }));
  validateSources(input.sources);
  const last = input.sources.at(-1)!;
  return words.map((w) => {
    const source =
      input.sources!.find(
        (s) => s.offsetMs <= w.startMs && w.startMs < s.offsetMs + s.durationMs,
      ) ?? (w.startMs === last.offsetMs + last.durationMs ? last : undefined);
    if (!source) throw new Error("TIMESTAMP_OUTSIDE_SOURCE_MAP");
    return {
      sourceId: source.sourceId,
      recordedAt: source.recordedAt,
      word: {
        ...w,
        startMs: w.startMs - source.offsetMs,
        endMs: w.endMs - source.offsetMs,
        speaker:
          w.speaker === null || w.speakerSource === "voiceprint"
            ? w.speaker
            : `${input.sourceId.slice(0, 12)}:${w.speaker}`,
      },
    };
  });
}
