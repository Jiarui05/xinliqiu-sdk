/** Explicit one-recording Doubao evaluation. Uses an isolated durable queue and preserves existing sidecars by default. */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  renameSync,
  realpathSync,
} from "node:fs";
import { join, basename, resolve, relative } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { Repository } from "../src/infrastructure/database.js";
import { TranscriptionConfigs } from "../src/modules/provider-settings/service.js";
import { configuredProvider } from "../src/modules/transcription-jobs/providers/registry.js";
import { cosReferenceStorage } from "../src/modules/voice-identity/service.js";
import { tosReferenceStorage } from "../src/infrastructure/storage/tos.js";
import { tick } from "../src/modules/transcription-jobs/worker.js";
import type { TimedWord } from "../src/contracts.js";
const { values } = parseArgs({
  options: {
    library: { type: "string" },
    source: { type: "string" },
    output: { type: "string" },
    "config-id": { type: "string" },
    apply: { type: "boolean", default: false },
  },
  strict: true,
});
if (
  !values.library ||
  !values.source ||
  !values.output ||
  !process.env.XQ_DATA_DIR ||
  !/^[a-f0-9]{64}$/.test(values.source)
)
  throw new Error(
    "Explicit library, source hash, output and XQ_DATA_DIR required",
  );
process.umask(0o077);
const root = realpathSync(values.library),
  folder = resolve(values.output);
const configs = new TranscriptionConfigs(
  join(process.env.XQ_DATA_DIR, "transcription-configs"),
);
const id =
  values["config-id"] ??
  configs.list("local").configurations.find((c) => c.provider === "doubao")?.id;
if (!id) throw new Error("DOUBAO_NOT_CONFIGURED");
const config = configs.get("local", id);
if (
  config.provider !== "doubao" ||
  !["volc.bigasr.auc_turbo", "volc.seedasr.auc"].includes(
    config.credentials.resourceId,
  )
)
  throw new Error("LOCAL_RECORDING_REQUIRES_DOUBAO_TURBO");
const index = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
const record = index.recordings.find((r: any) => r.id === values.source);
const audio = JSON.parse(readFileSync(join(root, "playback.json"), "utf8"))[
  values.source
];
if (
  !record ||
  !audio ||
  basename(audio.filename) !== audio.filename ||
  !audio.filename.endsWith(".wav") ||
  audio.duration > 120 ||
  audio.duration <= 0
)
  throw new Error("Select one verified WAV of at most 120 seconds");
const audioRoot = realpathSync(join(root, "audio")),
  path = realpathSync(join(audioRoot, audio.filename));
if (relative(audioRoot, path).startsWith(".."))
  throw new Error("UNSAFE_AUDIO_PATH");
const bytes = readFileSync(path);
if (
  bytes.length !== audio.bytes ||
  createHash("sha256").update(bytes).digest("hex") !== audio.sha256
)
  throw new Error("AUDIO_CHECKSUM_MISMATCH");
mkdirSync(folder, { recursive: true, mode: 0o700 });
const repo = new Repository(join(folder, "evaluation.sqlite"));
try {
  const job = repo.jobs.enqueue("local", {
    sourceId: record.id,
    recordedAt: record.startMS,
    audioUrl: "https://local.invalid/verified.wav",
    audioFormat: "wav",
    mode: "rich",
    serviceConfigId: id,
    localAudio: { path, sha256: audio.sha256 },
  });
  const before = repo.jobs.job("local", job.id)!;
  if (before.state === "queued" || before.state === "running")
    await tick(
      repo,
      configuredProvider(
        config,
        undefined,
        undefined,
        tosReferenceStorage() ?? cosReferenceStorage(),
      ),
    );
  const result = repo.jobs.job("local", job.id)!;
  if (result.state !== "completed") {
    console.log(JSON.stringify(result));
    process.exitCode = 3;
  } else {
    const rows = repo.db
      .prepare(
        "SELECT data FROM words WHERE owner=? AND source_id=? ORDER BY begin_at,seq",
      )
      .all("local", record.id) as { data: string }[];
    const words = rows.map((r) => JSON.parse(r.data) as TimedWord);
    const sidecar = {
      text: words.map((w) => w.text).join(""),
      words: words.map((w) => ({
        text: w.text,
        start: w.startMs / 1000,
        end: w.endMs / 1000,
        speaker: w.speaker,
        emotion: w.emotion,
        timing: w.timing,
        speakerSource: w.speakerSource,
      })),
      status: "completed",
      provider: "doubao",
      serviceConfigId: id,
    };
    const output = join(folder, "transcript.json");
    writeFileSync(output, JSON.stringify(sidecar), { mode: 0o600 });
    if (values.apply) {
      const target = join(root, "transcripts", record.id + ".json");
      mkdirSync(join(root, "transcripts"), { recursive: true, mode: 0o700 });
      if (existsSync(target)) {
        const backup = join(folder, "previous-transcript.json");
        if (!existsSync(backup)) copyFileSync(target, backup);
      }
      const temporary = target + "." + randomUUID() + ".tmp";
      writeFileSync(temporary, JSON.stringify(sidecar), { mode: 0o600 });
      renameSync(temporary, target);
    }
    console.log(
      JSON.stringify({
        state: result.state,
        words: words.length,
        chars: Array.from(sidecar.text).length,
        durationSeconds: audio.duration,
        transcriptFile: output,
        applied: values.apply,
      }),
    );
  }
} finally {
  repo.db.close();
}
