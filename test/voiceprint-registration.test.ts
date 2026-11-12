/** Synthetic enrollment replies verify durable identity registration and unknown-result recovery. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DoubaoVoiceprints } from "../src/doubao-voiceprint.js";
const voiceId = "1b4ff14e-76f0-4bba-9ddc-513078d6539b";
test("enrollment persists before submit and verifies the returned voice before reuse", async () => {
  const root = mkdtempSync(join(tmpdir(), "xq-enrollment-"));
  let creates = 0,
    verifies = 0;
  const request: typeof fetch = async (url, init) => {
    assert.equal(new URL(String(url)).pathname, "/api/proxy/invoke/");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("X-Api-Key"), "synthetic");
    const body = JSON.parse(String(init?.body));
    if (String(url).endsWith("UpdateVoiceprint")) {
      creates++;
      assert.equal(body.SpeakerName, "我");
      assert.equal(body.AudioUrl, "https://private.example/reference");
      return Response.json({ Result: { Code: 1000, SpeakID: voiceId } });
    }
    verifies++;
    assert.deepEqual(body.SpeakIdList, [voiceId]);
    return Response.json({
      Result: {
        Code: 1000,
        AudioEmbedding: [{ SpeakID: voiceId, SpeakerName: "我", Status: 1 }],
      },
    });
  };
  try {
    const registry = new DoubaoVoiceprints(root, request);
    assert.equal(
      await registry.ensure(
        "a",
        "reference",
        "synthetic",
        () => "https://private.example/reference",
      ),
      voiceId,
    );
    assert.equal(
      await new DoubaoVoiceprints(root, request).ensure(
        "a",
        "reference",
        "synthetic",
        () => {
          throw Error("must not upload again");
        },
      ),
      voiceId,
    );
    assert.equal(creates, 1);
    assert.equal(verifies, 1);
    await registry.ensure(
      "b",
      "reference",
      "synthetic",
      () => "https://private.example/reference",
    );
    assert.equal(creates, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("unknown enrollment response cannot be automatically resubmitted", async () => {
  const root = mkdtempSync(join(tmpdir(), "xq-enrollment-"));
  let calls = 0;
  const request: typeof fetch = async () => {
    calls++;
    throw Error("network lost");
  };
  try {
    const registry = new DoubaoVoiceprints(root, request);
    await assert.rejects(
      registry.ensure("a", "ref", "key", () => "https://private.example/a"),
    );
    await assert.rejects(
      new DoubaoVoiceprints(root, request).ensure(
        "a",
        "ref",
        "key",
        () => "https://private.example/a",
      ),
      /REGISTRATION_UNKNOWN/,
    );
    assert.equal(calls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
