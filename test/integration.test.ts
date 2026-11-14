/** Exercise generated HTTP client, actual CLI subprocess, private sidecar export together. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { serve } from "@hono/node-server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repository } from "../src/infrastructure/database.js";
import { createApp } from "../src/api/app.js";
import { Client } from "../src/cli/client.js";
const exec = promisify(execFile);
test("HTTP → generated client → CLI → bounded sidecar", async () => {
  const repo = new Repository(":memory:"),
    token = "synthetic-integration-token-not-a-real-secret",
    id = "b".repeat(64);
  repo.auth.token(token, "local");
  repo.jobs.enqueue("local", {
    sourceId: id,
    audioUrl: "https://example.test/a.wav",
    recordedAt: 1000,
    mode: "emotion",
  });
  repo.jobs.complete(repo.jobs.claim()!, [
    {
      text: "测试",
      startMs: 500,
      endMs: 1000,
      speaker: null,
      emotion: "neutral",
      timing: "word",
      speakerSource: "unknown",
    },
  ]);
  const app = createApp(repo, { providerConfigured: false, audioHosts: [] });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => server.on("listening", r));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  process.env.XQ_API_URL = base;
  const env = { ...process.env, XQ_TOKEN: token, XQ_API_URL: base };
  const folder = mkdtempSync(join(tmpdir(), "xq-transcript-test-"));
  try {
    const c = new Client(token);
    assert.equal((await c.me()).owner, "local");
    const stats = await c.stats({ sourceId: id });
    assert.equal(stats.charCount, 2);
    assert.equal((await c.read({ sourceId: id })).items[0].word.startMs, 500);
    assert.equal((await fetch(`${base}/docs`)).status, 200);
    assert.ok(
      (await (await fetch(`${base}/openapi.json`)).json()).paths[
        "/v1/transcripts"
      ],
    );
    const inspection = JSON.parse(
      (
        await exec(
          process.execPath,
          [
            "--import",
            "tsx",
            "src/cli/main.ts",
            "transcript",
            "+inspect",
            "--source-id",
            id,
          ],
          { env },
        )
      ).stdout,
    );
    assert.equal(inspection.charCount, 2);
    assert.equal(inspection.text, undefined);
    writeFileSync(
      join(folder, "state.json"),
      JSON.stringify({ recordings: [{ id }] }),
    );
    const pulled = await exec(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli/main.ts",
        "transcript",
        "+pull",
        "--source-id",
        id,
        "--library",
        folder,
      ],
      { env },
    );
    assert.ok(!pulled.stdout.includes("测试"));
    const local = JSON.parse(
      readFileSync(join(folder, "transcripts", `${id}.json`), "utf8"),
    );
    assert.equal(local.words[0].start, 0.5);
    assert.equal(local.words[0].timing, "word");
    const dry = await exec(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli/main.ts",
        "--dry-run",
        "transcript",
        "+inspect",
      ],
      { env: { ...env, XQ_API_URL: "http://127.0.0.1:1", XQ_TOKEN: "" } },
    );
    assert.equal(JSON.parse(dry.stdout).method, "GET");
  } finally {
    server.close();
    repo.db.close();
    delete process.env.XQ_API_URL;
    rmSync(folder, { recursive: true, force: true });
  }
});
