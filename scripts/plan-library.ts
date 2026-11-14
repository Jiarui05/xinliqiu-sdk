/**
 * @file plan-library.ts
 * @description 将明确选定的录音库固定为有界无损转录批次，不执行网络请求。
 *
 * 职责与入口：
 * - 输入映射只记录来源校验值，不包含音频正文或设备凭据 → Source
 *
 * 边界：具体读写和执行时机以各入口为准；凭据与用户数据不得进入日志或发行包。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname, join, basename } from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
const { values } = parseArgs({
  options: {
    library: { type: "string" },
    output: { type: "string" },
    owner: { type: "string", default: "local" },
    "batch-minutes": { type: "string", default: "30" },
  },
  strict: true,
});
if (!values.library || !values.output)
  throw new Error("Explicit --library and --output are required");
const root = resolve(values.library),
  output = resolve(values.output),
  minutes = Number(values["batch-minutes"]);
if (
  !Number.isInteger(minutes) ||
  minutes < 1 ||
  minutes > 120 ||
  existsSync(output)
)
  throw new Error("Invalid batch size or existing manifest");
const index = JSON.parse(readFileSync(join(root, "state.json"), "utf8")),
  playback = JSON.parse(readFileSync(join(root, "playback.json"), "utf8"));
/** 输入映射只记录来源校验值，不包含音频正文或设备凭据。 */
type Source = {
  sourceId: string;
  recordedAt: number;
  durationMs: number;
  filename: string;
  sha256: string;
  bytes: number;
};
const records: Source[] = [];
for (const r of index.recordings) {
  const a = playback[r.id];
  if (!a || !r.startMS || r.name.includes(".end.") || r.name.includes(".vp."))
    continue;
  if (
    !/^[a-f0-9]{64}$/.test(r.id) ||
    !Number.isSafeInteger(r.startMS) ||
    basename(a.filename) !== a.filename ||
    !a.filename.endsWith(".wav") ||
    !Number.isFinite(a.duration) ||
    a.duration <= 0
  )
    throw new Error("Invalid library metadata");
  const existing = join(root, "transcripts", r.id + ".json");
  if (existsSync(existing)) {
    const t = JSON.parse(readFileSync(existing, "utf8"));
    if (typeof t.text !== "string")
      throw new Error("Existing transcript needs inspection");
    continue;
  }
  records.push({
    sourceId: r.id,
    recordedAt: r.startMS,
    durationMs: Math.round(a.duration * 1000),
    filename: a.filename,
    sha256: a.sha256,
    bytes: a.bytes,
  });
}
records.sort(
  (a, b) => a.recordedAt - b.recordedAt || a.sourceId.localeCompare(b.sourceId),
);
const pilot = records.find((r) => r.durationMs >= 50000) ?? records[0],
  groups: Source[][] = pilot ? [[pilot]] : [];
let group: Source[] = [],
  duration = 0,
  day = "";
const calendar = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
for (const r of records.filter((r) => r !== pilot)) {
  const next = calendar.format(r.recordedAt);
  if (
    group.length &&
    (next !== day || duration + r.durationMs > minutes * 60000)
  ) {
    groups.push(group);
    group = [];
    duration = 0;
  }
  group.push(r);
  duration += r.durationMs;
  day = next;
}
if (group.length) groups.push(group);
const batches = groups.map((items, index) => {
  let durationMs = 0;
  const sources = items.map((r) => {
    const source = { ...r, offsetMs: durationMs };
    durationMs += r.durationMs;
    return source;
  });
  const id = createHash("sha256").update(JSON.stringify(sources)).digest("hex");
  return { index, id, durationMs, sources };
});
mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
writeFileSync(
  output,
  JSON.stringify(
    {
      version: 1,
      createdAt: new Date().toISOString(),
      library: root,
      runDirectory: dirname(output),
      owner: values.owner,
      batches,
    },
    null,
    2,
  ),
  { mode: 0o600, flag: "wx" },
);
console.log(
  JSON.stringify({
    snapshot: output,
    recordings: records.length,
    batches: batches.length,
    hours: records.reduce((n, r) => n + r.durationMs, 0) / 3600000,
  }),
);
