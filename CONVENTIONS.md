# 服务端命名与注释规范

## 文件与分层

使用“业务名 + 职责后缀”，例如 `auth.repository.ts`、`provider-settings.service.ts`、`transcripts.schema.ts`。多个单词用 kebab-case；后缀表示职责，不是 Hono 的强制规则。

API 入口统一在 `src/api/`，路由使用 `*.route.ts`；业务流程、持久化、校验和领域类型在对应 `modules/<业务>/` 内。只有出现真实职责时才新增文件，不为了凑齐 route/service/repository 创建空包装。

同一业务的相近持久化可放进一个 repository 文件。正文查询与镜像共用 `transcripts.repository.ts`，参考声音与注册状态共用 `voice-identity.repository.ts`。两者分别保持自己的原子操作边界，不把 SQL 移进 service。

## 中文注释

每个源码文件必须以多行 JSDoc 文件说明开头，包含文件名、主要目的、职责与具体函数/类方法的对应关系，以及数据访问或副作用边界。文件说明应帮助读者知道从哪里看起，不能只写一行笼统介绍，也不必列出所有内部变量。

函数、类和导出类型的说明使用中文，重点交代输入输出、状态变化、失败含义和非显然约束。行内注释只解释原因与边界；专有名词、标识符和标准 JSDoc 标签保持原文。文件头和函数注释不写聊天过程或已废弃方案。

生成客户端由 Orval 配置统一生成中文文件头，不手工编辑生成代码。`@nullable`、`@minLength` 等标准标签保持原样。项目测试检查文件说明和职责后缀；契约检查继续检查生成结果是否漂移。

## 参考项目

以下 Star 数于 2026-11-15 使用 GitHub API 核对，只用于选择研究样本，不作为架构正确性的证明。

- [Hono](https://github.com/honojs/hono)：32,950 Star。[官方最佳实践](https://hono.dev/docs/guides/best-practices) 推荐按业务组合路由，避免不必要的控制器拆分导致类型推导丢失。
- [Midday](https://github.com/midday-ai/midday)：15,125 Star。实际 API 使用 Hono，按 [rest/routers](https://github.com/midday-ai/midday/tree/main/apps/api/src/rest/routers)、services、schemas 等职责组织；业务路由文件直接以业务命名，没有统一套用 NestJS 后缀。
- [Mastra](https://github.com/mastra-ai/mastra)：29,518 Star。[Hono adapter](https://github.com/mastra-ai/mastra/tree/main/server-adapters/hono/src) 处理框架适配，[server handlers](https://github.com/mastra-ai/mastra/tree/main/packages/server/src/server/handlers) 按业务组织；未要求每个业务都生成同样数量的文件。
- [NestJS Providers](https://docs.nestjs.com/providers) 使用 `cats.service.ts` 等职责后缀示例。这里采用这种清晰命名，不引入 NestJS 装饰器或依赖注入框架。

据此选择：明确业务归属和依赖方向，采用团队约定的职责后缀，并按复杂度决定文件边界。
