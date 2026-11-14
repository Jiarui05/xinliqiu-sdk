/** Verify text replication preserves owner isolation, revision replacement and count-first reads. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Repository } from "../src/infrastructure/database.js";
import { createApp } from "../src/app.js";

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
