/**
 * @file schema.ts
 * @description 定义 HTTP 错误响应结构，不承载业务状态。
 *
 * 职责与入口：
 * - 模块初始化与配置 → 本文件的顶层声明或命令入口
 *
 * 边界：具体读写和执行时机以各入口为准；凭据与用户数据不得进入日志或发行包。
 */
import { z } from "@hono/zod-openapi";
export const ErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
  }),
});
