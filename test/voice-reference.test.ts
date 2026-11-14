/**
 * @file voice-reference.test.ts
 * @description 用合成音频验证格式、用户隔离和身份模式，不录制或上传真人声音。
 *
 * 职责与入口：
 * - 构造 PCM 静音仅用于格式验证，不用于声纹匹配 → wav()
 *
 * 边界：使用合成数据或本机临时目录验证行为，不调用真实付费模型。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VoiceReferences,
  validateReference,
} from "../src/modules/voice-identity/voice-identity.service.js";
import { TranscriptionConfigs } from "../src/modules/provider-settings/provider-settings.service.js";
import {
  TencentTranscription,
  tencentWords,
} from "../src/modules/transcription-jobs/providers/registry.factory.js";
/** 构造 PCM 静音仅用于格式验证，不用于声纹匹配。 */
function wav(seconds = 10) {
  const b = Buffer.alloc(44 + seconds * 32000);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(b.length - 44, 40);
  return b;
}
test("reference validation checks payload length, sample format and real duration", () => {
  assert.equal(validateReference(wav()), 10);
  assert.throws(() => validateReference(wav(9)));
  assert.throws(() => validateReference(wav(31)));
  const b = wav();
  b.writeUInt16LE(2, 22);
  assert.throws(() => validateReference(b));
  assert.throws(() => validateReference(wav().subarray(0, 100)));
});
test("private reference cannot be used by another owner or unsupported provider/model", async () => {
  const root = mkdtempSync(join(tmpdir(), "xq-voice-"));
  let uploads = 0;
  try {
    const voices = new VoiceReferences(join(root, "voices"), {
      async put(key, audio) {
        assert.match(key, /^voice-references\//);
        assert.equal(validateReference(audio), 10);
        uploads++;
      },
      url() {
        return "https://private.example.test/sample?temporary=signature";
      },
    });
    const reference = await voices.save("alice", wav().toString("base64"));
    assert.equal(uploads, 1);
    assert.deepEqual(
      await voices.save("alice", wav().toString("base64")),
      reference,
    );
    assert.equal(uploads, 1);
    assert.throws(() => voices.get("bob", reference.id));
    const configs = new TranscriptionConfigs(join(root, "configs"), voices);
    const input = {
      provider: "tencent",
      model: "16k_zh_en_2.0",
      credentials: { secretId: "id", secretKey: "secret" },
      voiceIdentity: { enabled: true, referenceId: reference.id },
    };
    const saved = configs.save("alice", input);
    assert.equal(saved.voiceIdentity.enabled, true);
    assert.ok(!JSON.stringify(saved).includes("key"));
    assert.throws(() => configs.save("bob", input));
    assert.throws(() => configs.save("alice", { ...input, model: "16k_zh" }));
    assert.throws(() =>
      configs.save("alice", {
        ...input,
        provider: "qwen",
        credentials: { apiKey: "key" },
      }),
    );
    const disabled = configs.save("alice", {
      ...input,
      voiceIdentity: { enabled: false },
    });
    assert.equal(disabled.voiceIdentity.enabled, false);
    assert.equal(configs.get("alice", saved.id).voiceIdentity?.enabled, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("missing storage cannot accept a sample", async () => {
  const root = mkdtempSync(join(tmpdir(), "xq-voice-"));
  try {
    await assert.rejects(
      new VoiceReferences(root).save("a", wav().toString("base64")),
      /STORAGE_NOT_CONFIGURED/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("Tencent role mode sends a fresh reference URL and preserves the named speaker", async () => {
  const config = {
    id: "revision",
    provider: "tencent" as const,
    model: "16k_zh_en_2.0",
    credentials: { secretId: "id", secretKey: "secret", region: "ap-beijing" },
    voiceIdentity: { enabled: true },
  };
  let body: any;
  const request: typeof fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ Response: { Data: { TaskId: 1 } } });
  };
  const provider = new TencentTranscription(
    config,
    request,
    () => "https://private.example.test/signed.wav",
  );
  await provider.submit({
    sourceId: "a".repeat(64),
    audioUrl: "https://audio.example.test/a.wav",
    recordedAt: 1,
    mode: "rich",
  });
  assert.equal(body.SpeakerDiarization, 3);
  assert.equal(
    tencentWords([
      { StartMs: 0, EndMs: 1000, FinalSentence: "测试", SpeakerId: "我" },
    ])[0].speaker,
    "我",
  );
  assert.deepEqual(body.SpeakerRoles, [
    { RoleAudioUrl: "https://private.example.test/signed.wav", RoleName: "我" },
  ]);
  await assert.rejects(
    new TencentTranscription(config, request).submit({
      sourceId: "a".repeat(64),
      audioUrl: "https://audio.example.test/a.wav",
      recordedAt: 1,
      mode: "rich",
    }),
    /NOT_READY/,
  );
});

/** 远程注册失败时，不得启用尚未完整配置的身份模式。 */
test("Doubao voice save activates only after verified enrollment and preserves previous config on failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "xq-voice-save-"));
  const original = globalThis.fetch;
  const voiceId = "1b4ff14e-76f0-4bba-9ddc-513078d6539b";
  let fail = true,
    creates = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("UpdateVoiceprint")) {
      creates++;
      if (fail) throw Error("lost reply");
      return Response.json({ Result: { Code: 1000, SpeakId: voiceId } });
    }
    return Response.json({
      Result: {
        Code: 1000,
        AudioEmbedding: [{ SpeakId: voiceId, SpeakerName: "我", Status: 1 }],
      },
    });
  };
  try {
    const voices = new VoiceReferences(join(root, "voices"), {
      async put() {},
      url() {
        return "https://private.example/sample";
      },
    });
    const ref = await voices.save("local", wav().toString("base64"));
    const configs = new TranscriptionConfigs(join(root, "configs"), voices);
    const initial = configs.save("local", {
      provider: "doubao",
      model: "bigmodel",
      credentials: { apiKey: "key" },
    });
    const input = {
      provider: "doubao",
      model: "bigmodel",
      credentials: {},
      voiceIdentity: { enabled: true, referenceId: ref.id },
    };
    await assert.rejects(configs.saveWithVoice("local", input));
    assert.equal(configs.active("local")!.id, initial.id);
    await assert.rejects(configs.saveWithVoice("local", input), /UNKNOWN/);
    assert.equal(creates, 1);
    fail = false;
    const changed = wav(11);
    changed[44] = 1;
    const next = await voices.save("local", changed.toString("base64"));
    const saved = await configs.saveWithVoice("local", {
      ...input,
      voiceIdentity: { enabled: true, referenceId: next.id },
    });
    assert.equal(saved.voiceIdentity.enabled, true);
    assert.equal(configs.active("local")!.voiceprintId, voiceId);
    await configs.saveWithVoice("local", {
      ...input,
      voiceIdentity: { enabled: true, referenceId: next.id },
    });
    assert.equal(creates, 2);
  } finally {
    globalThis.fetch = original;
    rmSync(root, { recursive: true, force: true });
  }
});
