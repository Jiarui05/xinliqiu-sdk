/**
 * @file orval.config.ts
 * @description 配置 OpenAPI 到 TypeScript 客户端的生成规则，不在生成目录手动修改代码。
 *
 * 职责与入口：
 * - 定义客户端生成规则 → defineConfig()
 * - 生成中文文件说明 → override.header
 * - 配置运行时请求地址 → baseUrl.runtime
 *
 * 边界：具体读写和执行时机以各入口为准；凭据与用户数据不得进入日志或发行包。
 */
import { defineConfig } from "orval";
export default defineConfig({
  xinliqiu: {
    input: "./openapi.json",
    output: {
      target: "./src/generated/client.ts",
      client: "fetch",
      baseUrl: { runtime: 'process.env.XQ_API_URL ?? "http://127.0.0.1:4317"' },
      override: {
        header: () => [
          "@file client.ts",
          "@description 由 Orval 根据 OpenAPI 自动生成的 HTTP 客户端。",
          "",
          "职责与入口：",
          "- API 调用 → 各 operationId 对应的请求函数。",
          "- 请求与响应类型 → 根据服务端 schema 生成的类型声明。",
          "",
          "边界：请修改服务端契约并重新生成，不手工维护此文件。",
        ],
        fetch: { includeHttpResponseReturnType: true },
      },
    },
  },
});
