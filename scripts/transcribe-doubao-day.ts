/** Explicit day backfill using pinned Doubao identity, verified audio and private URLs. Never modifies source audio. */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  copyFileSync,
  openSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { join, resolve, basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { Repository, type StoredJob } from "../src/infrastructure/database.js";
import { TranscriptionConfigs } from "../src/modules/provider-settings/service.js";
import { cosReferenceStorage } from "../src/modules/voice-identity/service.js";
import { tosReferenceStorage } from "../src/infrastructure/storage/tos.js";
import type { SourceSegment } from "../src/modules/transcription-jobs/domain.js";
import { groupAudio } from "../src/modules/transcription-jobs/hourly-policy.js";
import type { TimedWord } from "../src/contracts.js";
const { values } = parseArgs({
  options: {
    library: { type: "string" },
    date: { type: "string" },
    output: { type: "string" },
    inflight: { type: "string", default: "2" },
    "batch-minutes": { type: "string", default: "60" },
    "pending-only": { type: "boolean", default: false },
  },
  strict: true,
});
if (
  !values.library ||
  !values.output ||
  (values.date !== "all" && !/^\d{4}-\d{2}-\d{2}$/.test(values.date ?? "")) ||
  !process.env.XQ_DATA_DIR
)
  throw Error("EXPLICIT_DAY_AND_PATHS_REQUIRED");
const inflight = Number(values.inflight);
if (!Number.isInteger(inflight) || inflight < 1 || inflight > 4)
  throw Error("INVALID_INFLIGHT_LIMIT");
process.umask(0o077);
const root = resolve(values.library),
  folder = resolve(values.output),
  day = values.date!;
const from = day === "all" ? 0 : Date.parse(day + "T00:00:00+08:00"),
  to = day === "all" ? Number.MAX_SAFE_INTEGER : from + 86400000;
const batchMinutes = Number(values["batch-minutes"]);
if (!Number.isInteger(batchMinutes) || batchMinutes < 1 || batchMinutes > 60)
  throw Error("INVALID_BATCH_MINUTES");
if (!Number.isFinite(from)) throw Error("INVALID_DAY");
mkdirSync(folder, { recursive: true, mode: 0o700 });
const lock = join(folder, "runner.lock");
const fd = openSync(lock, "wx", 0o600);
writeFileSync(fd, String(process.pid));
closeSync(fd);
const repo = new Repository(join(process.env.XQ_DATA_DIR, "backend.sqlite"));
/** A frozen source map preserves physical gaps and checksum expectations across restarts. */
type Source = SourceSegment & {
  filename: string;
  sha256: string;
  bytes: number;
};
type Batch = { id: string; sources: Source[]; durationMs: number };
type Manifest = {
  date: string;
  library: string;
  configId: string;
  batchMinutes?: number;
  batches: Batch[];
};
/** Atomically publish progress and completed sidecars without exposing transcript contents in logs. */
function atomic(path: string, data: unknown) {
  const tmp = path + "." + randomUUID() + ".tmp";
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600, flag: "wx" });
  renameSync(tmp, path);
}
try {
  const storage = tosReferenceStorage() ?? cosReferenceStorage();
  if (!storage) throw Error("PRIVATE_STORAGE_REQUIRED");
  const configs = new TranscriptionConfigs(
    join(process.env.XQ_DATA_DIR, "transcription-configs"),
  );
  const manifestPath = join(folder, "manifest.json");
  let manifest: Manifest;
  if (existsSync(manifestPath)) {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.date !== day || manifest.library !== root)
      throw Error("MANIFEST_SCOPE_MISMATCH");
  } else {
    const config = configs.active("local");
    if (
      config?.provider !== "doubao" ||
      !config.voiceIdentity?.enabled ||
      !config.voiceprintId
    )
      throw Error("VERIFIED_SELF_VOICE_REQUIRED");
    const index = JSON.parse(readFileSync(join(root, "state.json"), "utf8")),
      playback = JSON.parse(readFileSync(join(root, "playback.json"), "utf8"));
    const reserved = join(
      process.env.XQ_DATA_DIR,
      "auto-transcription/reserved-sources.json",
    );
    const scheduled = new Set<string>(
      values["pending-only"] && existsSync(reserved)
        ? JSON.parse(readFileSync(reserved, "utf8"))
        : [],
    );
    if (values["pending-only"])
      for (const row of repo.db
        .prepare("SELECT input FROM jobs WHERE owner='local'")
        .all() as { input: string }[]) {
        const prior = JSON.parse(row.input);
        for (const item of prior.sources ?? [{ sourceId: prior.sourceId }])
          scheduled.add(item.sourceId);
      }
    const sources: Source[] = [];
    let missing = 0;
    for (const r of index.recordings) {
      if (
        r.startMS < from ||
        r.startMS >= to ||
        r.name.includes(".vp.") ||
        r.name.includes(".end.") ||
        scheduled.has(r.id)
      )
        continue;
      const a = playback[r.id];
      if (!a) {
        missing++;
        continue;
      }
      if (
        !/^[a-f0-9]{64}$/.test(r.id) ||
        basename(a.filename) !== a.filename ||
        !a.filename.endsWith(".wav") ||
        a.duration <= 0 ||
        !Number.isFinite(a.duration)
      )
        throw Error("INVALID_SOURCE");
      sources.push({
        sourceId: r.id,
        recordedAt: r.startMS,
        offsetMs: 0,
        durationMs: Math.round(a.duration * 1000),
        filename: a.filename,
        sha256: a.sha256,
        bytes: a.bytes,
      });
    }
    if (missing && !values["pending-only"])
      throw Error("DAY_HAS_UNPREPARED_RECORDINGS");
    sources.sort(
      (a, b) =>
        a.recordedAt - b.recordedAt || a.sourceId.localeCompare(b.sourceId),
    );
    const batches: Batch[] = groupAudio(
      sources,
      batchMinutes * 60000,
      values["pending-only"] ? "accumulated" : "history",
    ).map((group) => {
      let durationMs = 0;
      const mapped = group.map((source) => {
        const item = { ...source, offsetMs: durationMs };
        durationMs += source.durationMs;
        return item;
      });
      const id = createHash("sha256")
        .update(JSON.stringify([config.id, mapped]))
        .digest("hex");
      return { id, sources: mapped, durationMs };
    });
    manifest = {
      date: day,
      library: root,
      configId: config.id,
      batchMinutes,
      batches,
    };
    atomic(manifestPath, manifest);
  }
  const config = configs.get("local", manifest.configId);
  if (
    config.provider !== "doubao" ||
    !config.voiceIdentity?.enabled ||
    !config.voiceprintId
  )
    throw Error("PINNED_CONFIG_INVALID");
  mkdirSync(join(folder, "backups"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "transcripts"), { recursive: true, mode: 0o700 });
  /** Verify every immutable source, then create a bounded lossless WAV with the same concatenation map. */
  function prepare(batch: Batch) {
    const files = batch.sources.map((s) => {
      const path = join(root, "audio", s.filename),
        bytes = readFileSync(path);
      if (
        bytes.length !== s.bytes ||
        createHash("sha256").update(bytes).digest("hex") !== s.sha256
      )
        throw Error("SOURCE_CHECKSUM_MISMATCH");
      return `file '${path.replaceAll("'", "'\\''")}'`;
    });
    const list = join(folder, batch.id + ".ffconcat"),
      out = join(folder, batch.id + ".wav");
    writeFileSync(list, "ffconcat version 1.0\n" + files.join("\n"), {
      mode: 0o600,
    });
    if (!existsSync(out)) {
      const temp = out + ".tmp.wav";
      execFileSync(
        "ffmpeg",
        [
          "-nostdin",
          "-v",
          "error",
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          list,
          "-map_metadata",
          "-1",
          "-c:a",
          "pcm_s16le",
          "-y",
          temp,
        ],
        { stdio: "pipe", timeout: 120000 },
      );
      renameSync(temp, out);
    }
    const duration = Number(
      execFileSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "default=noprint_wrappers=1:nokey=1",
          out,
        ],
        { encoding: "utf8", timeout: 15000 },
      ),
    );
    if (Math.abs(duration * 1000 - batch.durationMs) > 1)
      throw Error("BATCH_DURATION_MISMATCH");
    return readFileSync(out);
  }
  /** Export only completed jobs; backup previous results before the first replacement. */
  function publish(batch: Batch) {
    let chars = 0,
      selfWords = 0;
    for (const source of batch.sources) {
      const rows = repo.db
        .prepare(
          "SELECT data FROM words WHERE owner=? AND source_id=? ORDER BY begin_at,seq",
        )
        .all("local", source.sourceId) as { data: string }[];
      const words = rows.map((r) => JSON.parse(r.data) as TimedWord);
      const target = join(root, "transcripts", source.sourceId + ".json"),
        backup = join(folder, "backups", source.sourceId + ".json");
      if (existsSync(target) && !existsSync(backup))
        copyFileSync(target, backup);
      const text = words.map((w) => w.text).join("");
      chars += Array.from(text).length;
      selfWords += words.filter((w) => w.speakerSource === "voiceprint").length;
      atomic(target, {
        text,
        words: words.map((w) => ({
          ...w,
          start: w.startMs / 1000,
          end: w.endMs / 1000,
        })),
        status: "completed",
        provider: "doubao",
        serviceConfigId: manifest.configId,
        batchId: batch.id,
      });
    }
    atomic(join(folder, batch.id + ".exported.json"), {
      chars,
      selfWords,
      recordings: batch.sources.length,
    });
  }
  let last = "";
  while (true) {
    const states = manifest.batches.map((batch) => ({
      batch,
      job: repo.db
        .prepare("SELECT * FROM jobs WHERE owner=? AND source_id=?")
        .get("local", batch.id) as StoredJob | undefined,
    }));
    for (const { batch, job } of states)
      if (
        job?.state === "completed" &&
        !existsSync(join(folder, batch.id + ".exported.json"))
      )
        publish(batch);
    const completed = states.filter((s) => s.job?.state === "completed"),
      failed = states.filter(
        (s) => s.job && ["failed", "submission_unknown"].includes(s.job.state),
      );
    const summary = {
      date: day,
      batches: states.length,
      completed: completed.length,
      failed: failed.length,
      totalRecordings: manifest.batches.reduce(
        (n, b) => n + b.sources.length,
        0,
      ),
      completedRecordings: completed.reduce(
        (n, s) => n + s.batch.sources.length,
        0,
      ),
      totalHours:
        manifest.batches.reduce((n, b) => n + b.durationMs, 0) / 3600000,
    };
    atomic(join(folder, "progress.json"), summary);
    const message = JSON.stringify(summary);
    if (last !== message) {
      console.log(message);
      last = message;
    }
    if (failed.length) {
      console.log(
        JSON.stringify({
          stopped: true,
          errors: failed.map((s) => ({
            state: s.job!.state,
            code: s.job!.error,
          })),
        }),
      );
      process.exitCode = 3;
      break;
    }
    if (completed.length === states.length) break;
    const active = states.filter(
      (s) => s.job && ["queued", "running", "submitting"].includes(s.job.state),
    ).length;
    for (const { batch } of states
      .filter((s) => !s.job)
      .slice(0, Math.max(0, inflight - active))) {
      const bytes = prepare(batch);
      const key = `asr-inputs/${batch.id}.wav`;
      await storage.put(key, bytes);
      repo.jobs.enqueue("local", {
        sourceId: batch.id,
        recordedAt: batch.sources[0].recordedAt,
        audioUrl: storage.url(key),
        audioFormat: "wav",
        mode: "rich",
        serviceConfigId: manifest.configId,
        sources: batch.sources.map(
          ({ sourceId, recordedAt, offsetMs, durationMs }) => ({
            sourceId,
            recordedAt,
            offsetMs,
            durationMs,
          }),
        ),
      });
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
} catch (e) {
  console.log(
    JSON.stringify({
      stopped: true,
      code:
        e instanceof Error && /^[A-Z_0-9]+$/.test(e.message)
          ? e.message
          : "BATCH_FAILED",
    }),
  );
  process.exitCode = 1;
} finally {
  repo.db.close();
  unlinkSync(lock);
}
