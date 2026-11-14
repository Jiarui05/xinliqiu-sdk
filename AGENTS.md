# 服务端开发约定

先读 CONVENTIONS.md 和 ARCHITECTURE.md。沿用 Hono、OpenAPI、Scalar、Orval 和当前模块边界。

- 业务文件使用 `业务名.service.ts`、`业务名.repository.ts`、`业务名.schema.ts`、`业务名.types.ts` 等职责后缀；API 路由统一放在 `src/api/routes/` 并使用 `.route.ts`。
- 不为每一层创建空包装；同一业务的相近职责可以合并，但不要把 HTTP、SQL 和业务流程混在一个文件。
- 手写源码采用多行中文文件头，说明主要目的、“职责 → 函数/类方法”以及副作用边界。函数和行内说明均用中文，保留标识符、专有名词与标准标签。
- 生成代码不手改，文件头由 Orval 配置生成。修改后运行 `pnpm check`，发布继续使用现有门禁。
- root Token 长期有效、私有 YAML 和已有数据路径保持当前约定。不得因整理目录或注释重建数据库、重置任务或重提付费转录。
