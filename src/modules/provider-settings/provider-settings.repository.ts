/**
 * @file provider-settings.repository.ts
 * @description 保存按用户隔离的不可变 YAML 配置版本及活动指针。
 *
 * 职责与入口：
 * - 原子发布 YAML → writeYaml()
 * - 按需读取已有 JSON 配置并转换为 YAML，后续读取以 YAML 为准 → readRecord()
 * - 读取活动配置及历史版本清单 → ConfigRepository.manifest()
 * - 只解析属于指定用户的配置版本 → ConfigRepository.get()
 * - 读取当前活动配置，不修改已有任务绑定的版本 → ConfigRepository.active()
 * - 先发布完整配置版本，再原子切换活动指针 → ConfigRepository.publish()
 *
 * 边界：仅负责所属业务的持久化；用户身份由调用方传入，不调用外部模型。
 */
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
import type { ServiceConfig } from "./provider-settings.types.js";
/** 原子发布 YAML；不可变版本和兼容转换不能覆盖已有文件。 */
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
/** 按需读取已有 JSON 配置并转换为 YAML，后续读取以 YAML 为准。 */
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
/** 集中管理供应商配置文件的全部读取和原子写入。 */
export class ConfigRepository {
  constructor(private root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
  }
  /** 按用户哈希构造私有目录，并确保目录存在。 */
  private folder(owner: string) {
    const p = join(this.root, createHash("sha256").update(owner).digest("hex"));
    mkdirSync(p, { recursive: true, mode: 0o700 });
    return p;
  }
  /** 读取活动配置及历史版本清单；首次使用返回空清单。 */
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
  /** 只解析属于指定用户的配置版本。 */
  get(owner: string, id: string): ServiceConfig {
    if (!this.manifest(owner).ids.includes(id))
      throw new Error("PROVIDER_CONFIG_NOT_FOUND");
    return readRecord(this.folder(owner), id);
  }
  /** 读取当前活动配置，不修改已有任务绑定的版本。 */
  active(owner: string) {
    const id = this.manifest(owner).activeConfigId;
    return id ? this.get(owner, id) : null;
  }
  /** 先发布完整配置版本，再原子切换活动指针。 */
  publish(owner: string, config: ServiceConfig, ids: string[]) {
    const folder = this.folder(owner);
    writeYaml(join(folder, config.id + ".yaml"), config, true);
    writeYaml(join(folder, "index.yaml"), {
      activeConfigId: config.id,
      ids: [...ids, config.id],
    });
  }
}
