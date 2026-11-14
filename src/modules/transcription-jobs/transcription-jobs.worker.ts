/**
 * @file transcription-jobs.worker.ts
 * @description 处理持久 ASR 任务；未知提交不自动重试，已知任务按供应商 ID 恢复。
 *
 * 职责与入口：
 * - 处理一次任务租约 → tick()
 *
 * 边界：具体读写和执行时机以各入口为准；凭据与用户数据不得进入日志或发行包。
 */
import { Repository } from "../../infrastructure/database.js";
import {
  normalize,
  combine,
  type Provider,
  type Pass,
} from "./providers/qwen.provider.js";
import type { JobInput } from "./transcription-jobs.types.js";
/** 处理一次任务租约；中断或轮询等待后由调度器继续执行。 */
export async function tick(
  repo: Repository,
  providerOrResolve: Provider | ((owner: string, input: JobInput) => Provider),
) {
  const job = repo.jobs.claim();
  if (!job) return false;
  const input = JSON.parse(job.input) as JobInput;

  const tasks = JSON.parse(job.tasks) as Partial<Record<Pass, string>>,
    results = JSON.parse(job.results) as Partial<Record<Pass, unknown>>;
  let submitting = false;
  let pending = false;
  try {
    const provider =
      typeof providerOrResolve === "function"
        ? providerOrResolve(job.owner, input)
        : providerOrResolve;
    const passes: Pass[] =
      provider.passes?.(input) ??
      (input.mode === "rich" ? ["emotion", "speakers"] : [input.mode]);
    for (const pass of passes) {
      if (results[pass]) continue;
      if (!tasks[pass]) {
        submitting = true;
        repo.jobs.update(job, "submitting", tasks, results, null, 120000);
        const submitted = await provider.submit(input, pass);
        if (typeof submitted !== "string") {
          results[pass] = submitted.completed;
          submitting = false;
          repo.jobs.update(job, "running", tasks, results, null, 120000);
          continue;
        }
        tasks[pass] = submitted;
        submitting = false;
        repo.jobs.update(job, "running", tasks, results, null, 120000);
      }
      const result = await provider.poll(tasks[pass]!, pass);
      delete (results as Record<string, unknown>).__pollFailures;
      if (result === null) {
        pending = true;
        continue;
      }
      results[pass] = result;
      repo.jobs.update(job, "running", tasks, results, null, 120000);
    }
    if (pending) {
      repo.jobs.update(job, "running", tasks, results, null, 5000);
      return true;
    }
    repo.jobs.complete(
      job,
      provider.finish
        ? provider.finish(results, input)
        : input.mode === "rich"
          ? combine(results.emotion, results.speakers)
          : normalize(results[input.mode]),
    );
  } catch (e) {
    const transient =
      e instanceof Error &&
      (["AbortError", "TimeoutError"].includes(e.name) ||
        (e instanceof TypeError &&
          ["fetch failed", "terminated"].includes(e.message)) ||
        /^PROVIDER_HTTP_(408|429|500|502|503|504)$/.test(e.message));
    const metadata = results as Record<string, unknown>;
    const failures = Number(metadata.__pollFailures ?? 0);
    // 任务 ID 已持久化时只重试查询结果，不重复提交付费识别。
    if (!submitting && transient && Object.keys(tasks).length && failures < 3) {
      metadata.__pollFailures = failures + 1;
      repo.jobs.update(
        job,
        "running",
        tasks,
        results,
        "PROVIDER_POLL_RETRY",
        15000,
      );
      return true;
    }
    // 供应商原始错误可能带有音频地址或正文，持久化时只保存内部错误分类。
    const known = transient
      ? "PROVIDER_NETWORK_ERROR"
      : e instanceof Error &&
          /^(PROVIDER_[A-Z0-9_]+|RESULT_HOST_NOT_ALLOWED)$/.test(e.message)
        ? e.message
        : "PROVIDER_RESPONSE_INVALID";
    repo.jobs.update(
      job,
      submitting ? "submission_unknown" : "failed",
      tasks,
      results,
      known,
    );
  }
  return true;
}
