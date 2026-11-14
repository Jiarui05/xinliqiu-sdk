/**
 * @file server.ts
 * @description 启动本机 API 与持久任务处理器；默认只监听回环地址。
 *
 * 职责与入口：
 * - 创建 HTTP 监听 → serve()
 * - 调度持久任务轮询 → tick()
 * - 退出前等待当前任务释放数据库 → shutdown()
 *
 * 边界：具体读写和执行时机以各入口为准；凭据与用户数据不得进入日志或发行包。
 */
import { serve } from "@hono/node-server";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { Repository } from "./infrastructure/database.js";
import { createApp } from "./api/app.js";
import { DashScope } from "./modules/transcription-jobs/providers/qwen.provider.js";
import { TranscriptionConfigs } from "./modules/provider-settings/provider-settings.service.js";
import {
  VoiceReferences,
  cosReferenceStorage,
} from "./modules/voice-identity/voice-identity.service.js";
import { configuredProvider } from "./modules/transcription-jobs/providers/registry.factory.js";
import { tosReferenceStorage } from "./infrastructure/storage/tos.js";
import { batchingStatus } from "./modules/transcription-jobs/transcription-jobs.policy.js";
import { tick } from "./modules/transcription-jobs/transcription-jobs.worker.js";
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
// 仅在没有已保存配置时，用现有环境凭据初始化一次本机配置。
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
/** 退出前等待当前任务释放数据库；提交结果未知的任务保留恢复状态。 */
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
