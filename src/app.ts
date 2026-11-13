/** Hono HTTP boundary: OpenAPI validation, token-derived ownership, explicit ASR submission and count-first reads. */
import { OpenAPIHono } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { Scalar } from "@scalar/hono-api-reference";
import { randomUUID } from "node:crypto";
import { Repository } from "./repository.js";
import { cliRelease } from "./cli-release.js";
import { type Env, type Options } from "./http/common.js";
export type { Options } from "./http/common.js";
import { register as registerServices } from "./http/services.js";
import { register as registerAuth } from "./http/auth.js";
import { register as registerTranscripts } from "./http/transcripts.js";
import { register as registerJobs } from "./http/jobs.js";
import { register as registerMirror } from "./http/mirror.js";
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
  registerServices(app, repo, options);
  registerAuth(app, repo, options);
  registerTranscripts(app, repo, options);
  registerJobs(app, repo, options);
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
