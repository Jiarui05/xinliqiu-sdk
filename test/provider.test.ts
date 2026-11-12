/** Verify the actual HTTP adapter against documented provider wire shapes without uploading any audio. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DashScope } from "../src/provider.js";
test("Qwen/Fun payloads and result-file credential isolation", async () => {
  const original = globalThis.fetch;
  const requests: { url: string; body: any; authorization: unknown }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      authorization: (init?.headers as Record<string, string> | undefined)
        ?.Authorization,
    });
    if (url.endsWith("/transcription"))
      return Response.json({ output: { task_id: "task" } });
    if (url.includes("/tasks/"))
      return Response.json({
        output: {
          task_status: "SUCCEEDED",
          result: { transcription_url: "https://results.example.test/r.json" },
          results: [
            {
              subtask_status: "SUCCEEDED",
              transcription_url: "https://results.example.test/r.json",
            },
          ],
        },
      });
    return Response.json({ transcripts: [{ sentences: [] }] });
  };
  try {
    const provider = new DashScope(
      "https://workspace.example.test/api/v1",
      "synthetic-provider-key",
      ["results.example.test"],
    );
    const input = {
      sourceId: "a".repeat(64),
      recordedAt: 1,
      audioUrl: "https://audio.example.test/a.wav",
      mode: "rich" as const,
    };
    await provider.submit(input, "emotion");
    await provider.submit(input, "speakers");
    await provider.poll("task", "emotion");
    await provider.poll("task", "speakers");
    assert.equal(requests[0].body.input.file_url, input.audioUrl);
    assert.equal(requests[0].body.parameters.enable_words, true);
    assert.equal(requests[1].body.input.file_urls.length, 1);
    assert.equal(requests[1].body.parameters.diarization_enabled, true);
    assert.ok(
      requests
        .filter((r) => r.url.includes("results.example"))
        .every((r) => r.authorization === undefined),
    );
    await assert.rejects(
      new DashScope(
        "https://workspace.example.test/api/v1",
        "synthetic",
        [],
      ).poll("task", "emotion"),
      /RESULT_HOST/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("vendor HTTP result links use TLS without forwarding the API key", async () => {
  const original = globalThis.fetch;
  const host = "dashscope-result-bj.oss-cn-beijing.aliyuncs.com";
  let resultUrl = `http://${host}/result.json?Signature=synthetic%2Bvalue`;
  const downloads: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/tasks/"))
      return Response.json({
        output: {
          task_status: "SUCCEEDED",
          result: { transcription_url: resultUrl },
        },
      });
    downloads.push(url);
    assert.equal(new Headers(init?.headers).has("Authorization"), false);
    assert.equal(init?.redirect, "error");
    return Response.json({ transcripts: [{ sentences: [] }] });
  };
  try {
    const provider = new DashScope(
      "https://workspace.example.test/api/v1",
      "synthetic",
      [host],
    );
    await provider.poll("task", "emotion");
    assert.deepEqual(downloads, [
      `https://${host}/result.json?Signature=synthetic%2Bvalue`,
    ]);
    for (const unsafe of [
      `http://${host}:8080/result.json`,
      "http://other.example.test/result.json",
      `https://user:secret@${host}/result.json`,
    ]) {
      resultUrl = unsafe;
      await assert.rejects(
        provider.poll("task", "emotion"),
        /RESULT_HOST_NOT_ALLOWED/,
      );
    }
    assert.equal(downloads.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});
