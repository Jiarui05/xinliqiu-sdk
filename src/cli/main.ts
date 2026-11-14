#!/usr/bin/env node
/** Agent CLI: domain shortcuts, schema inspection, dry runs and bounded transcript output. */
import { Command } from "commander";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { cliClient as client, login, logout } from "./config.js";
import { Batch, Filters, Read } from "../contracts.js";
declare const XQ_CLI_VERSION: string;
const program = new Command()
  .name("xq")
  .version(typeof XQ_CLI_VERSION === "string" ? XQ_CLI_VERSION : "dev")
  .description(
    "心力球云端 CLI。建议先 +inspect 看字数，再 +read 有界读取；root Token 保存于私有 YAML。",
  )
  .option("--dry-run", "预览请求，不执行")
  .option("--fields <names>", "输出指定顶层字段")
  .option("--json", "JSON 输出（默认）");
/** Only result fields reach stdout; never print tokens or signed audio URLs. */
function output(value: unknown) {
  const fields = program.opts().fields as string | undefined;
  console.log(
    JSON.stringify(
      fields && value && typeof value === "object"
        ? Object.fromEntries(
            fields
              .split(",")
              .map((k) => [k, (value as Record<string, unknown>)[k]]),
          )
        : value,
      null,
      2,
    ),
  );
}
/** Bundled releases keep assets adjacent; development sources use the backend package root. */
function asset(name: string) {
  const adjacent = new URL(`./${name}`, import.meta.url);
  return existsSync(adjacent)
    ? adjacent
    : new URL(
        `../../${name === "SKILL.md" ? "skill/SKILL.md" : name}`,
        import.meta.url,
      );
}
/** Require explicit timezone offsets for human-supplied calendar filters. */
function time(v: string | undefined) {
  if (v === undefined) return undefined;
  if (!/(Z|[+-]\d\d:\d\d)$/.test(v) || !Number.isFinite(Date.parse(v)))
    throw new Error("Use ISO8601 with timezone");
  return Date.parse(v);
}
const transcript = program
  .command("transcript")
  .description("转录查询与本地导出");
transcript
  .command("+inspect")
  .description("read · 只统计字数和时间，不返回正文")
  .option("--from <time>")
  .option("--to <time>")
  .option("--source-id <sha256>")
  .option("--speaker <label>")
  .option("--emotion <label>")
  .option("--keyword <text>")
  .action(async (o) => {
    const f = Filters.parse({
      from: time(o.from),
      to: time(o.to),
      sourceId: o.sourceId,
      speaker: o.speaker,
      emotion: o.emotion,
      q: o.keyword,
    });
    if (program.opts().dryRun)
      return output({
        method: "GET",
        path: "/v1/transcripts/stats",
        filters: f,
      });
    output(await client().stats(f));
  });
transcript
  .command("+read")
  .description("read · 使用 root Token 按条件分页，默认最多2000字")
  .option("--from <time>")
  .option("--to <time>")
  .option("--source-id <sha256>")
  .option("--speaker <label>")
  .option("--emotion <label>")
  .option("--keyword <text>")
  .option("--cursor <n>", "游标", "0")
  .option("--max-chars <n>", "最大字数256–8000", "2000")
  .option("--page-size <n>", "词条数1–200", "100")
  .action(async (o) => {
    const q = Read.parse({
      from: time(o.from),
      to: time(o.to),
      sourceId: o.sourceId,
      speaker: o.speaker,
      emotion: o.emotion,
      q: o.keyword,
      cursor: o.cursor,
      maxChars: o.maxChars,
      limit: o.pageSize,
    });
    if (program.opts().dryRun)
      return output({ method: "GET", path: "/v1/transcripts", query: q });
    output(
      await client().read(Filters.parse(q), q.cursor, q.maxChars, q.limit),
    );
  });
transcript
  .command("+submit")
  .description("write · 提交私有音频URL清单；实际计费取决于供应商")
  .requiredOption("--manifest <file>")
  .action(async (o) => {
    const batch = Batch.parse(JSON.parse(readFileSync(o.manifest, "utf8")));
    if (program.opts().dryRun)
      return output({
        method: "POST",
        path: "/v1/transcription-batches",
        recordings: batch.recordings.length,
      });
    output(await client().submit(batch));
  });
transcript
  .command("+pull")
  .description("write-local · 先统计，再分页导出给Rust客户端；不打印正文")
  .requiredOption("--source-id <sha256>")
  .requiredOption("--library <path>")
  .action(async (o) => {
    const filter = Filters.parse({ sourceId: o.sourceId }),
      root = resolve(o.library);
    const index = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
    if (!index.recordings?.some((r: { id: string }) => r.id === o.sourceId))
      throw new Error("Source does not belong to selected library");
    if (program.opts().dryRun)
      return output({
        operation: "pull",
        sourceId: o.sourceId,
        target: join(root, "transcripts", `${o.sourceId}.json`),
      });
    const c = client(),
      stats = await c.stats(filter);
    if (!stats.charCount) throw new Error("No transcript available");
    if (stats.charCount > 2000000)
      throw new Error("Local export exceeds 2M character limit");
    const words = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const page = await c.read({ sourceId: o.sourceId }, cursor, 8000, 200);
      words.push(
        ...page.items.map((r) => ({
          text: r.word.text,
          start: r.word.startMs / 1000,
          end: r.word.endMs / 1000,
          speaker: r.word.speaker,
          emotion: r.word.emotion,
          timing: r.word.timing,
        })),
      );
      cursor = page.nextCursor;
    }
    const dir = join(root, "transcripts");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = join(dir, `.${randomUUID()}.tmp`);
    writeFileSync(
      temp,
      JSON.stringify({ text: words.map((w) => w.text).join(""), words }),
      { mode: 0o600 },
    );
    renameSync(temp, join(dir, `${o.sourceId}.json`));
    output({ saved: true, charCount: stats.charCount, words: words.length });
  });
program
  .command("job")
  .description("read · 查询任务，不返回正文")
  .argument("<id>")
  .action(async (id) => {
    if (program.opts().dryRun)
      return output({ method: "GET", path: `/v1/jobs/${id}` });
    output(await client().job(id));
  });
const auth = program
  .command("auth")
  .description("root Token 登录与状态")
  .action(async () => {
    if (program.opts().dryRun) return output({ method: "GET", path: "/v1/me" });
    output(await client().me());
  });
auth
  .command("status")
  .description("验证当前 root Token，不返回凭据")
  .action(async () =>
    output(
      program.opts().dryRun
        ? { method: "GET", path: "/v1/me" }
        : await client().me(),
    ),
  );
auth
  .command("login")
  .description("从标准输入读取 root Token，验证后保存 YAML")
  .option("--base <url>", "API 地址", "https://xinliqiu.jiarui.ink")
  .requiredOption("--token-stdin", "从 stdin 读取，不能放进命令参数")
  .action(async (o) =>
    output(
      program.opts().dryRun
        ? { operation: "login", base: o.base }
        : await login(o.base, readFileSync(0, "utf8").trim()),
    ),
  );
auth
  .command("logout")
  .description("删除本机保存的 Token，不撤销云端 Token")
  .action(() =>
    output(program.opts().dryRun ? { operation: "logout-local" } : logout()),
  );
program
  .command("self")
  .description("CLI 安装与更新")
  .command("update")
  .description("从发行服务器校验并安装最新版，保留登录")
  .action(() => {
    if (program.opts().dryRun) return output({ operation: "self-update" });
    const installation = JSON.parse(
      readFileSync(asset("install.json"), "utf8"),
    );
    execFileSync(
      process.execPath,
      [
        fileURLToPath(asset("install.mjs")),
        "--prefix",
        installation.prefix,
        "--base",
        installation.base,
      ],
      { stdio: "inherit" },
    );
  });
program
  .command("skill")
  .description("安装 Agent 使用指南")
  .command("install")
  .description("把配套 skill 安装到指定目录")
  .option(
    "--path <path>",
    "skill 目录",
    join(homedir(), ".codex/skills/xinliqiu-cli"),
  )
  .action((o) => {
    const target = resolve(o.path);
    if (program.opts().dryRun)
      return output({ operation: "install-skill", path: target });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "SKILL.md"), readFileSync(asset("SKILL.md")));
    output({ installed: true, path: target });
  });
program
  .command("schema")
  .description("read · 查看OpenAPI operationId")
  .argument("[operation]")
  .action((id) => {
    const spec = JSON.parse(readFileSync(asset("openapi.json"), "utf8"));
    const operations = Object.entries(spec.paths).flatMap(([path, methods]) =>
      Object.entries(methods as Record<string, any>).map(([method, value]) => ({
        path,
        method,
        ...value,
      })),
    );
    output(
      id
        ? (operations.find((o) => o.operationId === id) ?? {
            error: "Unknown operation",
          })
        : operations.map((o) => ({
            operationId: o.operationId,
            path: o.path,
            method: o.method,
          })),
    );
  });
program.parseAsync().catch((e) => {
  console.error(
    JSON.stringify({ error: e instanceof Error ? e.message : "CLI_FAILED" }),
  );
  process.exitCode = 1;
});
