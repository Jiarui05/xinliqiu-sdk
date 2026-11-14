/**
 * @file mirror.route.ts
 * @description 注册已完成文字的镜像接口，不接受音频上传或任务提交。
 *
 * 职责与入口：
 * - 注册路由，不启动监听或执行供应商请求 → register()
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
import { mirrorTranscripts } from "../../modules/transcripts/transcripts.service.js";
import { MirrorBatch } from "../../modules/transcripts/transcripts.schema.js";
/** 注册路由，不启动监听或执行供应商请求。 */
export function register(
  app: OpenAPIHono<Env>,
  repo: Repository,
  options: Options,
) {
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/transcripts/mirror",
      operationId: "mirrorTranscripts",
      security,
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: MirrorBatch } },
        },
      },
      responses: {
        200: response(z.object({ changed: z.number(), received: z.number() })),
        ...errors,
      },
    }),
    (c) =>
      c.json(mirrorTranscripts(repo, c.get("owner"), c.req.valid("json")), 200),
  );
}
