/** Shared transport error envelope. */
import { z } from "@hono/zod-openapi";
export const ErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
  }),
});
