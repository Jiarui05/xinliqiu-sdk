# Compile the API and downloadable CLI from the same checked-in contract.
FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NODE_OPTIONS=--max-old-space-size=256
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json orval.config.ts ./
COPY src ./src
COPY scripts ./scripts
COPY test ./test
COPY skill ./skill
COPY openapi.json ./openapi.json
RUN pnpm check && pnpm exec tsc --noEmit false --outDir dist && pnpm prune --prod

# Personal audio and credentials are mounted at runtime, never baked into the image.
FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
RUN mkdir /data && chown node:node /data
COPY --from=build /app/dist/src ./dist
COPY openapi.json ./openapi.json
COPY --from=build /app/cli-release ./cli-release
ENV XQ_CLI_RELEASE_DIR=/app/cli-release
ENV NODE_ENV=production XQ_HOST=0.0.0.0 PORT=4317 XQ_DATA_DIR=/data
USER node
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:4317/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
