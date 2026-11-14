/**
 * @file cli-release.ts
 * @description 仅提供构建生成的公开 CLI 资源，不暴露应用数据目录。
 *
 * 职责与入口：
 * - 只接受白名单文件名，防止访问凭据和 SQLite 数据文件 → cliRelease()
 *
 * 边界：具体读写和执行时机以各入口为准；凭据与用户数据不得进入日志或发行包。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const types: Record<string, string> = {
  "latest.json": "application/json",
  "xq.mjs": "text/javascript",
  "openapi.json": "application/json",
  "SKILL.md": "text/markdown; charset=utf-8",
  "install.mjs": "text/javascript",
  "install.sh": "text/plain; charset=utf-8",
};
/** 只接受白名单文件名，防止访问凭据和 SQLite 数据文件。 */
export function cliRelease(filename: string) {
  const root = process.env.XQ_CLI_RELEASE_DIR;
  if (!root || !Object.hasOwn(types, filename))
    return new Response("Not found", { status: 404 });
  const path = join(root, filename);
  if (!existsSync(path)) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(readFileSync(path)), {
    headers: {
      "Content-Type": types[filename]!,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
