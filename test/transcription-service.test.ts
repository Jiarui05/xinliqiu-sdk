/** Exercise provider switching, secret redaction and real wire-format normalization without paid requests. */
import { createHash, randomUUID } from "node:crypto";
import YAML from "yaml";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  statSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptionConfigs } from "../src/modules/provider-settings/service.js";
import {
  TencentTranscription,
  DoubaoTranscription,
} from "../src/modules/transcription-jobs/providers/registry.js";
import { Repository } from "../src/infrastructure/database.js";
import { createApp } from "../src/app.js";
import { tick } from "../src/modules/transcription-jobs/worker.js";
const input = {
  sourceId: "a".repeat(64),
  recordedAt: 1000,
  audioUrl: "https://audio.example.test/a.wav",
  mode: "rich" as const,
};

test("settings API redacts secrets and retains immutable task configuration after switching", async () => {
  const root = mkdtempSync(join(tmpdir(), "xq-config-")),
    store = new TranscriptionConfigs(root),
    repo = new Repository(":memory:");
  const token = "synthetic-test-token-for-provider-settings";
  repo.auth.token(token, "local");
  const app = createApp(repo, {
    providerConfigured: false,
    audioHosts: ["audio.example.test"],
    services: store,
  });
  const headers = {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  };
  try {
    assert.equal((await app.request("/v1/transcription-service")).status, 401);
    let r = await app.request("/v1/transcription-service", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        provider: "tencent",
        model: "16k_zh",
        credentials: {
          secretId: "test-id",
          secretKey: "test-secret",
          region: "ap-beijing",
        },
      }),
    });
    assert.equal(r.status, 200);
    const first = await r.json();
    assert.deepEqual(first.secrets, ["secretId", "secretKey"]);
    assert.equal(JSON.stringify(first).includes("test-secret"), false);
    r = await app.request("/v1/transcription-batches", {
      method: "POST",
      headers,
      body: JSON.stringify({ recordings: [input] }),
    });
    assert.equal(r.status, 202);
    const queued = repo.jobs.claim()!;
    assert.equal(JSON.parse(queued.input).serviceConfigId, first.id);
    const second = store.save("local", {
      provider: "qwen",
      model: "qwen3-asr-flash-filetrans",
      credentials: { apiKey: "qwen-test-key" },
    });
    assert.equal(store.active("local")!.id, second.id);
    assert.equal(
      store.get("local", first.id).credentials.secretKey,
      "test-secret",
    );
    assert.throws(() => store.get("other-owner", first.id), /NOT_FOUND/);
    const updated = store.save("local", {
      provider: "tencent",
      model: "16k_zh_en",
      credentials: { secretId: "", secretKey: "" },
    });
    assert.equal(
      store.get("local", updated.id).credentials.secretKey,
      "test-secret",
    );
    assert.equal(statSync(root).mode & 0o777, 0o700);
  } finally {
    repo.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("Tencent adapter signs requests and maps sentence-relative word timestamps", async () => {
  const requests: { action: string; body: any }[] = [];
  const request: typeof fetch = async (_url, init) => {
    const h = new Headers(init!.headers);
    assert.match(
      h.get("Authorization")!,
      /^TC3-HMAC-SHA256 Credential=test-id\//,
    );
    const action = h.get("X-TC-Action")!;
    requests.push({ action, body: JSON.parse(String(init!.body)) });
    return Response.json({
      Response: {
        Data:
          action === "CreateRecTask"
            ? { TaskId: 123 }
            : {
                Status: 2,
                ResultDetail: [
                  {
                    StartMs: 1000,
                    EndMs: 2000,
                    FinalSentence: "你好",
                    SpeakerId: 1,
                    Words: [
                      { Word: "你好", OffsetStartMs: 20, OffsetEndMs: 500 },
                    ],
                  },
                ],
              },
      },
    });
  };
  const provider = new TencentTranscription(
    {
      id: "test",
      provider: "tencent",
      model: "16k_zh",
      credentials: {
        secretId: "test-id",
        secretKey: "test-secret",
        region: "ap-beijing",
      },
    },
    request,
  );
  const id = await provider.submit(input);
  assert.equal(id, "123");
  const words = (await provider.poll(id)) as any[];
  assert.equal(words[0].startMs, 1020);
  assert.equal(words[0].endMs, 1500);
  assert.equal(words[0].speaker, "1");
  assert.equal(requests[0].body.ResTextFormat, 2);
  const repo = new Repository(":memory:");
  try {
    repo.jobs.enqueue("test", input);
    await tick(repo, provider);
    assert.equal(
      repo.db.prepare("select state from jobs").get()!.state,
      "completed",
    );
  } finally {
    repo.db.close();
  }
});
test("Doubao adapter preserves request UUID and waits for pending jobs", async () => {
  let count = 0;
  let requestId = "";
  const request: typeof fetch = async (url, init) => {
    const h = new Headers(init!.headers);
    assert.equal(h.get("X-Api-App-Key"), "app");
    if (String(url).endsWith("/submit")) {
      requestId = h.get("X-Api-Request-Id")!;
      return new Response("{}", {
        headers: { "X-Api-Status-Code": "20000000" },
      });
    }
    assert.equal(h.get("X-Api-Request-Id"), requestId);
    return Response.json(
      {
        result: {
          utterances: [
            {
              text: "测试",
              start_time: 0,
              end_time: 1000,
              additions: { speaker: "2" },
              words: [{ text: "测试", start_time: 10, end_time: 900 }],
            },
          ],
        },
      },
      {
        headers: {
          "X-Api-Status-Code": ++count === 1 ? "20000001" : "20000000",
        },
      },
    );
  };
  const p = new DoubaoTranscription(
    {
      id: "test",
      provider: "doubao",
      model: "bigmodel",
      credentials: {
        appId: "app",
        accessToken: "token",
        resourceId: "volc.bigasr.auc",
      },
    },
    request,
  );
  const id = await p.submit(input);
  assert.equal(typeof id, "string");
  if (typeof id !== "string") throw new Error("Expected asynchronous task");
  assert.equal(await p.poll(id), null);
  const words = (await p.poll(id)) as any[];
  assert.equal(words[0].startMs, 10);
  assert.equal(words[0].speaker, "2");
});

/** Legacy credentials migrate without rotation, remain private and cannot hide corrupt YAML. */
test("provider JSON migration preserves credentials and rejects corrupt YAML", () => {
  const root = mkdtempSync(join(tmpdir(), "xq-config-migrate-"));
  const folder = join(root, createHash("sha256").update("local").digest("hex"));
  mkdirSync(folder);
  const id = randomUUID();
  const config = {
    id,
    provider: "doubao",
    model: "bigmodel",
    credentials: { apiKey: "0123: #synthetic", resourceId: "volc.seedasr.auc" },
  };
  writeFileSync(
    join(folder, "index.json"),
    JSON.stringify({ activeConfigId: id, ids: [id] }),
  );
  writeFileSync(join(folder, id + ".json"), JSON.stringify(config));
  try {
    const store = new TranscriptionConfigs(root);
    assert.deepEqual(store.active("local"), config);
    assert.deepEqual(
      YAML.parse(readFileSync(join(folder, id + ".yaml"), "utf8")),
      config,
    );
    assert.equal(statSync(join(folder, id + ".yaml")).mode & 0o777, 0o600);
    assert.ok(existsSync(join(folder, id + ".json")));
    writeFileSync(join(folder, id + ".yaml"), "broken: [");
    assert.throws(() => store.active("local"), /INVALID_PROVIDER_YAML/);
    assert.equal(readFileSync(join(folder, id + ".yaml"), "utf8"), "broken: [");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
