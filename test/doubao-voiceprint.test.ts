/** Synthetic provider replies verify enrollment durability, identity preservation and ASR endpoint routing. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { mappedWords } from "../src/modules/transcription-jobs/domain.js";
import { DoubaoVoiceprints } from "../src/modules/voice-identity/enrollment.js";
import {
  DoubaoTranscription,
  doubaoWords,
} from "../src/modules/transcription-jobs/providers/registry.js";
const voiceId = "1b4ff14e-76f0-4bba-9ddc-513078d6539b";
test("identity mode uses standard ASR with private uploaded audio and a fixed voiceprint", async () => {
  const root = mkdtempSync(join(tmpdir(), "xq-identity-asr-"));
  const data = Buffer.from("synthetic verified audio"),
    path = join(root, "a.wav");
  writeFileSync(path, data);
  const sha256 = createHash("sha256").update(data).digest("hex");
  const config = {
    id: "config",
    provider: "doubao" as const,
    model: "bigmodel",
    credentials: { apiKey: "key", resourceId: "volc.seedasr.auc" },
    voiceIdentity: { enabled: true },
    voiceprintId: voiceId,
  };
  const input = {
    sourceId: "a".repeat(64),
    recordedAt: 1,
    audioUrl: "https://local.invalid/a.wav",
    mode: "rich" as const,
    localAudio: { path, sha256 },
  };
  let uploads = 0;
  const request: typeof fetch = async (url, init) => {
    assert.ok(String(url).endsWith("/submit"));
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.request.voiceprints, [{ id: voiceId }]);
    assert.equal(body.request.ssd_version, "300");
    assert.equal(body.audio.url, "https://private.example/signed");
    assert.equal(body.audio.data, undefined);
    return new Response("{}", { headers: { "X-Api-Status-Code": "20000000" } });
  };
  try {
    await assert.rejects(
      new DoubaoTranscription(config, request).submit(input),
      /VOICE_MODE_NOT_READY/,
    );
    const provider = new DoubaoTranscription(config, request, {
      async put(key, bytes) {
        assert.equal(key, `asr-inputs/${sha256}.wav`);
        assert.deepEqual(bytes, data);
        uploads++;
      },
      url() {
        return "https://private.example/signed";
      },
    });
    assert.equal(typeof (await provider.submit(input)), "string");
    assert.equal(uploads, 1);
    const named = doubaoWords({
      utterances: [
        {
          text: "你好",
          start_time: 0,
          end_time: 1000,
          additions: { speaker: "我" },
        },
      ],
    });
    assert.equal(named[0].speaker, "我");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registered self identity stays stable across source maps while anonymous labels stay scoped", () => {
  const raw = {
    utterances: [
      {
        text: "我",
        start_time: 0,
        end_time: 100,
        additions: { speaker: "我" },
      },
    ],
  };
  const confirmed = doubaoWords(raw, voiceId),
    anonymous = doubaoWords(raw);
  const input = {
    sourceId: "a".repeat(64),
    recordedAt: 1,
    audioUrl: "https://example.test/a",
    mode: "rich" as const,
    sources: [
      {
        sourceId: "b".repeat(64),
        recordedAt: 1,
        offsetMs: 0,
        durationMs: 1000,
      },
    ],
  };
  assert.equal(mappedWords(input, confirmed)[0].word.speaker, "我");
  assert.equal(
    mappedWords(input, anonymous)[0].word.speaker,
    "aaaaaaaaaaaa:我",
  );
});
