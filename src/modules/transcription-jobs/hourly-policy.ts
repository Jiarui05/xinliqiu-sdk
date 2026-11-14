/** Pure eligibility rules for operator-enabled hourly imports; scheduling identity is independent of time watermarks. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import YAML from "yaml";
export const HOURLY_AUDIO_MS = 3_600_000;
/** Count verified, unscheduled audio, including recordings that arrived late with an older device timestamp. */
export function pendingAudioMs(
  records: { id: string; startMS: number; name: string }[],
  playback: Record<string, { duration: number }>,
  scheduled: Set<string>,
): number {
  let total = 0;
  for (const record of records) {
    if (
      scheduled.has(record.id) ||
      !record.startMS ||
      record.name.includes(".vp.") ||
      record.name.includes(".end.")
    )
      continue;
    const duration = playback[record.id]?.duration;
    if (Number.isFinite(duration) && duration > 0)
      total += Math.round(duration * 1000);
  }
  return total;
}

/** Expose only scheduling metadata to local settings; never return configuration credentials or paths. */
export function batchingStatus(dataDir: string) {
  try {
    const cfg = YAML.parse(
      readFileSync(
        process.env.XQ_CONFIG ??
          join(homedir(), ".config/xinliqiu/client.yaml"),
        "utf8",
      ),
    );
    const automatic = cfg.transcription?.automatic === true;
    let progress: { pendingSeconds?: number; state?: string } = {};
    try {
      progress = JSON.parse(
        readFileSync(join(dataDir, "auto-transcription/status.json"), "utf8"),
      );
    } catch {}
    return {
      automatic,
      batchMinutes: 60,
      pendingSeconds: Number.isFinite(progress.pendingSeconds)
        ? Math.max(0, progress.pendingSeconds!)
        : 0,
      state: automatic ? (progress.state ?? "starting") : "disabled",
    };
  } catch {
    return {
      automatic: false,
      batchMinutes: 60,
      pendingSeconds: 0,
      state: "attention",
    };
  }
}

/** Historical snapshots include short day tails; unattended imports emit only accumulated full hours. */
export function groupAudio<
  T extends { recordedAt: number; durationMs: number },
>(sources: T[], thresholdMs: number, mode: "history" | "accumulated"): T[][] {
  const groups: T[][] = [];
  let group: T[] = [],
    duration = 0,
    day = "";
  const flush = () => {
    if (group.length) groups.push(group);
    group = [];
    duration = 0;
  };
  for (const source of sources) {
    const nextDay = new Date(source.recordedAt + 8 * 3600000)
      .toISOString()
      .slice(0, 10);
    if (
      mode === "history" &&
      group.length &&
      (nextDay !== day || duration + source.durationMs > thresholdMs)
    )
      flush();
    group.push(source);
    duration += source.durationMs;
    day = nextDay;
    if (mode === "accumulated" && duration >= thresholdMs) flush();
  }
  if (mode === "history") flush();
  return groups;
}
