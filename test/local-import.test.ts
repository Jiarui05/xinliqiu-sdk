/**
 * @file local-import.test.ts
 * @description 验证本机批量导入保留真实时间空白，并使用绑定模型的私有上传。
 *
 * 职责与入口：
 * - 行为回归验证 → 本文件的 test() 用例
 *
 * 边界：使用合成数据或本机临时目录验证行为，不调用真实付费模型。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  mappedWords,
  validateSources,
  type JobInput,
} from "../src/modules/transcription-jobs/transcription-jobs.types.js";
import { temporaryUpload } from "../src/infrastructure/storage/temporary-upload.js";
import { DashScope } from "../src/modules/transcription-jobs/providers/qwen.provider.js";
const sources = [
  { sourceId: "a".repeat(64), recordedAt: 1000, offsetMs: 0, durationMs: 1000 },
  {
    sourceId: "b".repeat(64),
    recordedAt: 9000,
    offsetMs: 1000,
    durationMs: 1000,
  },
];
test("concatenation mapping preserves gaps, boundary tokens, and per-batch speaker scope", () => {
  const input: JobInput = {
    sourceId: "c".repeat(64),
    recordedAt: 1000,
    audioUrl: "https://audio.example.test/a",
    mode: "rich",
    sources,
  };
  const rows = mappedWords(input, [
    {
      text: "字",
      startMs: 1000,
      endMs: 1300,
      speaker: "0",
      emotion: "neutral",
      timing: "character",
      speakerSource: "overlap",
    },
  ]);
  assert.equal(rows[0].sourceId, sources[1].sourceId);
  assert.equal(rows[0].recordedAt + rows[0].word.startMs, 9000);
  assert.equal(rows[0].word.endMs, 300);
  assert.equal(rows[0].word.speaker, "cccccccccccc:0");
  assert.throws(() => validateSources([sources[1]]), /SOURCE_MAP/);
  assert.throws(
    () =>
      validateSources([
        sources[0],
        { ...sources[1], sourceId: sources[0].sourceId },
      ]),
    /SOURCE_MAP/,
  );
});
test("temporary upload is private and model bound, with no API key on OSS POST", async () => {
  const original = globalThis.fetch,
    folder = mkdtempSync(join(tmpdir(), "xq-upload-"));
  const file = join(folder, "input.flac");
  writeFileSync(file, "synthetic");
  let posts = 0;
  globalThis.fetch = async (input, init) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/uploads")) {
      assert.equal(u.searchParams.get("model"), "fun-asr");
      return Response.json({
        data: {
          policy: "synthetic",
          signature: "synthetic",
          upload_dir: "dashscope-instant/test",
          upload_host:
            "https://dashscope-file-test.oss-cn-beijing.aliyuncs.com",
          max_file_size_mb: 100,
          oss_access_key_id: "synthetic",
          x_oss_object_acl: "private",
          x_oss_forbid_overwrite: "true",
        },
      });
    }
    posts++;
    assert.equal(new Headers(init?.headers).has("Authorization"), false);
    const form = init?.body as FormData;
    assert.equal(form.get("x-oss-object-acl"), "private");
    assert.equal([...form.keys()].at(-1), "file");
    return new Response("", { status: 200 });
  };
  try {
    const url = await temporaryUpload(
      "https://workspace.example.test/api/v1",
      "synthetic",
      "fun-asr",
      file,
    );
    assert.ok(url.startsWith("oss://dashscope-instant/test/"));
    assert.equal(posts, 1);
  } finally {
    globalThis.fetch = original;
    rmSync(folder, { recursive: true, force: true });
  }
});
test("each ASR pass selects its own temporary URL and enables resolver", async () => {
  const original = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = async (_input, init) => {
    assert.equal(
      new Headers(init?.headers).get("X-DashScope-OssResourceResolve"),
      "enable",
    );
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ output: { task_id: "synthetic" } });
  };
  try {
    const p = new DashScope(
      "https://workspace.example.test/api/v1",
      "synthetic",
      [],
    );
    const input: JobInput = {
      sourceId: "a".repeat(64),
      recordedAt: 0,
      audioUrl: "https://example.test/unused",
      mode: "rich",
      temporaryUrls: {
        emotion: "oss://dashscope-instant/qwen/a.flac",
        speakers: "oss://dashscope-instant/fun/a.flac",
      },
    };
    await p.submit(input, "emotion");
    await p.submit(input, "speakers");
    assert.equal(bodies[0].input.file_url, input.temporaryUrls!.emotion);
    assert.equal(bodies[1].input.file_urls[0], input.temporaryUrls!.speakers);
  } finally {
    globalThis.fetch = original;
  }
});

test("concurrent workers keep source clocks when publishing a batch", async () => {
  const { Repository } = await import("../src/infrastructure/database.js");
  const { Filters } = await import("../src/contracts.js");
  const { tick } =
    await import("../src/modules/transcription-jobs/transcription-jobs.worker.js");
  const repo = new Repository(":memory:");
  const input: JobInput = {
    sourceId: "e".repeat(64),
    recordedAt: 1000,
    audioUrl: "https://audio.example.test/a",
    mode: "emotion",
    sources,
  };
  repo.jobs.enqueue("local", input);
  let submissions = 0;
  const provider = {
    submit: async () => {
      submissions++;
      await new Promise((r) => setTimeout(r, 5));
      return "task";
    },
    poll: async () => ({
      transcripts: [
        {
          sentences: [
            {
              text: "字",
              begin_time: 1100,
              end_time: 1200,
              words: [{ text: "字", begin_time: 1100, end_time: 1200 }],
            },
          ],
        },
      ],
    }),
  };
  await Promise.all([tick(repo, provider), tick(repo, provider)]);
  assert.equal(submissions, 1);
  const count = repo.transcripts.stats(
    "local",
    Filters.parse({ from: 9000, to: 10000 }),
  );
  assert.equal(count.charCount, 1);
  const page = repo.transcripts.read(
    "local",
    Filters.parse({ from: 9000, to: 10000 }),
    0,
    256,
    10,
  );
  assert.equal(page.items[0].sourceId, sources[1].sourceId);
  assert.equal(page.items[0].word.startMs, 100);
  repo.db.close();
});
