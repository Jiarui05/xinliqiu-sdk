/** Root-token digests and explicit revocation; SQL stays inside persistence. */
import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
/** Hash an opaque root token without storing its plaintext. */
export function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
/** Owner-scoped permanent tokens, with optional explicit expiry for callers that request it. */
export class AuthRepository {
  constructor(private db: DatabaseSync) {}
  /** Register a root application token (permanent unless explicitly given an expiry) supplied on stdin by the operator. */
  token(token: string, owner: string, expires = Number.MAX_SAFE_INTEGER) {
    if (token.length < 32 || token.length > 512)
      throw new Error("token must have at least 32 characters");
    this.db
      .prepare("INSERT OR REPLACE INTO tokens VALUES(?,?,?)")
      .run(digest(token), owner, expires);
  }
  /** Resolve identity only from a nonexpired stored token digest. */
  owner(token: string): string | undefined {
    return (
      this.db
        .prepare("SELECT owner FROM tokens WHERE hash=? AND expires>?")
        .get(digest(token), Date.now()) as { owner: string } | undefined
    )?.owner;
  }
  /** Revoke one token immediately. */
  revoke(token: string) {
    this.db.prepare("DELETE FROM tokens WHERE hash=?").run(digest(token));
  }
}
