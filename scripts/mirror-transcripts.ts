/**
 * @file mirror-transcripts.ts
 * @description 把已完成转录增量同步到私有云 API，不读取或上传音频。
 *
 * 职责与入口：
 * - 每批得到云端确认后才推进本机记录 → sync()
 *
 * 边界：具体读写和执行时机以各入口为准；凭据与用户数据不得进入日志或发行包。
 */
import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { MirrorBatch } from "../src/modules/transcripts/transcripts.schema.js";
import { mirrorTranscripts } from "../src/generated/client.js";
import { Client } from "../src/cli/client.js";
const { values } = parseArgs({
  options: {
    config: { type: "string" },
    watch: { type: "boolean", default: false },
  },
});
if (!values.config) throw Error("CLOUD_CONFIG_REQUIRED");
process.umask(0o077);
let stopping = false;
process.once("SIGTERM", () => {
  stopping = true;
});
process.once("SIGINT", () => {
  stopping = true;
});
/** 每批得到云端确认后才推进本机记录；中断重试由服务端保证幂等。 */
async function sync() {
  const config = YAML.parse(readFileSync(values.config!, "utf8"));
  process.env.XQ_API_URL = config.url;
  const token = config.token;
  if (typeof token !== "string" || token.length < 32)
    throw Error("ROOT_TOKEN_REQUIRED");
  await new Client(token).me();
  const ledgerPath = join(dirname(values.config!), "cloud-mirror-ledger.json");
  mkdirSync(dirname(ledgerPath), { recursive: true, mode: 0o700 });
  const ledger = existsSync(ledgerPath)
    ? JSON.parse(readFileSync(ledgerPath, "utf8"))
    : { url: config.url, revisions: {} };
  if (ledger.url !== config.url) throw Error("MIRROR_TARGET_CHANGED");
  const state = JSON.parse(
    readFileSync(join(config.library, "state.json"), "utf8"),
  );
  let pending: { sourceId: string; recordedAt: number; words: any[] }[] = [];
  let revisions: Record<string, string> = {},
    uploaded = 0,
    bytes = 0;
  /** 只有云端事务成功返回后才记录同步成功，日志不包含正文。 */
  async function flush() {
    if (!pending.length) return;
    const payload = MirrorBatch.parse({ transcripts: pending });
    const r = await mirrorTranscripts(payload, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(60000),
    });
    if (r.status !== 200) throw Error(`MIRROR_HTTP_${r.status}`);
    Object.assign(ledger.revisions, revisions);
    writeFileSync(ledgerPath + ".tmp", JSON.stringify(ledger), { mode: 0o600 });
    renameSync(ledgerPath + ".tmp", ledgerPath);
    uploaded += pending.length;
    console.log(
      JSON.stringify({
        uploaded,
        knownSources: Object.keys(ledger.revisions).length,
      }),
    );
    pending = [];
    revisions = {};
    bytes = 0;
  }
  for (const recording of state.recordings) {
    if (stopping) break;
    if (!/^[a-f0-9]{64}$/.test(recording.id)) continue;
    const path = join(config.library, "transcripts", recording.id + ".json");
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, "utf8");
    const revision = createHash("sha256")
      .update(raw)
      .update(String(recording.startMS))
      .digest("hex");
    if (ledger.revisions[recording.id] === revision) continue;
    const transcript = JSON.parse(raw);
    if (transcript.status !== "completed") continue;
    const source = MirrorBatch.shape.transcripts.element.parse({
      sourceId: recording.id,
      recordedAt: recording.startMS,
      words: transcript.words,
    });
    const size = Buffer.byteLength(JSON.stringify(source));
    if (size > 1500000) throw Error("TRANSCRIPT_EXCEEDS_MIRROR_BUDGET");
    if (pending.length === 25 || bytes + size > 1500000) await flush();
    pending.push(source);
    revisions[recording.id] = revision;
    bytes += size;
  }
  await flush();
}
do {
  try {
    await sync();
  } catch {
    console.error(
      JSON.stringify({ error: "CLOUD_MIRROR_FAILED", retry: values.watch }),
    );
    if (!values.watch) process.exitCode = 1;
  }
  if (!values.watch || stopping) break;
  await new Promise((r) => setTimeout(r, 30000));
} while (!stopping);
