/**
 * @file transcribe-library.ts
 * @description 按明确快照回填转录：验证 WAV、上传音频、原子导出完成词项。
 *
 * 职责与入口：
 * - 本机清单路径不进入 HTTP API 或供应商对象名称 → Source
 * - 描述固定来源集合及拼接时长 → Batch
 * - 保存批次清单和固定配置，供中断后恢复 → Manifest
 * - 通过原子重命名发布私有元数据和转录文件 → atomic()
 * - 导出已完成批次，不把正文写入终端或 Agent 上下文 → exportBatch()
 * - 无损拼接前验证来源字节，编码后再次核对时长 → prepare()
 * - 计费前的临时上传可重试 → enqueue()
 * - 限制同时执行的批次数 → run()
 *
 * 边界：具体读写和执行时机以各入口为准；凭据与用户数据不得进入日志或发行包。
 */
import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  openSync,
  closeSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { Repository, type StoredJob } from "../src/infrastructure/database.js";
import { temporaryUpload } from "../src/infrastructure/storage/temporary-upload.js";
import {
  validateSources,
  type JobInput,
  type SourceSegment,
} from "../src/modules/transcription-jobs/transcription-jobs.types.js";
import type { TimedWord } from "../src/contracts.js";
/** 本机清单路径不进入 HTTP API 或供应商对象名称。 */
type Source = SourceSegment & {
  filename: string;
  sha256: string;
  bytes: number;
};
type Batch = {
  index: number;
  id: string;
  durationMs: number;
  sources: Source[];
};
type Manifest = {
  version: number;
  library: string;
  runDirectory: string;
  owner: string;
  batches: Batch[];
};
const { values } = parseArgs({
  options: {
    manifest: { type: "string" },
    "max-batches": { type: "string" },
    inflight: { type: "string", default: "3" },
  },
  strict: true,
});
if (
  !values.manifest ||
  !process.env.XQ_DATA_DIR ||
  !process.env.DASHSCOPE_BASE_URL ||
  !process.env.DASHSCOPE_API_KEY
)
  throw new Error(
    "Explicit manifest, data directory and provider configuration required",
  );
process.umask(0o077);
const manifest = JSON.parse(readFileSync(values.manifest, "utf8")) as Manifest;
if (
  manifest.version !== 1 ||
  resolve(manifest.runDirectory) !== dirname(resolve(values.manifest))
)
  throw new Error("Invalid manifest");
const folder = manifest.runDirectory,
  root = resolve(manifest.library),
  repo = new Repository(join(process.env.XQ_DATA_DIR, "backend.sqlite"));
const limit = Math.min(
    manifest.batches.length,
    Number(values["max-batches"] ?? manifest.batches.length),
  ),
  inflight = Math.min(4, Math.max(1, Number(values.inflight)));
if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(inflight))
  throw new Error("Invalid limits");
const lock = join(folder, "runner.lock");
let ownedLock = false;
try {
  const fd = openSync(lock, "wx", 0o600);
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  ownedLock = true;
} catch {
  throw new Error(
    "A runner lock already exists; inspect its owner before resuming",
  );
}
/** 通过原子重命名发布私有元数据和转录文件。 */
function atomic(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + "." + randomUUID() + ".tmp";
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, path);
}
/** 导出已完成批次，不把正文写入终端或 Agent 上下文。 */
function exportBatch(batch: Batch) {
  for (const source of batch.sources) {
    const rows = repo.db
      .prepare(
        "SELECT data FROM words WHERE owner=? AND source_id=? ORDER BY begin_at,seq",
      )
      .all(manifest.owner, source.sourceId) as { data: string }[];
    const words = rows.map((r) => JSON.parse(r.data) as TimedWord);
    atomic(join(root, "transcripts", source.sourceId + ".json"), {
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
      batchId: batch.id,
    });
  }
  atomic(join(folder, batch.id + ".exported.json"), {
    completed: true,
    sources: batch.sources.length,
  });
}
/** 无损拼接前验证来源字节，编码后再次核对时长。 */
function prepare(batch: Batch) {
  validateSources(batch.sources);
  const output = join(folder, batch.id + ".flac");
  if (existsSync(output)) return output;
  const files = batch.sources.map((source) => {
    if (
      basename(source.filename) !== source.filename ||
      !source.filename.endsWith(".wav")
    )
      throw new Error("Unsafe source filename");
    const path = join(root, "audio", source.filename),
      data = readFileSync(path);
    if (
      data.length !== source.bytes ||
      createHash("sha256").update(data).digest("hex") !== source.sha256
    )
      throw new Error("Source audio checksum mismatch");
    return `file '${path.replaceAll("'", "'\\''")}'`;
  });
  const list = join(folder, batch.id + ".ffconcat");
  writeFileSync(list, "ffconcat version 1.0\n" + files.join("\n") + "\n", {
    mode: 0o600,
  });
  const temporary = output + ".tmp.flac";
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
      "flac",
      "-compression_level",
      "5",
      "-y",
      temporary,
    ],
    { stdio: "pipe", timeout: 120000 },
  );
  const seconds = Number(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        temporary,
      ],
      { encoding: "utf8" },
    ),
  );
  if (Math.abs(seconds * 1000 - batch.durationMs) > 1)
    throw new Error("Concatenated duration mismatch");
  renameSync(temporary, output);
  return output;
}
/** 计费前的临时上传可重试；模型任务提交由持久 worker 管理。 */
async function enqueue(batch: Batch) {
  const file = prepare(batch),
    cache = join(folder, batch.id + ".uploads.json");
  let uploads = existsSync(cache)
    ? JSON.parse(readFileSync(cache, "utf8"))
    : { createdAt: Date.now(), urls: {} };
  if (Date.now() - uploads.createdAt > 47 * 3600000)
    uploads = { createdAt: Date.now(), urls: {} };
  for (const [pass, model] of [
    ["emotion", "qwen3-asr-flash-filetrans"],
    ["speakers", "fun-asr"],
  ] as const) {
    if (!uploads.urls[pass]) {
      uploads.urls[pass] = await temporaryUpload(
        process.env.DASHSCOPE_BASE_URL!,
        process.env.DASHSCOPE_API_KEY!,
        model,
        file,
      );
      atomic(cache, uploads);
    }
  }
  const input: JobInput = {
    sourceId: batch.id,
    recordedAt: batch.sources[0].recordedAt,
    audioUrl: uploads.urls.emotion,
    mode: "rich",
    temporaryUrls: uploads.urls,
    sources: batch.sources.map(
      ({ sourceId, recordedAt, offsetMs, durationMs }) => ({
        sourceId,
        recordedAt,
        offsetMs,
        durationMs,
      }),
    ),
  };
  repo.jobs.enqueue(manifest.owner, input);
}
/** 限制同时执行的批次数；遇到失败或提交结果未知时停止新增任务。 */
async function run() {
  const batches = manifest.batches.slice(0, limit);
  let last = "";
  while (true) {
    const states = batches.map((batch) => ({
      batch,
      job: repo.db
        .prepare("SELECT * FROM jobs WHERE owner=? AND source_id=?")
        .get(manifest.owner, batch.id) as StoredJob | undefined,
    }));
    for (const { batch, job } of states)
      if (
        job?.state === "completed" &&
        !existsSync(join(folder, batch.id + ".exported.json"))
      )
        exportBatch(batch);
    const completed = states.filter((s) => s.job?.state === "completed"),
      failed = states.filter(
        (s) => s.job && ["failed", "submission_unknown"].includes(s.job.state),
      );
    const summary = {
      batches: limit,
      completed: completed.length,
      failed: failed.length,
      completedRecordings: completed.reduce(
        (n, s) => n + s.batch.sources.length,
        0,
      ),
      completedHours:
        completed.reduce((n, s) => n + s.batch.durationMs, 0) / 3600000,
      totalRecordings: batches.reduce((n, b) => n + b.sources.length, 0),
      totalHours: batches.reduce((n, b) => n + b.durationMs, 0) / 3600000,
      updatedAt: new Date().toISOString(),
    };
    atomic(join(folder, "progress.json"), summary);
    const text = JSON.stringify(summary);
    const status = JSON.stringify({ ...summary, updatedAt: undefined });
    if (status !== last) {
      console.log(text);
      last = status;
    }
    if (failed.length) {
      console.error(
        JSON.stringify({
          paused: true,
          failures: failed.map((s) => ({
            batch: s.batch.index,
            state: s.job!.state,
            error: s.job!.error,
          })),
        }),
      );
      process.exitCode = 3;
      return;
    }
    if (completed.length === limit) return;
    const active = states.filter(
      (s) => s.job && ["queued", "running", "submitting"].includes(s.job.state),
    ).length;
    const ready = states
      .filter((s) => !s.job)
      .slice(0, Math.max(0, inflight - active));
    for (const { batch } of ready) {
      console.log(
        JSON.stringify({
          preparingBatch: batch.index,
          audioSeconds: batch.durationMs / 1000,
        }),
      );
      await enqueue(batch);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}
try {
  await run();
} catch (e) {
  console.error(
    JSON.stringify({
      stopped: true,
      error: e instanceof Error ? e.name : "IMPORT_FAILED",
      code:
        e instanceof Error && /^[A-Z_0-9]+$/.test(e.message)
          ? e.message
          : "IMPORT_FAILED",
    }),
  );
  process.exitCode = 1;
} finally {
  repo.db.close();
  if (ownedLock) unlinkSync(lock);
}
