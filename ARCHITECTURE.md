# 服务端业务模块

## 依赖方向

`api/routes/` → `modules/` 中的业务 service → repository / provider port。

`api/` 统一放置 Hono 应用入口、路由注册、公共响应和 HTTP 类型、发行文件入口；`modules/` 只组织业务校验、领域类型、业务流程、持久化与供应商适配。没有平行的 `http/` 或空的 `services/` 入口。

业务层不依赖 Hono Context 或 HTTP 状态码；数据库层使用领域类型，不导入 HTTP schema。HTTP 层负责认证身份、Zod 校验、响应类型和状态码映射。

`api/app.ts` 是 HTTP 组合根；`server.ts` 负责进程、依赖组装和 worker 生命周期。`infrastructure/database.ts` 维护既有 SQLite 连接、事务入口和各模块 repository，不再集中所有业务 SQL。

## 模块职责

| 模块 | 职责 |
|---|---|
| auth | 永久 root Token 摘要、鉴权、主动撤销；HTTP 接口在 api/routes/auth.ts |
| transcripts | 正文领域类型、查询 schema、分页 SQL、文字镜像的去重策略与原子发布 |
| transcription-jobs | 任务输入与来源映射、提交策略、持久任务/租约、worker、各供应商适配、小时累积策略 |
| provider-settings | 配置输入 schema、凭据校验和脱敏、配置版本选择、独立 YAML repository |
| voice-identity | 参考音频校验和存储流程、元数据 repository、声纹注册状态 repository、供应商注册 adapter |
| summaries | 可选 AI SDK 总结适配；没有新增自动总结或收费任务 |

`infrastructure/storage` 放 COS、TOS 和供应商临时对象上传适配。`cli` 只使用公开契约和生成的 HTTP client。`contracts.ts` 是供 CLI 使用的公开 schema/type 导出入口；不得从 repository 或 domain 反向依赖它。

## 不变的数据约定

SQLite 的 tokens/jobs/words/transcript_mirrors 表名、字段和任务封装保持不变。原供应商 task ID、输入 source 映射、generation/lease 与 submission_unknown 状态继续使用；切换代码不重置任务或提交新的付费识别。

root Token 默认长期有效，仅主动撤销才失效。客户端及供应商凭据继续使用仓库外的私有 YAML，权限0600。配置版本和注册状态的路径与格式不变；已有 JSON 配置仅保留按需转为 YAML 的兼容入口。

## 检查与发布

`pnpm check` 运行：strict 类型检查 → 离线重新生成 OpenAPI/Orval 并逐字节比对已提交文件 → CLI 打包 → 全部测试。

`pnpm contract:check` 在没有 .git 的 Docker 构建上下文中也有效。漂移会失败，并恢复检查前的文件；正确修复方式是执行 `pnpm client:generate` 后提交生成结果。

`pnpm cloud:publish` 在 push 前强制执行完整检查，检查导致工作树变化时拒绝发布。Docker 构建再次执行同样的检查，失败不会生成新运行镜像。部署分支仅含 server 子树，现有持久卷不重建。

测试覆盖：无鉴权/身份隔离、root Token 不自动过期、重复与冲突提交、未知提交不重发、持久任务重开后按原 task ID 取回、供应商轮询退避、正文原子替换与回滚、声纹注册恢复、YAML保留、真实 HTTP/CLI 安装链路、生成契约漂移和依赖方向约束。

未知异常返回脱敏的500，已知资源冲突返回409。请求入口生成 requestId，错误响应及服务端结构化日志使用同一个 ID，不记录凭据、签名音频 URL 或正文。
