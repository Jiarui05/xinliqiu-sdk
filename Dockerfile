# @file Dockerfile
# 目的：从同一份已提交契约生成经过检查的 API 与 CLI 镜像。
# 职责与入口：类型、契约、构建和测试 → build 阶段；应用运行 → 最终阶段。
# 边界：用户数据通过独立卷挂载，构建过程不访问生产配置。
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

# 用户音频和凭据只在运行时挂载，不写入镜像。
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
