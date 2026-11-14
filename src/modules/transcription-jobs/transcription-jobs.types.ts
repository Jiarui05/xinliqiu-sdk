/**
 * @file transcription-jobs.types.ts
 * @description 定义可信本机导入的数据映射；HTTP 仍只接受公开录音提交契约。
 *
 * 职责与入口：
 * - 定义不可变的转录意图，并固定供应商配置版本 → RecordingInput
 * - 描述一份原始录音在无损拼接输入中的位置 → SourceSegment
 * - 每项模型调用独立绑定临时地址 → JobInput
 * - 要求输入映射连续且来源唯一，真实录音之间的时间空白仍由 recordedAt 保留 → validateSources()
 * - 按词项实际开始时间归属来源，保留跨物理文件边界的结束时间 → mappedWords()
 *
 * 边界：仅声明领域数据，不依赖 HTTP 上下文，不执行读写操作。
 */
import { z } from "zod";
import type { TimedWord } from "../transcripts/transcripts.types.js";
/** 定义不可变的转录意图，并固定供应商配置版本。 */
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
/** 描述一份原始录音在无损拼接输入中的位置。 */
export type SourceSegment = z.infer<typeof Segment>;
/** 每项模型调用独立绑定临时地址；本机导入保留原始时间映射。 */
export type JobInput = RecordingInput & {
  temporaryUrls?: { emotion: string; speakers: string };
  sources?: SourceSegment[];
  localAudio?: { path: string; sha256: string };
};
/** 要求输入映射连续且来源唯一，真实录音之间的时间空白仍由 recordedAt 保留。 */
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
/** 按词项实际开始时间归属来源，保留跨物理文件边界的结束时间。 */
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
