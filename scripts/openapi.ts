/**
 * @file openapi.ts
 * @description 离线导出 API 契约，不启动监听、不读取凭据、不提交音频。
 *
 * 职责与入口：
 * - 模块初始化与配置 → 本文件的顶层声明或命令入口
 *
 * 边界：具体读写和执行时机以各入口为准；凭据与用户数据不得进入日志或发行包。
 */
import { writeFileSync } from "node:fs";
import { createApp } from "../src/api/app.js";
import { Repository } from "../src/infrastructure/database.js";
const repo = new Repository(":memory:");
const app = createApp(repo, { providerConfigured: false, audioHosts: [] });
const response = await app.request("/openapi.json");
writeFileSync(
  "openapi.json",
  JSON.stringify(await response.json(), null, 2) + "\n",
);
repo.db.close();
