/** Hono HTTP boundary: OpenAPI validation, token-derived ownership, explicit ASR submission and count-first reads. */
import { OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { Scalar } from "@scalar/hono-api-reference";
import { randomUUID } from "node:crypto";
import { Repository } from "./infrastructure/database.js";
import { cliRelease } from "./http/cli-release.js";
import { type Env, type Options } from "./http/common.js";
export type { Options } from "./http/common.js";
import { register as registerVoices } from "./modules/voice-identity/route.js";
import { DomainError } from "./shared/errors.js";
import { register as registerServices } from "./modules/provider-settings/route.js";
import { register as registerAuth } from "./modules/auth/route.js";
import { register as registerTranscripts } from "./modules/transcripts/route.js";
import { register as registerJobs } from "./modules/transcription-jobs/route.js";
import { register as registerMirror } from "./modules/transcripts/mirror-route.js";
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
              requestId: c.get("requestId"),
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
  app.use("*", async (c, next) => {
    c.set("requestId", randomUUID());
    await next();
  });
  app.use("/v1/*", bodyLimit({ maxSize: 2 * 1024 * 1024 }));
  app.use("/v1/*", async (c, next) => {
    const token = c.req
      .header("Authorization")
      ?.match(/^Bearer (.{32,512})$/)?.[1];
    const owner = token ? repo.auth.owner(token) : undefined;
    if (!owner)
      return c.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: "Application token required",
            requestId: c.get("requestId"),
          },
        },
        401,
      );
    c.set("owner", owner);
    c.set("token", token!);
    return next();
  });
  registerVoices(app, repo, options);
  registerServices(app, repo, options);
  registerAuth(app, repo, options);
  registerTranscripts(app, repo, options);
  registerJobs(app, repo, options);
  app.onError((error, c) => {
    const known = error instanceof DomainError;
    const oversized = error instanceof HTTPException && error.status === 413;
    const code = oversized
      ? "PAYLOAD_TOO_LARGE"
      : known
        ? error.code
        : "INTERNAL_ERROR";
    const status = oversized ? 413 : known ? 409 : 500;
    console.error(
      JSON.stringify({
        event: "request_failed",
        requestId: c.get("requestId"),
        code,
      }),
    );
    return c.json(
      {
        error: {
          code,
          message: known
            ? error.message
            : "The operation could not be completed",
          requestId: c.get("requestId"),
        },
      },
      status,
    );
  });
  registerMirror(app, repo, options);
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
