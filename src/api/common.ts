/**
 * @file common.ts
 * @description 定义 HTTP 上下文和公共响应契约，不执行业务操作。
 *
 * 职责与入口：
 * - 音频地址白名单来自部署配置，不接受请求方自行扩大访问范围 → Options
 * - 定义鉴权身份与请求追踪字段，由 HTTP 中间件注入 → Env
 *
 * 边界：具体读写和执行时机以各入口为准；凭据与用户数据不得进入日志或发行包。
 */
import { z } from "@hono/zod-openapi";
import { TranscriptionConfigs } from "../modules/provider-settings/provider-settings.service.js";
import { ErrorBody } from "../contracts.js";
/** 音频地址白名单来自部署配置，不接受请求方自行扩大访问范围。 */
export type Options = {
  providerConfigured: boolean;
  audioHosts: string[];
  services?: TranscriptionConfigs;
  batching?: () => {
    automatic: boolean;
    batchMinutes: number;
    pendingSeconds: number;
    state: string;
  };
};
/** 定义鉴权身份与请求追踪字段，由 HTTP 中间件注入。 */
export type Env = {
  Variables: { owner: string; token: string; requestId: string };
};
export const security = [{ Bearer: [] }];
/** 成功和错误响应统一使用运行时 Zod 契约生成文档。 */
export const response = (schema: z.ZodType, description = "Success") => ({
  content: { "application/json": { schema } },
  description,
});
export const errors = {
  400: response(ErrorBody, "Invalid request"),
  401: response(ErrorBody, "Invalid token"),
  404: response(ErrorBody, "Not found"),
  409: response(ErrorBody, "State conflict"),
  413: response(ErrorBody, "Request too large"),
  500: response(ErrorBody, "Internal server error"),
  503: response(ErrorBody, "Provider not configured"),
};
