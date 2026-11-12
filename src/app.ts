/** Hono HTTP boundary: OpenAPI validation, token-derived ownership, explicit ASR submission and count-first reads. */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { Scalar } from "@scalar/hono-api-reference";
import { VoiceReferenceInput, VoiceReferenceView } from "./voice-reference.js";
import { randomUUID } from "node:crypto";
import { TranscriptionConfigs, ServiceInput } from "./transcription-config.js";
import { Repository } from "./repository.js";
import { cliRelease } from "./cli-release.js";
import { MirrorBatch, mirrorTranscripts } from "./transcript-mirror.js";
import {
  Filters,
  Stats,
  Read,
  Page,
  Batch,
  Job,
  ErrorBody,
} from "./contracts.js";
/** Deployment allowlists are operator configuration, never request-controlled URLs. */
export type Options = {
  providerConfigured: boolean;
  audioHosts: string[];
  services?: TranscriptionConfigs;
  batching?: () => {
    automatic: boolean;
    batchMinutes: number;
    pendingSeconds: number;
    state: string;
  };
};
type Env = { Variables: { owner: string; token: string } };
const security = [{ Bearer: [] }];
/** Every documented success/error shape originates in the same Zod contract used at runtime. */
const response = (schema: z.ZodType, description = "Success") => ({
  content: { "application/json": { schema } },
  description,
});
const errors = {
  400: response(ErrorBody, "Invalid request"),
  401: response(ErrorBody, "Invalid token"),
  404: response(ErrorBody, "Not found"),
  409: response(ErrorBody, "State conflict"),
  503: response(ErrorBody, "Provider not configured"),
};
/** Build without starting listeners or contacting a provider; tests inject their own durable repository. */
export function createApp(repo: Repository, options: Options) {
  const app = new OpenAPIHono<Env>({
    defaultHook: (result, c) => {
      if (!result.success)
        return c.json(
          {
            error: {
              code: "INVALID_REQUEST",
              message: "Request validation failed",
              requestId: randomUUID(),
            },
          },
          400,
        );
    },
  });
  app.openAPIRegistry.registerComponent("securitySchemes", "Bearer", {
    type: "http",
    scheme: "bearer",
  });
  app.use("/v1/*", bodyLimit({ maxSize: 2 * 1024 * 1024 }));
  app.use("/v1/*", async (c, next) => {
    const token = c.req
      .header("Authorization")
      ?.match(/^Bearer (.{32,512})$/)?.[1];
    const owner = token ? repo.owner(token) : undefined;
    if (!owner)
      return c.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: "Application token required",
            requestId: randomUUID(),
          },
        },
        401,
      );
    c.set("owner", owner);
    c.set("token", token!);
    return next();
  });
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
      repo.revoke(c.get("token"));
      return c.json({ revoked: true }, 200);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/transcripts/stats",
      operationId: "getTranscriptStats",
      security,
      request: { query: Filters },
      responses: { 200: response(Stats), ...errors },
    }),
    (c) => c.json(repo.stats(c.get("owner"), c.req.valid("query")), 200),
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
        repo.read(
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
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/transcription-batches",
      operationId: "submitTranscriptionBatch",
      security,
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: Batch } },
        },
      },
      responses: {
        202: response(
          z.object({ jobs: z.array(Job) }),
          "Accepted durable jobs",
        ),
        ...errors,
      },
    }),
    (c) => {
      const active = options.services?.active(c.get("owner"));
      if (!options.providerConfigured && !active)
        return c.json(
          {
            error: {
              code: "PROVIDER_NOT_CONFIGURED",
              message:
                "Configure DashScope credentials before submitting audio",
              requestId: randomUUID(),
            },
          },
          503,
        );
      const inputs = c.req.valid("json").recordings;
      for (const input of inputs) {
        const u = new URL(input.audioUrl);
        if (
          u.protocol !== "https:" ||
          u.username ||
          u.password ||
          !options.audioHosts.includes(u.hostname)
        )
          return c.json(
            {
              error: {
                code: "AUDIO_HOST_NOT_ALLOWED",
                message: "Use an operator-approved HTTPS audio host",
                requestId: randomUUID(),
              },
            },
            400,
          );
      }
      repo.db.exec("BEGIN IMMEDIATE");
      try {
        const jobs = inputs.map((i) => {
          const id = i.serviceConfigId ?? active?.id;
          if (id) {
            if (!options.services) throw new Error("PROVIDER_CONFIG_NOT_FOUND");
            options.services.get(c.get("owner"), id);
          }
          return repo.enqueue(c.get("owner"), {
            ...i,
            ...(id ? { serviceConfigId: id } : {}),
          });
        });
        repo.db.exec("COMMIT");
        return c.json({ jobs }, 202);
      } catch (e) {
        repo.db.exec("ROLLBACK");
        throw e;
      }
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/jobs/{id}",
      operationId: "getJob",
      security,
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: { 200: response(Job), ...errors },
    }),
    (c) => {
      const job = repo.job(c.get("owner"), c.req.valid("param").id);
      if (!job)
        return c.json(
          {
            error: {
              code: "NOT_FOUND",
              message: "Job not found",
              requestId: randomUUID(),
            },
          },
          404,
        );
      return c.json(job, 200);
    },
  );
  app.onError((e, c) =>
    c.json(
      {
        error: {
          code: "REQUEST_FAILED",
          message: "The operation could not be completed",
          requestId: randomUUID(),
        },
      },
      409,
    ),
  );
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
  app.get("/cli/:file", (c) => cliRelease(c.req.param("file")));
  app.get("/health", (c) =>
    c.json({ ok: true, providerConfigured: options.providerConfigured }),
  );
  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Xinliqiu transcript API", version: "0.1.0" },
  });
  app.get("/docs", Scalar({ url: "/openapi.json", proxyUrl: undefined }));
  return app;
}
