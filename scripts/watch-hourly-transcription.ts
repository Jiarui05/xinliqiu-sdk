/** Persistent local importer. Explicit YAML opt-in authorizes hourly uploads; unknown jobs never auto-resubmit. */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  openSync,
  closeSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import YAML from "yaml";
import { Repository } from "../src/infrastructure/database.js";
import { TranscriptionConfigs } from "../src/modules/provider-settings/service.js";
import {
  HOURLY_AUDIO_MS,
  pendingAudioMs,
} from "../src/modules/transcription-jobs/hourly-policy.js";
const data = process.env.XQ_DATA_DIR;
if (!data) throw Error("DATA_DIR_REQUIRED");
process.umask(0o077);
const root = join(data, "auto-transcription");
mkdirSync(root, { recursive: true, mode: 0o700 });
/** A dead PID can release an abandoned local lock; a live owner is never displaced. */
function releaseStale(path: string) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8"),
    pid = Number(text);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw Error("INVALID_LOCK_OWNER");
  try {
    process.kill(pid, 0);
    throw Error("IMPORT_ALREADY_RUNNING");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
  }
  if (readFileSync(path, "utf8") === text) unlinkSync(path);
}
const lock = join(root, "watcher.lock");
releaseStale(lock);
writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
const repo = new Repository(join(data, "backend.sqlite")),
  configs = new TranscriptionConfigs(join(data, "transcription-configs"));
let stopping = false,
  child: ChildProcess | undefined;
/** Stop the local scheduler; durable provider jobs remain owned by the API worker. */
function stop() {
  stopping = true;
  child?.kill("SIGTERM");
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
/** Public progress contains no transcript, signed URL or credential material. */
function status(value: object) {
  const path = join(root, "status.json"),
    temp = path + ".tmp";
  writeFileSync(
    temp,
    JSON.stringify({ ...value, updatedAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
  renameSync(temp, path);
}
/** Resume one exact frozen manifest, or freeze new eligible audio in a separate bounded runner. */
async function run(folder: string, library: string) {
  releaseStale(join(folder, "runner.lock"));
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const log = openSync(join(folder, "runner.log"), "a", 0o600);
  try {
    await new Promise<void>((resolve, reject) => {
      child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          fileURLToPath(new URL("./transcribe-doubao-day.ts", import.meta.url)),
          "--date",
          "all",
          "--library",
          library,
          "--output",
          folder,
          "--batch-minutes",
          "60",
          "--pending-only",
          "--inflight",
          "2",
        ],
        { env: process.env, stdio: ["ignore", log, log] },
      );
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 || stopping ? resolve() : reject(Error("HOURLY_RUN_FAILED")),
      );
    });
  } finally {
    closeSync(log);
    child = undefined;
  }
}
try {
  while (!stopping) {
    try {
      const cfg = YAML.parse(
        readFileSync(
          process.env.XQ_CONFIG ??
            join(homedir(), ".config/xinliqiu/client.yaml"),
          "utf8",
        ),
      );
      if (cfg.transcription?.automatic !== true) {
        status({ state: "disabled", batchMinutes: 60 });
      } else {
        const id = cfg.profile?.providerDeviceIdHex;
        if (!/^[a-fA-F0-9]{12}$/.test(id)) throw Error("LIBRARY_ID_INVALID");
        const library = join(
          homedir(),
          "Library/Application Support/XinliqiuLocal",
          id.toLowerCase(),
        );
        const active = configs.active("local");
        if (
          active?.provider !== "doubao" ||
          !active.voiceIdentity?.enabled ||
          !active.voiceprintId
        )
          throw Error("VOICE_CONFIGURATION_REQUIRED");
        let resumed = false,
          failedRuns = 0;
        for (const entry of readdirSync(root, { withFileTypes: true }).filter(
          (e) => e.isDirectory(),
        )) {
          const folder = join(root, entry.name);
          if (!existsSync(join(folder, "manifest.json"))) continue;
          const m = JSON.parse(
            readFileSync(join(folder, "manifest.json"), "utf8"),
          );
          const p = existsSync(join(folder, "progress.json"))
            ? JSON.parse(readFileSync(join(folder, "progress.json"), "utf8"))
            : null;
          if (p?.failed) {
            failedRuns++;
            continue;
          }
          if (
            !p ||
            p.completed !== p.batches ||
            m.batches.some(
              (b: { id: string }) =>
                !existsSync(join(folder, b.id + ".exported.json")),
            )
          ) {
            status({ state: "transcribing", batchMinutes: 60 });
            await run(folder, m.library);
            resumed = true;
            break;
          }
        }
        if (failedRuns)
          status({
            state: "attention",
            batchMinutes: 60,
            error: "HOURLY_RUN_FAILED",
            failedRuns,
          });
        if (!resumed && !stopping && !failedRuns) {
          const reservedPath = join(root, "reserved-sources.json");
          const known = new Set<string>(
            existsSync(reservedPath)
              ? JSON.parse(readFileSync(reservedPath, "utf8"))
              : [],
          );
          for (const r of repo.db
            .prepare("SELECT input FROM jobs WHERE owner='local'")
            .all() as { input: string }[]) {
            const input = JSON.parse(r.input);
            for (const source of input.sources ?? [
              { sourceId: input.sourceId },
            ])
              known.add(source.sourceId);
          }
          const index = JSON.parse(
              readFileSync(join(library, "state.json"), "utf8"),
            ),
            audio = JSON.parse(
              readFileSync(join(library, "playback.json"), "utf8"),
            );
          const pendingMs = pendingAudioMs(index.recordings, audio, known);
          status({
            state:
              pendingMs >= HOURLY_AUDIO_MS ? "transcribing" : "accumulating",
            pendingSeconds: pendingMs / 1000,
            batchMinutes: 60,
          });
          if (pendingMs >= HOURLY_AUDIO_MS)
            await run(
              join(root, "run-" + Date.now() + "-" + randomUUID()),
              library,
            );
        }
      }
    } catch (e) {
      status({
        state: "attention",
        batchMinutes: 60,
        error:
          e instanceof Error && /^[A-Z_]+$/.test(e.message)
            ? e.message
            : "HOURLY_IMPORT_FAILED",
      });
    }
    for (let i = 0; i < 30 && !stopping; i++)
      await new Promise((r) => setTimeout(r, 1000));
  }
} finally {
  repo.db.close();
  if (existsSync(lock) && readFileSync(lock, "utf8") === String(process.pid))
    unlinkSync(lock);
}
