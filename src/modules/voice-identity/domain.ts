/** Immutable owner-bound reference audio metadata. */
export interface VoiceReference {
  id: string;
  durationSeconds: number;
  key: string;
}
/** Private object-storage port; URLs are never exposed in public settings. */
export interface ReferenceStorage {
  put(key: string, audio: Buffer): Promise<void>;
  url(key: string): string;
}
