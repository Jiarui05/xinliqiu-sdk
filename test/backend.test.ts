/**
 * @file backend.test.ts
 * @description 验证身份隔离、输出预算、供应商契约和异步任务中断恢复。
 *
 * 职责与入口：
 * - 创建隔离的内存数据库和测试身份 → setup()
 * - 写入合成任务及转录，供请求行为验证 → seed()
 *
 * 边界：使用合成数据或本机临时目录验证行为，不调用真实付费模型。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Repository } from "../src/infrastructure/database.js";
import { createApp } from "../src/api/app.js";
import { Filters, Stats, Page } from "../src/contracts.js";
import {
  normalize,
  combine,
  type Provider,
} from "../src/modules/transcription-jobs/providers/qwen.provider.js";
import { tick } from "../src/modules/transcription-jobs/transcription-jobs.worker.js";
const token = "synthetic-application-token-owner-a-12345",
  other = "synthetic-application-token-owner-b-67890";
const source = "a".repeat(64),
  audioUrl = "https://audio.example.test/test.wav";
/** 供应商测试数据只包含合成契约字段，不使用私人录音。 */
const raw = (text = "你好", speaker?: number) => ({
  transcripts: [
    {
      sentences: [
        {
          text,
          begin_time: 0,
          end_time: 1000,
          emotion: "happy",
          ...(speaker === undefined ? {} : { speaker_id: speaker }),
          words: [
            { text: text[0], begin_time: 0, end_time: 500 },
            { text: text.slice(1), begin_time: 500, end_time: 1000 },
          ],
        },
      ],
    },
  ],
});
function setup() {
  const repo = new Repository(":memory:");
  repo.auth.token(token, "a");
  repo.auth.token(other, "b");
  return {
    repo,
    app: createApp(repo, {
      providerConfigured: true,
      audioHosts: ["audio.example.test"],
    }),
  };
}
const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};
async function seed(repo: Repository, text = "你好") {
  repo.jobs.enqueue("a", {
    sourceId: source,
    recordedAt: 100000,
    audioUrl,
    mode: "rich",
  });
  const job = repo.jobs.claim()!;
  repo.jobs.complete(job, normalize(raw(text, 0)));
}

test("authentication, revocation and owner isolation apply to stats and jobs", async () => {
  const { repo, app } = setup();
  await seed(repo);
  assert.equal((await app.request("/v1/transcripts/stats")).status, 401);
  const response = await app.request("/v1/transcripts/stats", { headers });
  const stats = Stats.parse(await response.json());
  assert.equal(stats.charCount, 2);
  assert.equal("text" in stats, false);
  const hidden = await app.request("/v1/transcripts/stats", {
    headers: { Authorization: `Bearer ${other}` },
  });
  assert.equal((await hidden.json()).charCount, 0);
  assert.equal(
    (
      await app.request(`/v1/transcripts?sourceId=${source}`, {
        headers: { Authorization: `Bearer ${other}` },
      })
    ).status,
    200,
  );
  await app.request("/v1/auth/logout", { method: "POST", headers });
  assert.equal((await app.request("/v1/me", { headers })).status, 401);
  repo.db.close();
});
test("root reads are bounded and support phrase/time filters without a query credential", async () => {
  const { repo, app } = setup();
  await seed(repo, "你" + "好".repeat(1200));
  const stats = repo.transcripts.stats(
    "a",
    Filters.parse({ q: "你好", from: 100000, to: 101001 }),
  );
  assert.equal(stats.charCount, 1201);
  const first = Page.parse(
    await (
      await app.request(`/v1/transcripts?maxChars=256`, { headers })
    ).json(),
  );
  assert.ok(first.charCount <= 256);
  assert.equal(first.truncated, true);
  let n = first.charCount,
    cursor = first.nextCursor;
  while (cursor !== null) {
    const page = repo.transcripts.read(
      "a",
      Filters.parse({}),
      cursor,
      256,
      100,
    );
    assert.ok(page.items.length);
    n += page.charCount;
    cursor = page.nextCursor;
  }
  assert.equal(n, 1201);
  assert.equal(
    (await app.request(`/v1/transcripts?maxChars=999999`, { headers })).status,
    400,
  );
  assert.ok(
    repo.transcripts.read("a", Filters.parse({}), 0, 2000, 100).items.length,
  );
  repo.db.close();
});
test("root tokens do not expire automatically and direct reads need no stats request", async () => {
  const { repo, app } = setup();
  await seed(repo);
  assert.equal(
    repo.db.prepare("SELECT min(expires) n FROM tokens").get()!.n,
    Number.MAX_SAFE_INTEGER,
  );
  const page = await (await app.request("/v1/transcripts", { headers })).json();
  assert.equal(page.charCount, 2);
  assert.equal(
    page.items.map((r: { word: { text: string } }) => r.word.text).join(""),
    "你好",
  );
  assert.equal(
    Object.hasOwn(
      repo.transcripts.stats("a", Filters.parse({})),
      "inspectionId",
    ),
    false,
  );
  repo.auth.revoke(token);
  assert.equal((await app.request("/v1/transcripts", { headers })).status, 401);
  repo.db.close();
});
test("batch submissions deduplicate, reject conflicting metadata and disallow unapproved hosts", async () => {
  const { repo, app } = setup();
  const body = {
    recordings: [{ sourceId: source, recordedAt: 1, audioUrl, mode: "rich" }],
  };
  const submit = () =>
    app.request("/v1/transcription-batches", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  const a = await (await submit()).json(),
    b = await (await submit()).json();
  assert.equal(a.jobs[0].id, b.jobs[0].id);
  body.recordings[0].recordedAt = 2;
  assert.equal((await submit()).status, 409);
  body.recordings[0].audioUrl = "https://localhost/audio";
  assert.equal((await submit()).status, 400);
  repo.db.close();
});
test("a rich job submits two different capabilities then persists normalized words", async () => {
  const repo = new Repository(":memory:");
  repo.jobs.enqueue("a", {
    sourceId: source,
    recordedAt: 1,
    audioUrl,
    mode: "rich",
  });
  const submissions: string[] = [];
  const provider: Provider = {
    submit: async (_r, p) => {
      submissions.push(p);
      return p;
    },
    poll: async (_id, p) => raw("你好", p === "speakers" ? 1 : undefined),
  };
  await tick(repo, provider);
  assert.deepEqual(submissions, ["emotion", "speakers"]);
  const stats = repo.transcripts.stats(
    "a",
    Filters.parse({ speaker: "1", emotion: "happy" }),
  );
  assert.equal(stats.charCount, 2);
  assert.equal(
    repo.transcripts.read("a", Filters.parse({}), 0, 2000, 100).items[0].word
      .speakerSource,
    "overlap",
  );
  repo.db.close();
});
test("submission timeout is not retried, and expired submitting lease becomes unknown", async () => {
  const repo = new Repository(":memory:");
  repo.jobs.enqueue("a", {
    sourceId: source,
    recordedAt: 1,
    audioUrl,
    mode: "emotion",
  });
  let submits = 0;
  const provider: Provider = {
    submit: async () => {
      submits++;
      throw new Error("timeout with private URL");
    },
    poll: async () => null,
  };
  await tick(repo, provider);
  await tick(repo, provider);
  assert.equal(submits, 1);
  const row = repo.db.prepare("SELECT state,error FROM jobs").get();
  assert.equal(row?.state, "submission_unknown");
  assert.ok(!String(row?.error).includes("private"));
  repo.db.prepare("UPDATE jobs SET state='submitting',lease=0").run();
  assert.equal(repo.jobs.claim(), undefined);
  assert.equal(
    repo.db.prepare("SELECT state FROM jobs").get()?.state,
    "submission_unknown",
  );
  repo.db.close();
});
test("known provider task resumes without a second submission after worker interruption", async () => {
  const repo = new Repository(":memory:");
  repo.jobs.enqueue("a", {
    sourceId: source,
    recordedAt: 1,
    audioUrl,
    mode: "emotion",
  });
  const job = repo.jobs.claim()!;
  repo.jobs.update(job, "running", { emotion: "saved-task" }, {});
  let submits = 0;
  await tick(repo, {
    submit: async () => {
      submits++;
      return "unexpected";
    },
    poll: async (id) => {
      assert.equal(id, "saved-task");
      return raw();
    },
  });
  assert.equal(submits, 0);
  assert.equal(
    repo.db.prepare("SELECT state FROM jobs").get()?.state,
    "completed",
  );
  repo.db.close();
});
test("word-level spans are preserved, missing timestamps and ambiguous speakers are not fabricated", () => {
  const sentence = {
    transcripts: [
      {
        sentences: [
          {
            text: "中文词语",
            begin_time: 10,
            end_time: 30,
            emotion: "unrecognized",
          },
        ],
      },
    ],
  };
  const words = normalize(sentence);
  assert.equal(words[0].timing, "sentence");
  assert.equal(words[0].emotion, null);
  assert.throws(() =>
    normalize({ transcripts: [{ sentences: [{ text: "bad" }] }] }),
  );
  const ambiguous = {
    transcripts: [
      {
        sentences: [
          { text: "a", begin_time: 0, end_time: 1000, speaker_id: 0 },
          { text: "b", begin_time: 0, end_time: 1000, speaker_id: 1 },
        ],
      },
    ],
  };
  assert.equal(combine(raw(), ambiguous)[0].speaker, null);
});

test("retranscription replaces affected sources and rolls back invalid output", async () => {
  const { repo } = setup();
  await seed(repo, "旧文字");
  const snapshot = repo.transcripts.stats("a", Filters.parse({}));
  repo.jobs.enqueue("b", {
    sourceId: source,
    recordedAt: 100000,
    audioUrl,
    mode: "rich",
  });
  repo.jobs.complete(repo.jobs.claim()!, normalize(raw("其他人", 0)));
  repo.jobs.enqueue("a", {
    sourceId: "b".repeat(64),
    recordedAt: 100000,
    audioUrl,
    mode: "rich",
    sources: [
      { sourceId: source, recordedAt: 100000, offsetMs: 0, durationMs: 1000 },
    ],
  });
  repo.jobs.complete(repo.jobs.claim()!, normalize(raw("新结果", 0)));
  assert.equal(repo.transcripts.stats("a", Filters.parse({})).charCount, 3);
  assert.equal(repo.transcripts.stats("b", Filters.parse({})).charCount, 3);
  assert.equal(
    repo.transcripts
      .read("a", Filters.parse({}), 0, 2000, 100)
      .items.map((r) => r.word.text)
      .join(""),
    "新结果",
  );
  repo.jobs.enqueue("a", {
    sourceId: "c".repeat(64),
    recordedAt: 100000,
    audioUrl,
    mode: "rich",
    sources: [
      { sourceId: source, recordedAt: 100000, offsetMs: 0, durationMs: 1000 },
    ],
  });
  assert.throws(
    () =>
      repo.jobs.complete(repo.jobs.claim()!, [
        { ...normalize(raw("错字", 0))[0], startMs: 2000, endMs: 2500 },
      ]),
    /TIMESTAMP_OUTSIDE/,
  );
  assert.equal(repo.transcripts.stats("a", Filters.parse({})).charCount, 3);
  repo.db.close();
});

test("transient result-query failures retry the same task without a second paid submission", async () => {
  const { repo } = setup();
  let submits = 0,
    polls = 0;
  const provider: Provider = {
    passes: () => ["transcription"],
    async submit() {
      submits++;
      return "known-provider-task";
    },
    async poll(id) {
      assert.equal(id, "known-provider-task");
      if (++polls < 3) throw new TypeError("fetch failed");
      return normalize(raw("恢复", 1));
    },
    finish: (r) => r.transcription as any,
  };
  repo.jobs.enqueue("a", {
    sourceId: source,
    recordedAt: 100000,
    audioUrl,
    mode: "rich",
  });
  for (let i = 0; i < 3; i++) {
    repo.db.prepare("UPDATE jobs SET lease=0").run();
    await tick(repo, provider);
  }
  assert.equal(submits, 1);
  assert.equal(
    repo.db.prepare("SELECT state FROM jobs").get()!.state,
    "completed",
  );
  repo.db.close();
});

test("persistent result-query failures stop after bounded retries without resubmitting", async () => {
  const { repo } = setup();
  let submits = 0;
  const provider: Provider = {
    passes: () => ["transcription"],
    async submit() {
      submits++;
      return "existing";
    },
    async poll() {
      throw new TypeError("fetch failed");
    },
  };
  repo.jobs.enqueue("a", {
    sourceId: source,
    recordedAt: 1,
    audioUrl,
    mode: "rich",
  });
  for (let i = 0; i < 4; i++) {
    repo.db.prepare("UPDATE jobs SET lease=0").run();
    await tick(repo, provider);
  }
  assert.equal(submits, 1);
  const row = repo.db.prepare("SELECT state,error FROM jobs").get()!;
  assert.equal(row.state, "failed");
  assert.equal(row.error, "PROVIDER_NETWORK_ERROR");
  repo.db.close();
});
