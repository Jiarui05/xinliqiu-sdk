/** Domain values independent from HTTP schemas and vendor response formats. */
export type Emotion =
  "surprised" | "neutral" | "happy" | "sad" | "disgusted" | "angry" | "fearful";
/** Original timestamp precision and speaker provenance survive storage and transport. */
export interface TimedWord {
  text: string;
  startMs: number;
  endMs: number;
  speaker: string | null;
  emotion: Emotion | null;
  timing: "character" | "word" | "sentence";
  speakerSource: "provider" | "overlap" | "unknown" | "voiceprint";
}
/** A bounded search over recorded wall-clock time and optional speaker/content filters. */
export interface QueryFilters {
  from: number;
  to: number;
  sourceId?: string;
  speaker?: string;
  emotion?: Emotion;
  q?: string;
}
/** Completed source text ready for idempotent replication. */
export interface MirroredTranscript {
  sourceId: string;
  recordedAt: number;
  words: TimedWord[];
}
