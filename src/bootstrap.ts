/**
 * @file bootstrap.ts
 * @description 从标准输入注册应用 root Token，仅保存摘要，不输出凭据。
 *
 * 职责与入口：
 * - 模块初始化与配置 → 本文件的顶层声明或命令入口
 *
 * 边界：具体读写和执行时机以各入口为准；凭据与用户数据不得进入日志或发行包。
 */
import { mkdirSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { Repository } from "./infrastructure/database.js";
const folder = process.env.XQ_DATA_DIR ?? ".data";
mkdirSync(folder, { recursive: true, mode: 0o700 });
chmodSync(folder, 0o700);
process.umask(0o077);
const repo = new Repository(join(folder, "backend.sqlite"));
const token = readFileSync(0, "utf8").trim();
repo.auth.token(token, process.env.XQ_OWNER ?? "local");
repo.db.close();
console.log(JSON.stringify({ created: true, expires: false }));
