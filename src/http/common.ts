/** Shared HTTP types and response contracts; no business operations. */
import { z } from "@hono/zod-openapi";
import { TranscriptionConfigs } from "../transcription-config.js";
import { ErrorBody } from "../contracts.js";
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
export type Env = { Variables: { owner: string; token: string } };
export const security = [{ Bearer: [] }];
/** Every documented success/error shape originates in the same Zod contract used at runtime. */
export const response = (schema: z.ZodType, description = "Success") => ({
  content: { "application/json": { schema } },
  description,
});
export const errors = {
  400: response(ErrorBody, "Invalid request"),
  401: response(ErrorBody, "Invalid token"),
  404: response(ErrorBody, "Not found"),
  409: response(ErrorBody, "State conflict"),
  503: response(ErrorBody, "Provider not configured"),
};
