/** transcripts HTTP routes: parse requests and delegate to existing services/repositories. */
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
} from "../../modules/transcripts/schema.js";
/** Register the module without opening listeners or performing provider requests. */
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
