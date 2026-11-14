/**
 * @file transcription-jobs.service.ts
 * @description 校验批量提交策略并原子入队，不依赖 Hono Context。
 *
 * 职责与入口：
 * - 定义业务拒绝原因，由 HTTP 路由统一映射状态码 → SubmissionError
 * - 验证部署允许的音频来源，并在同一事务中创建整批任务 → submitJobs()
 *
 * 边界：负责业务流程与约束；数据访问和外部通信使用已有 repository 或 adapter。
 */
import { Repository } from "../../infrastructure/database.js";
import { TranscriptionConfigs } from "../provider-settings/provider-settings.service.js";
import type { RecordingInput } from "./transcription-jobs.types.js";
/** 定义业务拒绝原因，由 HTTP 路由统一映射状态码。 */
export class SubmissionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
/** 验证部署允许的音频来源，并在同一事务中创建整批任务。 */
export function submitJobs(
  repo: Repository,
  options: {
    providerConfigured: boolean;
    audioHosts: string[];
    services?: TranscriptionConfigs;
  },
  owner: string,
  inputs: RecordingInput[],
) {
  const active = options.services?.active(owner);
  if (!options.providerConfigured && !active)
    throw new SubmissionError(
      "PROVIDER_NOT_CONFIGURED",
      "Configure a transcription provider before submitting audio",
    );
  for (const input of inputs) {
    const u = new URL(input.audioUrl);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      !options.audioHosts.includes(u.hostname)
    )
      throw new SubmissionError(
        "AUDIO_HOST_NOT_ALLOWED",
        "Use an operator-approved HTTPS audio host",
      );
  }
  return repo.transaction(() => {
    const jobs = inputs.map((input) => {
      const id = input.serviceConfigId ?? active?.id;
      if (id) {
        if (!options.services) throw Error("PROVIDER_CONFIG_NOT_FOUND");
        options.services.get(owner, id);
      }
      return repo.jobs.enqueue(owner, {
        ...input,
        ...(id ? { serviceConfigId: id } : {}),
      });
    });
    return jobs;
  });
}
