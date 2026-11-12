/** Hourly accumulation must not duplicate scheduled input or miss late-arriving, verified audio. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HOURLY_AUDIO_MS,
  pendingAudioMs,
  groupAudio,
} from "../src/hourly-policy.js";
test("only verified unscheduled recording time contributes to the one-hour threshold", () => {
  const records = [
    { id: "a", startMS: 200, name: "normal" },
    { id: "late", startMS: 100, name: "normal" },
    { id: "raw", startMS: 300, name: "normal" },
    { id: "voice", startMS: 400, name: ".vp." },
  ];
  const audio = {
    a: { duration: 3599 },
    late: { duration: 1 },
    voice: { duration: 30 },
  };
  assert.equal(pendingAudioMs(records, audio, new Set()), HOURLY_AUDIO_MS);
  assert.equal(pendingAudioMs(records, audio, new Set(["a"])), 1000);
  assert.equal(
    pendingAudioMs(records, audio, new Set(["late"])),
    HOURLY_AUDIO_MS - 1000,
  );
  assert.equal(pendingAudioMs(records, { a: { duration: NaN } }, new Set()), 0);
});

test("automatic mode waits for a full hour and leaves the remainder for the next run", () => {
  const input = [
    { recordedAt: 1, durationMs: 3599000 },
    { recordedAt: 2, durationMs: 2000 },
    { recordedAt: 3, durationMs: 60000 },
  ];
  assert.equal(
    groupAudio(input.slice(0, 1), HOURLY_AUDIO_MS, "accumulated").length,
    0,
  );
  const groups = groupAudio(input, HOURLY_AUDIO_MS, "accumulated");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 2);
});
test("explicit history includes every source once while separating day tails", () => {
  const input = [
    { recordedAt: Date.parse("2026-11-12T23:59:00+08:00"), durationMs: 2000 },
    { recordedAt: Date.parse("2026-11-13T00:01:00+08:00"), durationMs: 3000 },
  ];
  const groups = groupAudio(input, HOURLY_AUDIO_MS, "history");
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.flat(), input);
});
