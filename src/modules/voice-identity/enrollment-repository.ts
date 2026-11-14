/** Durable voice enrollment states; exclusive creation prevents duplicate biometric registration. */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import YAML from "yaml";
import { z } from "zod";
const Record = z.object({
  state: z.enum(["submitting", "registered", "verified"]),
  id: z.string().uuid().optional(),
});
export type EnrollmentState = z.infer<typeof Record>;
/** Store immutable scope filenames and atomically advance only known enrollment states. */
export class EnrollmentRepository {
  constructor(private root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  private path(scope: string) {
    if (!/^[a-f0-9]{64}$/.test(scope)) throw Error("INVALID_ENROLLMENT_SCOPE");
    return join(this.root, scope + ".yaml");
  }
  load(scope: string): EnrollmentState {
    return Record.parse(YAML.parse(readFileSync(this.path(scope), "utf8")));
  }
  create(scope: string, value: EnrollmentState) {
    writeFileSync(this.path(scope), YAML.stringify(value), {
      flag: "wx",
      mode: 0o600,
    });
  }
  write(scope: string, value: EnrollmentState) {
    const path = this.path(scope),
      temp = path + "." + randomUUID() + ".tmp";
    writeFileSync(temp, YAML.stringify(value), { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  }
}
