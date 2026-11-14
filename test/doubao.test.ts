/**
 * @file doubao.test.ts
 * @description 离线验证豆包 API Key 与本机音频路径，不产生云端费用或使用私人声音。
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
import { createHash } from "node:crypto";
import {
  DoubaoTranscription,
  doubaoWords,
} from "../src/modules/transcription-jobs/providers/registry.factory.js";
import { TranscriptionConfigs } from "../src/modules/provider-settings/provider-settings.service.js";
import { Repository } from "../src/infrastructure/database.js";
import { tick } from "../src/modules/transcription-jobs/transcription-jobs.worker.js";
const config = {
  id: "test",
  provider: "doubao" as const,
  model: "bigmodel",
  credentials: { apiKey: "synthetic-key", resourceId: "volc.seedasr.auc" },
};
const input = {
  sourceId: "c".repeat(64),
  recordedAt: 1000,
  audioUrl: "https://audio.example.test/a.wav",
  mode: "rich" as const,
};
test("API key configuration is redacted and rejects unsupported resources", () => {
  const dir = mkdtempSync(join(tmpdir(), "xq-doubao-"));
  try {
    const store = new TranscriptionConfigs(dir);
    const saved = store.save("owner", config);
    assert.deepEqual(saved.secrets, ["apiKey"]);
    assert.ok(!JSON.stringify(saved).includes("synthetic-key"));
    assert.throws(() =>
      store.save("owner", {
        ...config,
        credentials: { apiKey: "k", resourceId: "wrong" },
      }),
    );
    assert.equal(store.active("owner")?.id, saved.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("local turbo upload preserves dialect options and completes durably in one request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xq-doubao-")),
    repo = new Repository(":memory:");
  let calls = 0;
  try {
    const path = join(dir, "sample.wav"),
      bytes = Buffer.from("synthetic audio transport fixture");
    writeFileSync(path, bytes);
    const p = new DoubaoTranscription(config, async (url, init) => {
      calls++;
      assert.match(String(url), /recognize\/flash$/);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("X-Api-Key"), "synthetic-key");
      assert.equal(headers.has("X-Api-App-Key"), false);
      const body = JSON.parse(String(init?.body));
      assert.equal(body.audio.data, bytes.toString("base64"));
      assert.equal(body.audio.url, undefined);
      assert.equal(body.audio.language, undefined);
      assert.equal(body.request.enable_ddc, false);
      assert.equal(body.request.enable_speaker_info, true);
      return Response.json(
        {
          result: {
            utterances: [
              {
                text: "好",
                start_time: 0,
                end_time: 500,
                additions: { speaker: "1" },
                words: [{ text: "好", start_time: 0, end_time: 500 }],
              },
            ],
          },
        },
        { headers: { "X-Api-Status-Code": "20000000" } },
      );
    });
    const job = repo.jobs.enqueue("local", {
      ...input,
      localAudio: {
        path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    });
    await tick(repo, p);
    assert.equal(repo.jobs.job("local", job.id)?.state, "completed");
    await tick(repo, p);
    assert.equal(calls, 1);
    assert.equal(repo.db.prepare("SELECT count(*) n FROM words").get()?.n, 1);
  } finally {
    repo.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("unknown synchronous submission is never automatically repeated", async () => {
  const repo = new Repository(":memory:");
  let calls = 0;
  const p = new DoubaoTranscription(
    {
      ...config,
      credentials: {
        ...config.credentials,
        resourceId: "volc.bigasr.auc_turbo",
      },
    },
    async () => {
      calls++;
      throw new Error("network interrupted");
    },
  );
  try {
    const job = repo.jobs.enqueue("local", input);
    await tick(repo, p);
    assert.equal(repo.jobs.job("local", job.id)?.state, "submission_unknown");
    await tick(repo, p);
    assert.equal(calls, 1);
  } finally {
    repo.db.close();
  }
});
test("provider errors retain only the safe code, never remote URL-bearing messages", async () => {
  const p = new DoubaoTranscription(
    config,
    async () =>
      new Response("", {
        headers: {
          "X-Api-Status-Code": "45000001",
          "X-Api-Message": "secret https://signed.example",
        },
      }),
  );
  await assert.rejects(p.submit(input), {
    message: "PROVIDER_DOUBAO_45000001",
  });
});

test("punctuation stays attached to timed tokens; conflicting text never receives invented word timings", () => {
  const original = {
    text: "好，走。",
    start_time: 0,
    end_time: 1000,
    words: [
      { text: "好", start_time: 10, end_time: 300 },
      { text: "走", start_time: 500, end_time: 900 },
    ],
  };
  const words = doubaoWords({ utterances: [original] });
  assert.deepEqual(
    words.map((w) => w.text),
    ["好，", "走。"],
  );
  assert.equal(words[1].startMs, 500);
  const fallback = doubaoWords({
    utterances: [{ ...original, text: "好的，走。" }],
  });
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].timing, "sentence");
  assert.equal(fallback[0].text, "好的，走。");
});

test("authorization rejection preserves Doubao resource code even with HTTP 403", async () => {
  const p = new DoubaoTranscription(
    config,
    async () =>
      new Response("", {
        status: 403,
        headers: {
          "X-Api-Status-Code": "45000030",
          "X-Api-Message": "private details omitted",
        },
      }),
  );
  await assert.rejects(p.submit(input), {
    message: "PROVIDER_DOUBAO_45000030",
  });
});

test("untimed punctuation is attached once without fabricating a timestamp", () => {
  const words = doubaoWords({
    utterances: [
      {
        text: "你好，世界！",
        start_time: 0,
        end_time: 1000,
        words: [
          { text: "你好", start_time: 100, end_time: 400 },
          { text: "，", start_time: -1, end_time: -1 },
          { text: "世界", start_time: 500, end_time: 900 },
          { text: "！", start_time: -1, end_time: -1 },
        ],
      },
    ],
  });
  assert.equal(words.map((w) => w.text).join(""), "你好，世界！");
  assert.deepEqual(
    words.map((w) => [w.startMs, w.endMs]),
    [
      [100, 400],
      [500, 900],
    ],
  );
});
test("untimed speech falls back to the provider sentence interval", () => {
  const words = doubaoWords({
    utterances: [
      {
        text: "你好",
        start_time: 100,
        end_time: 900,
        words: [{ text: "你好", start_time: -1, end_time: -1 }],
      },
    ],
  });
  assert.equal(words[0].timing, "sentence");
  assert.equal(words[0].startMs, 100);
});
