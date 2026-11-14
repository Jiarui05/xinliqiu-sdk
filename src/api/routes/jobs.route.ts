/**
 * @file jobs.route.ts
 * @description 注册转录任务 HTTP 路由，转换请求、身份和业务响应。
 *
 * 职责与入口：
 * - 注册路由，不启动监听或执行供应商请求 → register()
 *
 * 边界：只处理 HTTP 校验、身份与响应映射；业务状态与数据写入交给对应模块。
 */
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
} from "../../modules/transcription-jobs/transcription-jobs.service.js";
import {
  Batch,
  Job,
} from "../../modules/transcription-jobs/transcription-jobs.schema.js";
/** 注册路由，不启动监听或执行供应商请求。 */
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
