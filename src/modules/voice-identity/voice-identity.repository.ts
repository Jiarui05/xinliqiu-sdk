/**
 * @file voice-identity.repository.ts
 * @description 管理参考音频元数据与声纹注册状态，使用用户隔离和原子文件写入。
 *
 * 职责与入口：
 * - 检查指定用户的参考记录是否已存在，供幂等保存使用 → VoiceRepository.exists()
 * - 读取指定用户的记录，不允许跨用户访问 → VoiceRepository.get()
 * - 保存对象或元数据 → VoiceRepository.put()
 * - 描述声纹从提交、注册到验证的持久阶段 → EnrollmentState
 * - 读取并校验已有注册状态，损坏状态不得当作未注册 → EnrollmentRepository.load()
 * - 独占创建提交中状态，避免并发操作重复注册 → EnrollmentRepository.create()
 * - 通过临时文件和原子替换发布已确认的注册状态 → EnrollmentRepository.write()
 *
 * 边界：仅负责所属业务的持久化；用户身份由调用方传入，不调用外部模型。
 */
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import YAML from "yaml";
import { z } from "zod";
import type { VoiceReference } from "./voice-identity.types.js";
/** 保存用户隔离的参考音频元数据，不保存音频本体。 */
export class VoiceRepository {
  constructor(private root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  /** 校验记录标识并构造作用域内的文件路径，防止路径越界。 */
  private path(owner: string, id: string) {
    z.string().uuid().parse(id);
    const dir = join(
      this.root,
      createHash("sha256").update(owner).digest("hex"),
    );
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return join(dir, id + ".json");
  }
  /** 检查指定用户的参考记录是否已存在，供幂等保存使用。 */
  exists(owner: string, id: string) {
    return existsSync(this.path(owner, id));
  }
  /** 读取指定用户的记录，不允许跨用户访问。 */
  get(owner: string, id: string): VoiceReference {
    return JSON.parse(readFileSync(this.path(owner, id), "utf8"));
  }
  /** 保存对象或元数据；调用方必须已经完成输入校验。 */
  put(owner: string, value: VoiceReference) {
    writeFileSync(this.path(owner, value.id), JSON.stringify(value), {
      mode: 0o600,
      flag: "wx",
    });
  }
}

const Record = z.object({
  state: z.enum(["submitting", "registered", "verified"]),
  id: z.string().uuid().optional(),
});
/** 描述声纹从提交、注册到验证的持久阶段；未知响应不得重提。 */
export type EnrollmentState = z.infer<typeof Record>;
/** 按固定作用域文件名保存状态，并原子推进已确认的注册阶段。 */
export class EnrollmentRepository {
  constructor(private root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  /** 校验记录标识并构造作用域内的文件路径，防止路径越界。 */
  private path(scope: string) {
    if (!/^[a-f0-9]{64}$/.test(scope)) throw Error("INVALID_ENROLLMENT_SCOPE");
    return join(this.root, scope + ".yaml");
  }
  /** 读取并校验已有注册状态，损坏状态不得当作未注册。 */
  load(scope: string): EnrollmentState {
    return Record.parse(YAML.parse(readFileSync(this.path(scope), "utf8")));
  }
  /** 独占创建提交中状态，避免并发操作重复注册。 */
  create(scope: string, value: EnrollmentState) {
    writeFileSync(this.path(scope), YAML.stringify(value), {
      flag: "wx",
      mode: 0o600,
    });
  }
  /** 通过临时文件和原子替换发布已确认的注册状态。 */
  write(scope: string, value: EnrollmentState) {
    const path = this.path(scope),
      temp = path + "." + randomUUID() + ".tmp";
    writeFileSync(temp, YAML.stringify(value), { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  }
}
