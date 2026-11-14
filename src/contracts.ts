/** Public schema barrel for the generated API and CLI boundary. */
export * from "./modules/transcripts/schema.js";
export * from "./modules/transcription-jobs/schema.js";
export * from "./http/schema.js";
export type { QueryFilters, TimedWord } from "./modules/transcripts/domain.js";
export type { RecordingInput } from "./modules/transcription-jobs/domain.js";
