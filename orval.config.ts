/** Generate the shared TS fetch client from the server's OpenAPI contract. */
import { defineConfig } from "orval";
export default defineConfig({
  xinliqiu: {
    input: "./openapi.json",
    output: {
      target: "./src/generated/client.ts",
      client: "fetch",
      baseUrl: { runtime: 'process.env.XQ_API_URL ?? "http://127.0.0.1:4317"' },
      override: { fetch: { includeHttpResponseReturnType: true } },
    },
  },
});
