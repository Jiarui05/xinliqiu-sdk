/**
 * @file auth.repository.ts
 * @description 负责应用 root Token 的持久化生命周期：登记、身份解析和主动撤销。
 * 服务端仅保存 Token 的 SHA-256 摘要、所属用户和有效期；默认长期有效。
 *
 * 职责与入口：
 * - 对不透明 Token 计算摘要，不保存明文 → digest()
 * - 登记调用方提供的 root Token，校验长度后保存摘要和有效期 → AuthRepository.token()
 * - 只根据有效的已保存摘要解析身份，不信任请求中的用户标识 → AuthRepository.owner()
 * - 立即撤销指定 Token，不影响同一用户的其他凭据 → AuthRepository.revoke()
 *
 * 边界：仅操作 tokens 表；不解析 HTTP、不读取 YAML，也不调用外部供应商。
 */
import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
/** 对不透明 Token 计算摘要，不保存明文。 */
export function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
/** 按用户隔离 Token；默认长期有效，仅在显式指定时设置到期时间。 */
export class AuthRepository {
  constructor(private db: DatabaseSync) {}
  /** 登记调用方提供的 root Token，校验长度后保存摘要和有效期。 */
  token(token: string, owner: string, expires = Number.MAX_SAFE_INTEGER) {
    if (token.length < 32 || token.length > 512)
      throw new Error("token must have at least 32 characters");
    this.db
      .prepare("INSERT OR REPLACE INTO tokens VALUES(?,?,?)")
      .run(digest(token), owner, expires);
  }
  /** 只根据有效的已保存摘要解析身份，不信任请求中的用户标识。 */
  owner(token: string): string | undefined {
    return (
      this.db
        .prepare("SELECT owner FROM tokens WHERE hash=? AND expires>?")
        .get(digest(token), Date.now()) as { owner: string } | undefined
    )?.owner;
  }
  /** 立即撤销指定 Token，不影响同一用户的其他凭据。 */
  revoke(token: string) {
    this.db.prepare("DELETE FROM tokens WHERE hash=?").run(digest(token));
  }
}
