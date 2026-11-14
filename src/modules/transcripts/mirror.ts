/** Completed text replication delegates atomic writes to its owner-scoped repository. */
import { createHash } from "node:crypto";
import type { Repository } from "../../infrastructure/database.js";
import type { MirroredTranscript } from "./domain.js";
/** No provider request or audio upload can be scheduled through text replication. */
export function mirrorTranscripts(
  repo: Repository,
  owner: string,
  input: { transcripts: MirroredTranscript[] },
) {
  const revisions = input.transcripts.map((source) => ({
    ...source,
    revision: createHash("sha256").update(JSON.stringify(source)).digest("hex"),
  }));
  return repo.mirrors.replace(owner, revisions);
}
