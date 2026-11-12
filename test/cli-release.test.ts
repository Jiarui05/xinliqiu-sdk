/** Verify a downloaded CLI works outside the checkout, preserves credentials and rejects corrupt updates. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { serve } from "@hono/node-server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readlinkSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Repository } from "../src/repository.js";
import { createApp } from "../src/app.js";
const exec = promisify(execFile);
test("portable install, authenticated read, schema, skill, update and checksum rollback", async () => {
  const repo = new Repository(":memory:"),
    token = "synthetic-portable-cli-root-token-123456789";
  repo.token(token, "local");
  repo.enqueue("local", {
    sourceId: "a".repeat(64),
    recordedAt: 1000,
    audioUrl: "https://example.test/a.wav",
    mode: "emotion",
  });
  repo.complete(repo.claim()!, [
    {
      text: "测试",
      startMs: 0,
      endMs: 1000,
      speaker: "我",
      emotion: null,
      timing: "word",
      speakerSource: "voiceprint",
    },
  ]);
  const releaseRoot = resolve("cli-release"),
    oldRoot = process.env.XQ_CLI_RELEASE_DIR;
  process.env.XQ_CLI_RELEASE_DIR = releaseRoot;
  const app = createApp(repo, { providerConfigured: false, audioHosts: [] });
  let corrupt = false;
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) =>
      corrupt && new URL(req.url).pathname === "/cli/xq.mjs"
        ? new Response("tampered")
        : app.fetch(req),
  });
  await new Promise<void>((r) => server.on("listening", r));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`,
    folder = mkdtempSync(join(tmpdir(), "xq-release-"));
  const config = join(folder, "cloud.yaml"),
    prefix = join(folder, "install space"),
    bin = join(prefix, "bin/xq");
  const env = {
    ...process.env,
    XQ_CLI_CONFIG: config,
    XQ_API_URL: "",
    XQ_TOKEN: "",
    XQ_TOKEN_FILE: "",
  };
  delete (env as Record<string, string | undefined>).XQ_API_URL;
  delete (env as Record<string, string | undefined>).XQ_TOKEN;
  delete (env as Record<string, string | undefined>).XQ_TOKEN_FILE;
  try {
    const installed = await exec(
      process.execPath,
      [resolve("scripts/install-cli.mjs"), "--base", base, "--prefix", prefix],
      { cwd: folder, env },
    );
    assert.equal(JSON.parse(installed.stdout).installed, true);
    const credentialLogin = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [bin, "auth", "login", "--base", base, "--token-stdin"],
        { cwd: folder, env },
        (error, out) => (error ? reject(error) : resolve(out)),
      );
      child.stdin!.end(token);
    });
    assert.equal(JSON.parse(credentialLogin).authenticated, true);
    assert.ok(!credentialLogin.includes(token));
    assert.equal(statSync(config).mode & 0o777, 0o600);
    assert.equal(
      JSON.parse(
        (
          await exec(process.execPath, [bin, "auth", "status"], {
            cwd: folder,
            env,
          })
        ).stdout,
      ).owner,
      "local",
    );
    const page = JSON.parse(
      (
        await exec(
          process.execPath,
          [bin, "transcript", "+read", "--speaker", "我"],
          { cwd: folder, env },
        )
      ).stdout,
    );
    assert.equal(page.charCount, 2);
    assert.equal(page.items[0].word.text, "测试");
    assert.equal(
      JSON.parse(
        (
          await exec(process.execPath, [bin, "schema", "getTranscripts"], {
            cwd: folder,
            env,
          })
        ).stdout,
      ).operationId,
      "getTranscripts",
    );
    await exec(
      process.execPath,
      [bin, "skill", "install", "--path", join(folder, "skill")],
      { cwd: folder, env },
    );
    assert.match(
      readFileSync(join(folder, "skill/SKILL.md"), "utf8"),
      /name: xinliqiu-cli/,
    );
    const before = readFileSync(config, "utf8"),
      current = readlinkSync(join(prefix, "share/xinliqiu-cli/current"));
    await exec(process.execPath, [bin, "self", "update"], { cwd: folder, env });
    assert.equal(readFileSync(config, "utf8"), before);
    corrupt = true;
    await assert.rejects(
      exec(process.execPath, [bin, "self", "update"], { cwd: folder, env }),
    );
    assert.equal(
      readlinkSync(join(prefix, "share/xinliqiu-cli/current")),
      current,
    );
    assert.equal(readFileSync(config, "utf8"), before);
    assert.equal((await fetch(base + "/cli/cloud.yaml")).status, 404);
    assert.equal((await fetch(base + "/v1/transcripts")).status, 401);
    writeFileSync(config, "token: [broken secret-material", { mode: 0o600 });
    await assert.rejects(
      exec(process.execPath, [bin, "auth", "status"], { cwd: folder, env }),
      (e) => !String(e).includes("secret-material"),
    );
  } finally {
    server.close();
    repo.db.close();
    if (oldRoot === undefined) delete process.env.XQ_CLI_RELEASE_DIR;
    else process.env.XQ_CLI_RELEASE_DIR = oldRoot;
    rmSync(folder, { recursive: true, force: true });
  }
});
