/** Immutable reference metadata storage; audio itself belongs to private object storage. */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { VoiceReference } from "./domain.js";
/** Hash owner namespaces and validate IDs before constructing paths. */
export class VoiceRepository {
  constructor(private root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  private path(owner: string, id: string) {
    z.string().uuid().parse(id);
    const dir = join(
      this.root,
      createHash("sha256").update(owner).digest("hex"),
    );
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return join(dir, id + ".json");
  }
  exists(owner: string, id: string) {
    return existsSync(this.path(owner, id));
  }
  get(owner: string, id: string): VoiceReference {
    return JSON.parse(readFileSync(this.path(owner, id), "utf8"));
  }
  put(owner: string, value: VoiceReference) {
    writeFileSync(this.path(owner, value.id), JSON.stringify(value), {
      mode: 0o600,
      flag: "wx",
    });
  }
}
