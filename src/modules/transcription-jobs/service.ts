/** Batch submission policy and atomic scheduling, independent of Hono request contexts. */
import { Repository } from "../../infrastructure/database.js";
import { TranscriptionConfigs } from "../provider-settings/service.js";
import type { RecordingInput } from "./domain.js";
/** A business rejection with a stable HTTP mapping at the route boundary. */
export class SubmissionError extends Error {
  constructor(
    readonly code: string,
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
