/**
 * @file transcript-mirror.test.ts
 * @description 验证文字同步的用户隔离、幂等替换和有界读取。
 *
 * 职责与入口：
 * - 行为回归验证 → 本文件的 test() 用例
 *
 * 边界：使用合成数据或本机临时目录验证行为，不调用真实付费模型。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Repository } from "../src/infrastructure/database.js";
import { createApp } from "../src/api/app.js";

test("mirror is authenticated, idempotent and never schedules ASR", async () => {
  const repo = new Repository(":memory:");
  const token = "synthetic-cloud-mirror-token-000000000";
  const other = "synthetic-cloud-mirror-token-111111111";
  repo.auth.token(token, "a");
  repo.auth.token(other, "b");
  const app = createApp(repo, { providerConfigured: false, audioHosts: [] });
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const source = {
    sourceId: "a".repeat(64),
    recordedAt: 1000,
    words: [
      {
        text: "我的话",
        startMs: 0,
        endMs: 1500,
        speaker: "我",
        emotion: null,
        timing: "word",
        speakerSource: "voiceprint",
      },
    ],
  };
  const send = (value: unknown, h = headers) =>
    app.request("/v1/transcripts/mirror", {
      method: "POST",
      headers: h,
      body: JSON.stringify({ transcripts: [value] }),
    });
  assert.equal(
    (
      await send(source, {
        "Content-Type": "application/json",
      } as typeof headers)
    ).status,
    401,
  );
  assert.deepEqual(await (await send(source)).json(), {
    changed: 1,
    received: 1,
  });
  const stats = await (
    await app.request("/v1/transcripts/stats", { headers })
  ).json();
  assert.equal(stats.charCount, 3);
  assert.deepEqual(await (await send(source)).json(), {
    changed: 0,
    received: 1,
  });
  assert.equal(
    (
      await app.request("/v1/transcripts", {
        headers,
      })
    ).status,
    200,
  );
  assert.equal(
    (await send({ ...source, words: [{ ...source.words[0], startMs: -1 }] }))
      .status,
    400,
  );
  assert.equal(
    (
      await (
        await app.request("/v1/transcripts/stats", {
          headers: { Authorization: `Bearer ${other}` },
        })
      ).json()
    ).charCount,
    0,
  );
  await send({ ...source, words: [] });
  assert.equal(
    (
      await app.request("/v1/transcripts", {
        headers,
      })
    ).status,
    200,
  );
  assert.equal(
    (await (await app.request("/v1/transcripts/stats", { headers })).json())
      .charCount,
    0,
  );
  assert.equal(repo.db.prepare("SELECT count(*) n FROM jobs").get()!.n, 0);
  repo.db.close();
});
