/**
 * @file config.ts
 * @description 从私有 YAML 读取和保存 CLI root Token，不通过命令参数或输出泄露凭据。
 *
 * 职责与入口：
 * - 优先使用显式 CLI 配置路径，否则沿用云端文字同步的标准 YAML → configPath()
 * - 配置解析失败时隐藏原文，避免错误堆栈带出 Token 所在行 → saved()
 * - 只修改登录字段，保留录音库路径和镜像配置 → save()
 * - CI 可通过环境变量覆盖配置 → cliClient()
 * - 先验证 root Token，再保存到本机 → login()
 * - 只移除本机保存的凭据，不撤销服务端 Token → logout()
 *
 * 边界：具体读写和执行时机以各入口为准；凭据与用户数据不得进入日志或发行包。
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  chmodSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import YAML from "yaml";
import { Client } from "./client.js";

/** 优先使用显式 CLI 配置路径，否则沿用云端文字同步的标准 YAML。 */
export function configPath() {
  return (
    process.env.XQ_CLI_CONFIG ?? join(homedir(), ".config/xinliqiu/cloud.yaml")
  );
}
/** 配置解析失败时隐藏原文，避免错误堆栈带出 Token 所在行。 */
function saved(): Record<string, unknown> {
  if (!existsSync(configPath())) return {};
  try {
    const value = YAML.parse(readFileSync(configPath(), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error();
    return value;
  } catch {
    throw Error("CONFIG_INVALID");
  }
}
/** 只修改登录字段，保留录音库路径和镜像配置。 */
function save(value: Record<string, unknown>) {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + "." + randomUUID();
  writeFileSync(temp, YAML.stringify(value), { mode: 0o600, flag: "wx" });
  renameSync(temp, path);
  chmodSync(path, 0o600);
}
/** CI 可通过环境变量覆盖配置；交互使用默认读取本机 YAML。 */
export function cliClient() {
  const config = saved();
  process.env.XQ_API_URL ??=
    typeof config.url === "string" ? config.url : "https://xinliqiu.jiarui.ink";
  const token =
    process.env.XQ_TOKEN ??
    (process.env.XQ_TOKEN_FILE
      ? readFileSync(process.env.XQ_TOKEN_FILE, "utf8").trim()
      : config.token);
  if (typeof token !== "string" || !token)
    throw Error("ROOT_TOKEN_REQUIRED: use xq auth login --token-stdin");
  return new Client(token);
}
/** 先验证 root Token，再保存到本机；整个过程不输出凭据正文。 */
export async function login(base: string, token: string) {
  process.env.XQ_API_URL = base.replace(/\/$/, "");
  if (token.length < 32 || token.length > 512)
    throw Error("INVALID_ROOT_TOKEN");
  const identity = await new Client(token).me();
  save({ ...saved(), url: process.env.XQ_API_URL, token });
  return {
    authenticated: true,
    owner: identity.owner,
    url: process.env.XQ_API_URL,
    config: configPath(),
  };
}
/** 只移除本机保存的凭据，不撤销服务端 Token。 */
export function logout() {
  const config = saved();
  delete config.token;
  save(config);
  return { removed: true, revoked: false };
}
