/** mirror HTTP routes: parse requests and delegate to existing services/repositories. */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Repository } from "../../infrastructure/database.js";
import {
  type Env,
  type Options,
  security,
  response,
  errors,
} from "../../http/common.js";
import { mirrorTranscripts } from "./mirror.js";
import { MirrorBatch } from "./mirror-schema.js";
/** Register the module without opening listeners or performing provider requests. */
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
