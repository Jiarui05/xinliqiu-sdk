/** Configurable API listener and durable worker supervisor; local use defaults to loopback. */
import { serve } from "@hono/node-server";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { Repository } from "./repository.js";
import { createApp } from "./app.js";
import { DashScope } from "./provider.js";
import { TranscriptionConfigs } from "./transcription-config.js";
import { VoiceReferences, cosReferenceStorage } from "./voice-reference.js";
import { configuredProvider } from "./cloud-transcription.js";
import { tosReferenceStorage } from "./tos-storage.js";
import { batchingStatus } from "./hourly-policy.js";
import { tick } from "./worker.js";
const folder = process.env.XQ_DATA_DIR ?? ".data";
mkdirSync(folder, { recursive: true, mode: 0o700 });
chmodSync(folder, 0o700);
process.umask(0o077);
const repo = new Repository(join(folder, "backend.sqlite"));
const audioStorage = tosReferenceStorage() ?? cosReferenceStorage();
const services = new TranscriptionConfigs(
  join(folder, "transcription-configs"),
  new VoiceReferences(join(folder, "voice-references"), audioStorage),
);
const configured = Boolean(
  process.env.DASHSCOPE_API_KEY && process.env.DASHSCOPE_BASE_URL,
);
// Existing private environment credentials seed the local settings once.
if (!services.active("local")) {
  if (process.env.TENCENT_SECRET_ID && process.env.TENCENT_SECRET_KEY) {
    services.save("local", {
      provider: "tencent",
      model: "16k_zh",
      credentials: {
        secretId: process.env.TENCENT_SECRET_ID,
        secretKey: process.env.TENCENT_SECRET_KEY,
        region: process.env.TENCENT_REGION ?? "ap-beijing",
      },
    });
  }
  if (configured)
    services.save("local", {
      provider: "qwen",
      model: "qwen3-asr-flash-filetrans",
      credentials: {
        apiKey: process.env.DASHSCOPE_API_KEY!,
        baseUrl: process.env.DASHSCOPE_BASE_URL!,
      },
    });
}
const app = createApp(repo, {
  batching: () => batchingStatus(folder),
  providerConfigured: configured,
  services,
  audioHosts: (process.env.XQ_AUDIO_HOSTS ?? "").split(",").filter(Boolean),
});
const server = serve({
  fetch: app.fetch,
  hostname: process.env.XQ_HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 4317),
});
const provider = configured
  ? new DashScope(
      process.env.DASHSCOPE_BASE_URL!,
      process.env.DASHSCOPE_API_KEY!,
      (process.env.XQ_RESULT_HOSTS ?? "").split(",").filter(Boolean),
    )
  : null;
const workers = Math.max(
  1,
  Math.min(4, Number(process.env.XQ_WORKER_CONCURRENCY) || 2),
);
let stopping = false;
const running = (async () => {
  while (!stopping) {
    await Promise.all(
      Array.from({ length: workers }, () =>
        tick(repo, (owner, input) => {
          if (input.serviceConfigId)
            return configuredProvider(
              services.get(owner, input.serviceConfigId),
              (process.env.XQ_RESULT_HOSTS ?? "").split(",").filter(Boolean),
              () => {
                const config = services.get(owner, input.serviceConfigId!);
                if (!config.voiceReference || !services.voices)
                  throw new Error("VOICE_MODE_NOT_READY");
                return services.voices.url(config.voiceReference);
              },
              audioStorage,
            );
          if (!provider) throw new Error("PROVIDER_NOT_CONFIGURED");
          return provider;
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 1000));
  }
})();
/** Drain the current request before releasing SQLite; uncertain remote submissions remain recoverable. */
async function shutdown() {
  stopping = true;
  server.close();
  await running;
  repo.db.close();
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
console.error(
  `Xinliqiu API listening on ${process.env.XQ_HOST ?? "127.0.0.1"}:${process.env.PORT ?? 4317}; provider ${configured ? "configured" : "not configured"}`,
);
