/** Durable bounded ASR worker. Unknown submissions never auto-retry; known tasks resume by provider ID. */
import { Repository } from "../../infrastructure/database.js";
import {
  normalize,
  combine,
  type Provider,
  type Pass,
} from "./providers/qwen.js";
import type { JobInput } from "./domain.js";
/** Process a single lease; a supervisor can call again after interruption or provider polling delay. */
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
    // Once a task ID is durable, retry only its read-only result query; never repeat a submission.
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
    // Raw provider messages can contain the input URL or transcript. Persist only bounded internal categories.
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
