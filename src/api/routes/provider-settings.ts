/** services HTTP routes: parse requests and delegate to existing services/repositories. */
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
  ServiceInput,
  configView,
  field,
} from "../../modules/provider-settings/schema.js";
/** Register the module without opening listeners or performing provider requests. */
export function register(
  app: OpenAPIHono<Env>,
  repo: Repository,
  options: Options,
) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/transcription-service",
      operationId: "getTranscriptionService",
      security,
      responses: {
        200: response(
          z.object({
            activeConfigId: z.string().nullable(),
            voiceStorageReady: z.boolean(),
            batching: z.object({
              automatic: z.boolean(),
              batchMinutes: z.number(),
              pendingSeconds: z.number(),
              state: z.string(),
            }),
            providers: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                defaultModel: z.string(),
                fields: z.array(field),
              }),
            ),
            configurations: z.array(configView),
          }),
        ),
        ...errors,
      },
    }),
    (c) => {
      if (!options.services)
        return c.json(
          {
            error: {
              code: "PROVIDER_NOT_CONFIGURED",
              message: "Configuration store unavailable",
              requestId: c.get("requestId"),
            },
          },
          503,
        );
      return c.json(
        {
          ...options.services.list(c.get("owner")),
          batching: options.batching?.() ?? {
            automatic: false,
            batchMinutes: 60,
            pendingSeconds: 0,
            state: "disabled",
          },
        },
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "put",
      path: "/v1/transcription-service",
      operationId: "saveTranscriptionService",
      security,
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: ServiceInput } },
        },
      },
      responses: { 200: response(configView), ...errors },
    }),
    async (c) => {
      if (!options.services)
        return c.json(
          {
            error: {
              code: "PROVIDER_NOT_CONFIGURED",
              message: "Configuration store unavailable",
              requestId: c.get("requestId"),
            },
          },
          503,
        );
      try {
        return c.json(
          await options.services.saveWithVoice(
            c.get("owner"),
            c.req.valid("json"),
          ),
          200,
        );
      } catch (error) {
        const code =
          error instanceof Error &&
          /^VOICEPRINT_[A-Z0-9_]+$/.test(error.message)
            ? error.message
            : "INVALID_PROVIDER_CONFIG";
        return c.json(
          {
            error: {
              code,
              message: code.startsWith("VOICEPRINT_")
                ? "Voice registration was not confirmed; active configuration is unchanged"
                : "Check provider model and required credential fields",
              requestId: c.get("requestId"),
            },
          },
          400,
        );
      }
    },
  );
}
