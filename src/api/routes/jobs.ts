/** jobs HTTP routes: parse requests and delegate to existing services/repositories. */
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
  submitJobs,
  SubmissionError,
} from "../../modules/transcription-jobs/service.js";
import { Batch, Job } from "../../modules/transcription-jobs/schema.js";
/** Register the module without opening listeners or performing provider requests. */
export function register(
  app: OpenAPIHono<Env>,
  repo: Repository,
  options: Options,
) {
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
      try {
        return c.json(
          {
            jobs: submitJobs(
              repo,
              options,
              c.get("owner"),
              c.req.valid("json").recordings,
            ),
          },
          202,
        );
      } catch (error) {
        if (error instanceof SubmissionError)
          return c.json(
            {
              error: {
                code: error.code,
                message: error.message,
                requestId: c.get("requestId"),
              },
            },
            error.code === "PROVIDER_NOT_CONFIGURED" ? 503 : 400,
          );
        throw error;
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
      const job = repo.jobs.job(c.get("owner"), c.req.valid("param").id);
      if (!job)
        return c.json(
          {
            error: {
              code: "NOT_FOUND",
              message: "Job not found",
              requestId: c.get("requestId"),
            },
          },
          404,
        );
      return c.json(job, 200);
    },
  );
}
