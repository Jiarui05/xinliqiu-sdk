/**
 * @file transcripts.route.ts
 * @description 注册正文查询 HTTP 路由，保留身份隔离和返回量限制。
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
import {
  Filters,
  Stats,
  Read,
  Page,
} from "../../modules/transcripts/transcripts.schema.js";
/** 注册路由，不启动监听或执行供应商请求。 */
export function register(
  app: OpenAPIHono<Env>,
  repo: Repository,
  options: Options,
) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/transcripts/stats",
      operationId: "getTranscriptStats",
      security,
      request: { query: Filters },
      responses: { 200: response(Stats), ...errors },
    }),
    (c) =>
      c.json(repo.transcripts.stats(c.get("owner"), c.req.valid("query")), 200),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/transcripts",
      operationId: "getTranscripts",
      security,
      request: { query: Read },
      responses: { 200: response(Page), ...errors },
    }),
    (c) => {
      const q = c.req.valid("query");
      return c.json(
        repo.transcripts.read(
          c.get("owner"),
          Filters.parse(q),
          q.cursor,
          q.maxChars,
          q.limit,
        ),
        200,
      );
    },
  );
}
