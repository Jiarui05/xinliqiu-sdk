/** Batch submission policy and atomic scheduling, independent of Hono request contexts. */
import { Repository } from "../repository.js";
import { TranscriptionConfigs } from "../transcription-config.js";
import type { RecordingInput } from "../contracts.js";
/** A business rejection with a stable HTTP mapping at the route boundary. */
export class SubmissionError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 503,
    message: string,
  ) {
    super(message);
  }
}
/** Validate operator-controlled audio origins and enqueue the entire batch in one transaction. */
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
      503,
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
        400,
        "Use an operator-approved HTTPS audio host",
      );
  }
  repo.db.exec("BEGIN IMMEDIATE");
  try {
    const jobs = inputs.map((input) => {
      const id = input.serviceConfigId ?? active?.id;
      if (id) {
        if (!options.services) throw Error("PROVIDER_CONFIG_NOT_FOUND");
        options.services.get(owner, id);
      }
      return repo.enqueue(owner, {
        ...input,
        ...(id ? { serviceConfigId: id } : {}),
      });
    });
    repo.db.exec("COMMIT");
    return jobs;
  } catch (e) {
    repo.db.exec("ROLLBACK");
    throw e;
  }
}
