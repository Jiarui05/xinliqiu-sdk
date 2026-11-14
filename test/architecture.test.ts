/**
 * @file architecture.test.ts
 * @description 检查模块依赖边界，并验证任务重开后不会重复提交已知供应商任务。
 *
 * 职责与入口：
 * - 只遍历项目源码，不访问用户数据或依赖目录 → files()
 *
 * 边界：使用合成数据或本机临时目录验证行为，不调用真实付费模型。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Repository } from "../src/infrastructure/database.js";
import { tick } from "../src/modules/transcription-jobs/transcription-jobs.worker.js";
import { createApp } from "../src/api/app.js";
/** 只遍历项目源码，不访问用户数据或依赖目录。 */
function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(root, e.name)) : [join(root, e.name)],
  );
}
test("repositories/domain/services do not depend on HTTP and routes contain no SQL", () => {
  for (const path of files("src/api/routes")) {
    assert.doesNotMatch(
      readFileSync(path, "utf8"),
      /\.db\.(?:prepare|exec)\(/,
      path,
    );
  }
  for (const path of files("src/modules").filter((p) => p.endsWith(".ts"))) {
    const code = readFileSync(path, "utf8");
    if (/(?:repository|types|service)\.ts$/.test(path))
      assert.doesNotMatch(
        code,
        /(?:from|import)\s*["'](?:@hono|hono|.*\/(?:http|api)\/)/,
        path,
      );
    if (/(?:route|service)\.ts$/.test(path))
      assert.doesNotMatch(code, /\.db\.(?:prepare|exec)\(/, path);
  }
});
test("reopening legacy durable task state preserves root token and resumes by saved task ID", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xq-reopen-")),
    path = join(dir, "db.sqlite");
  const token = "synthetic-permanent-root-token-for-reopen";
  let repo = new Repository(path);
  try {
    repo.auth.token(token, "local");
    repo.jobs.enqueue("local", {
      sourceId: "b".repeat(64),
      recordedAt: 1,
      audioUrl: "https://example.test/a.wav",
      mode: "emotion",
    });
    const job = repo.jobs.claim()!;
    repo.jobs.update(
      job,
      "running",
      { emotion: "already-submitted" },
      {},
      null,
      0,
    );
    const before = JSON.stringify(repo.db.prepare("SELECT * FROM jobs").all());
    repo.db.close();
    repo = new Repository(path);
    assert.equal(
      JSON.stringify(repo.db.prepare("SELECT * FROM jobs").all()),
      before,
    );
    assert.equal(repo.auth.owner(token), "local");
    let submits = 0;
    await tick(repo, {
      submit: async () => {
        submits++;
        return "bad";
      },
      poll: async (id) => {
        assert.equal(id, "already-submitted");
        return {
          transcripts: [
            {
              sentences: [
                {
                  text: "保留",
                  begin_time: 0,
                  end_time: 100,
                  words: [{ text: "保留", begin_time: 0, end_time: 100 }],
                },
              ],
            },
          ],
        };
      },
    });
    assert.equal(submits, 0);
    assert.equal(
      repo.db.prepare("SELECT state FROM jobs").get()!.state,
      "completed",
    );
  } finally {
    repo.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("unexpected faults return redacted 500 with a correlation ID instead of conflict", async () => {
  const repo = new Repository(":memory:"),
    token = "synthetic-error-envelope-root-token-1234";
  repo.auth.token(token, "local");
  const app = createApp(repo, { providerConfigured: false, audioHosts: [] });
  repo.transcripts.stats = () => {
    throw Error("private-provider-secret");
  };
  const old = console.error;
  const logs: string[] = [];
  console.error = (line) => logs.push(String(line));
  try {
    const r = await app.request("/v1/transcripts/stats", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(r.status, 500);
    const body = await r.json();
    assert.equal(body.error.code, "INTERNAL_ERROR");
    assert.equal(JSON.parse(logs[0]!).requestId, body.error.requestId);
    assert.ok(
      !JSON.stringify([body, logs]).includes("private-provider-secret"),
    );
  } finally {
    console.error = old;
    repo.db.close();
  }
});

test("oversized requests remain a redacted transport rejection", async () => {
  const repo = new Repository(":memory:");
  const app = createApp(repo, { providerConfigured: false, audioHosts: [] });
  const r = await app.request("/v1/transcripts/mirror", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: " ".repeat(2100000),
  });
  assert.equal(r.status, 413);
  assert.equal((await r.json()).error.code, "PAYLOAD_TOO_LARGE");
  repo.db.close();
});

test("手写源码具有中文文件说明，业务文件采用职责后缀", () => {
  for (const file of [
    ...files("src"),
    ...files("scripts"),
    ...files("test"),
    "orval.config.ts",
  ].filter((p) => /\.(ts|mjs)$/.test(p))) {
    const text = readFileSync(file, "utf8");
    const header = text.match(/^(?:#![^\n]*\n)?\s*(\/\*\*[\s\S]*?\*\/)/)?.[1];
    assert.ok(header, file + " 缺少文件头");
    assert.ok(header.includes("@file " + file.split("/").at(-1)), file);
    assert.match(header, /@description[^\n]*[\u4e00-\u9fff]/, file);
    assert.match(header, /职责与入口：/, file);
    assert.match(header, /边界：/, file);
    if (file.startsWith("src/modules/") && !file.includes("/providers/"))
      assert.match(
        file,
        /\.(service|repository|types|schema|policy|worker)\.ts$/,
        file,
      );
    if (file.startsWith("src/api/routes/"))
      assert.match(file, /\.route\.ts$/, file);
  }
});
