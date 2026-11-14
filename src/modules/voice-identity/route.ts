/** services HTTP routes: parse requests and delegate to existing services/repositories. */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Repository } from "../../infrastructure/database.js";
import {
  type Env,
  type Options,
  security,
  response,
  errors,
} from "../../http/common.js";
import { VoiceReferenceInput, VoiceReferenceView } from "./schema.js";
/** Register reference-audio HTTP transport only. */
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
