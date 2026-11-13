/** services HTTP routes: parse requests and delegate to existing services/repositories. */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { randomUUID } from "node:crypto";
import { Repository } from "../repository.js";
import {
  type Env,
  type Options,
  security,
  response,
  errors,
} from "./common.js";
import { VoiceReferenceInput, VoiceReferenceView } from "../voice-reference.js";
import { ServiceInput } from "../transcription-config.js";
/** Register the module without opening listeners or performing provider requests. */
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
              requestId: randomUUID(),
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
              requestId: randomUUID(),
            },
          },
          400,
        );
      }
    },
  );
  const configView = z.object({
    id: z.string(),
    provider: z.enum(["qwen", "tencent", "doubao"]),
    model: z.string(),
    credentials: z.record(z.string(), z.string()),
    secrets: z.array(z.string()),
    voiceIdentity: z.object({
      enabled: z.boolean(),
      referenceId: z.string().optional(),
      durationSeconds: z.number().optional(),
    }),
  });
  const field = z.object({
    key: z.string(),
    label: z.string(),
    secret: z.boolean(),
    required: z.boolean(),
    defaultValue: z.string(),
  });
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
              requestId: randomUUID(),
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
              requestId: randomUUID(),
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
              requestId: randomUUID(),
            },
          },
          400,
        );
      }
    },
  );
}
