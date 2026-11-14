/** auth HTTP routes: parse requests and delegate to existing services/repositories. */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Repository } from "../../infrastructure/database.js";
import {
  type Env,
  type Options,
  security,
  response,
  errors,
} from "../common.js";

/** Register the module without opening listeners or performing provider requests. */
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
