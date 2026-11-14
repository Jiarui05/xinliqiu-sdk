/**
 * @file voice-identity.route.ts
 * @description 注册参考音频 HTTP 路由，公开响应仅返回必要元数据。
 *
 * 职责与入口：
 * - 注册参考音频接口，不承担存储或供应商业务逻辑 → register()
 *
 * 边界：只处理 HTTP 校验、身份与响应映射；业务状态与数据写入交给对应模块。
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Repository } from "../../infrastructure/database.js";
import {
  type Env,
  type Options,
  security,
  response,
  errors,
} from "../common.js";
import {
  VoiceReferenceInput,
  VoiceReferenceView,
} from "../../modules/voice-identity/voice-identity.schema.js";
/** 注册参考音频接口，不承担存储或供应商业务逻辑。 */
export function register(
  app: OpenAPIHono<Env>,
  repo: Repository,
  options: Options,
) {
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/voice-reference",
      operationId: "saveVoiceReference",
      security,
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: VoiceReferenceInput } },
        },
      },
      responses: { 200: response(VoiceReferenceView), ...errors },
    }),
    async (c) => {
      if (!options.services?.voices?.ready)
        return c.json(
          {
            error: {
              code: "VOICE_STORAGE_NOT_CONFIGURED",
              message: "Private voice storage is not configured",
              requestId: c.get("requestId"),
            },
          },
          503,
        );
      try {
        return c.json(
          await options.services.voices.save(
            c.get("owner"),
            c.req.valid("json").audioBase64,
          ),
          200,
        );
      } catch {
        return c.json(
          {
            error: {
              code: "VOICE_REFERENCE_FAILED",
              message: "Check reference audio and private storage",
              requestId: c.get("requestId"),
            },
          },
          400,
        );
      }
    },
  );
}
