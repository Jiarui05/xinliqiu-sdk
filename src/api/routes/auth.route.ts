/**
 * @file auth.route.ts
 * @description 注册应用身份查询与 Token 撤销接口。
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

/** 注册路由，不启动监听或执行供应商请求。 */
export function register(
  app: OpenAPIHono<Env>,
  repo: Repository,
  options: Options,
) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/me",
      operationId: "getMe",
      security,
      responses: { 200: response(z.object({ owner: z.string() })), ...errors },
    }),
    (c) => c.json({ owner: c.get("owner") }, 200),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/auth/logout",
      operationId: "logout",
      security,
      responses: {
        200: response(z.object({ revoked: z.boolean() })),
        ...errors,
      },
    }),
    (c) => {
      repo.auth.revoke(c.get("token"));
      return c.json({ revoked: true }, 200);
    },
  );
}
