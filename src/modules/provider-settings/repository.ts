/** Owner-bound immutable YAML revisions and their active pointer. */
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
  linkSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import YAML from "yaml";
import type { ServiceConfig } from "./domain.js";
/** Publish YAML atomically. Immutable revisions and migrations cannot replace an existing file. */
function writeYaml(path: string, value: unknown, exclusive = false) {
  const temporary = path + "." + randomUUID() + ".tmp";
  writeFileSync(temporary, YAML.stringify(value), { mode: 0o600, flag: "wx" });
  try {
    if (exclusive) linkSync(temporary, path);
    else renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}
/** Import legacy JSON on demand; subsequent reads always use the editable YAML snapshot. */
function readRecord(folder: string, name: string): any {
  const file = join(folder, name + ".yaml");
  try {
    return YAML.parse(readFileSync(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("INVALID_PROVIDER_YAML");
  }
  // TODO:[2026-12-14] 保留已有配置版本的 JSON 读取；全部版本转换并验证 YAML 后移除回退分支。
  const old = JSON.parse(readFileSync(join(folder, name + ".json"), "utf8"));
  try {
    writeYaml(file, old, true);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  try {
    return YAML.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error("INVALID_PROVIDER_YAML");
  }
}
/** All provider file I/O is confined to this repository. */
export class ConfigRepository {
  constructor(private root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
  }
  private folder(owner: string) {
    const p = join(this.root, createHash("sha256").update(owner).digest("hex"));
    mkdirSync(p, { recursive: true, mode: 0o700 });
    return p;
  }
  manifest(owner: string): {
    activeConfigId: string | null;
    ids: string[];
  } {
    try {
      return readRecord(this.folder(owner), "index");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        return { activeConfigId: null, ids: [] };
      throw e;
    }
  }
  /** Resolve only a revision belonging to this owner. */
  get(owner: string, id: string): ServiceConfig {
    if (!this.manifest(owner).ids.includes(id))
      throw new Error("PROVIDER_CONFIG_NOT_FOUND");
    return readRecord(this.folder(owner), id);
  }
  active(owner: string) {
    const id = this.manifest(owner).activeConfigId;
    return id ? this.get(owner, id) : null;
  }
  /** Publish a revision before atomically switching the active pointer. */
  publish(owner: string, config: ServiceConfig, ids: string[]) {
    const folder = this.folder(owner);
    writeYaml(join(folder, config.id + ".yaml"), config, true);
    writeYaml(join(folder, "index.yaml"), {
      activeConfigId: config.id,
      ids: [...ids, config.id],
    });
  }
}
