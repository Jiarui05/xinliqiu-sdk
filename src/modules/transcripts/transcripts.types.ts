/**
 * @file transcripts.types.ts
 * @description 定义独立于 HTTP schema 和供应商返回格式的转录领域类型。
 *
 * 职责与入口：
 * - 定义独立于 HTTP schema 和供应商返回格式的转录领域类型 → Emotion
 * - 保留原始时间精度和说话人标签来源，供存储与展示一致使用 → TimedWord
 * - 按录音发生时间、说话人和关键词表达正文查询条件 → QueryFilters
 * - 表示可以幂等同步的一份已完成来源文字 → MirroredTranscript
 *
 * 边界：仅声明领域数据，不依赖 HTTP 上下文，不执行读写操作。
 */
export type Emotion =
  "surprised" | "neutral" | "happy" | "sad" | "disgusted" | "angry" | "fearful";
/** 保留原始时间精度和说话人标签来源，供存储与展示一致使用。 */
export interface TimedWord {
  text: string;
  startMs: number;
  endMs: number;
  speaker: string | null;
  emotion: Emotion | null;
  timing: "character" | "word" | "sentence";
  speakerSource: "provider" | "overlap" | "unknown" | "voiceprint";
}
/** 按录音发生时间、说话人和关键词表达正文查询条件。 */
export interface QueryFilters {
  from: number;
  to: number;
  sourceId?: string;
  speaker?: string;
  emotion?: Emotion;
  q?: string;
}
/** 表示可以幂等同步的一份已完成来源文字。 */
export interface MirroredTranscript {
  sourceId: string;
  recordedAt: number;
  words: TimedWord[];
}
