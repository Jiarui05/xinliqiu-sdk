# 心力球转录后端

Hono + TypeScript、Scalar、OpenAPI → Orval 客户端、应用 Token、CLI 和 Agent skill。服务器默认只监听 `127.0.0.1:4317`。本机单用户版本使用 SQLite/WAL 持久化任务与文本；无需先开通 PostgreSQL 或 Redis。它不适用于多主机共享 SQLite 文件的部署。

当前实现接受**用户明确提交的 HTTPS 音频 URL**，不会扫描录音库或自动上传音频。音频 URL 必须来自配置的主机白名单，建议使用私有 OSS 的短期签名链接。真实供应商调用已用官方短音频验收，另提供显式本地快照导入，通过同一百炼账号的模型绑定临时存储上传；云端 API 接收本机完成文字的镜像，原音频仍保留在 Mac。结果下载有独立主机白名单，不把 Authorization 转发给结果文件地址；白名单内阿里云 OSS 返回的 HTTP 地址会改用 HTTPS，保留原签名路径和查询参数。

## 运行

要求 Node.js 22.13+、pnpm。Node 22 的 `node:sqlite` 会显示实验性 API 提示。

1. 在本目录执行 `pnpm install --frozen-lockfile`。
2. 创建不少于32字符的随机应用 Token，保存在仓库外的0600文件中；将文件内容通过 stdin 传给 `pnpm bootstrap`。服务器仅保存 SHA-256 摘要，root Token 默认长期有效，主动撤销才失效。可用 `XQ_DATA_DIR` 指定私有数据库目录。
3. 执行 `pnpm dev`；`/health`、`/openapi.json` 和 `/docs` 可本地访问。
4. CLI 也可设置 `XQ_API_URL` 和 `XQ_TOKEN_FILE`，指向同一后端与 Token 文件。不要把密钥写入命令参数。
5. 阿里云处理需要 `.env.example` 中的供应商配置；通过进程环境加载。也可将配置保存到仓库外的0600文件，通过 `XQ_DATA_DIR=/private/runtime node --env-file=/private/runtime/provider.env --import tsx src/server.ts` 启动。不要提交真实配置。应用 Token 与阿里云 API Key 是不同凭证。

当前 Token 是本机 bootstrap 分发的可撤销应用凭证，没有用户名/密码登录页面。`POST /v1/auth/logout` 撤销当前 Token；每次读写都从 Token 得到 owner。公开联网前需要自行配置 HTTPS、请求速率限制与运行监管，默认配置不开放局域网监听。

## 音频到文字

`CLI +submit / HTTP batch → SQLite queued → worker → 阿里云 task_id → 轮询/下载 → 时间轴归一化 → 持久转录 → stats → 有界正文 → CLI +pull → Rust 点击跳转`。

| 模式           | 处理                                                                    |
| -------------- | ----------------------------------------------------------------------- |
| `emotion`      | Qwen3-ASR-Flash-Filetrans，开启 `enable_words`；保存情绪与真实时间戳    |
| `speakers`     | Fun-ASR，开启 `diarization_enabled`；保存说话人标签与时间戳             |
| `rich`（默认） | 两项任务处理同一音频，以 Qwen 时间戳为准，用时间重叠对齐 Fun-ASR 说话人 |

`rich` 会产生两项供应商任务/费用，不能称为一次调用的价格。情绪是模型标签，不是对真实心理状态的确定判断。说话人编号只在单个 sourceId 内有效，不是跨录音声纹身份。时间重叠不足60%或多个说话人并列时不分配标签；`speakerSource=overlap` 标出对齐来源。

字级时间戳保留为 `character`，多字词保留为 `word`，缺词级输出时保留为 `sentence`；**不会把一个词平均切成虚假的逐字秒数**。句级回退的长文本只为分页分块，所有块仍标记为句级。供应商输出毫秒，Rust sidecar 的 `start/end` 转成秒。

任务提交前持久化 `submitting`；POST超时或该阶段崩溃进入 `submission_unknown`，不自动重新收费。已经拿到 task_id 的任务可在租约到期后继续查询。失败保留错误类别，不回显音频 URL 或供应商正文。重复 sourceId 复用任务；修改采集时间/模式会报冲突。目前没有远程重提未知任务的接口，须先在供应商侧对账。

## 防止 Context 爆量

建议先调用 `GET /v1/transcripts/stats` 查看字数与覆盖范围，再决定读取量。root Token 是唯一鉴权凭据；`GET /v1/transcripts` 可以直接带时间、说话人、关键词筛选，无需先统计或申请查询凭据。每次分页读取当前数据，不使用查询凭据或版本号。

正文默认最多2000个 Unicode 码点（包含标点和空格），硬上限8000；默认100个时间词条，硬上限200。`nextCursor` 只表示还有数据，Agent 不应自动循环把所有页塞入上下文。`charCount` 不是精确 LLM token 数。

支持采集时间 `from/to`（epoch毫秒）、`sourceId`、`speaker`、`emotion`、`q`。时间区间按词条重叠筛选；关键词先命中时间窗内包含该短语的录音，再返回其窗口内词条。多字中文关键词可跨相邻词条匹配。说话人筛选应同时指定 sourceId。

## CLI

参考 lark-cli 的 domain +shortcut、schema、dry-run 和机器可读结果设计；不是复刻全部 lark-cli 功能。开发时以下命令在本目录运行；安装后把 `pnpm cli` 换成 `xq` 即可：

- `pnpm cli transcript +inspect --from 2026-11-11T00:00:00+08:00 --to 2026-11-12T00:00:00+08:00`：只看统计。
- `pnpm cli transcript +read --from 2026-11-12T00:00:00+08:00 --to 2026-11-13T00:00:00+08:00 --max-chars 2000 --page-size 100`：显式取一页。
- `pnpm cli transcript +read --cursor <nextCursor>`（沿用原筛选条件）：继续一页。
- `pnpm cli schema getTranscripts`：查看原始契约。
- `pnpm cli --dry-run transcript +submit --manifest /private/path/batch.json`：预览录音数量，不打印 URL。
- `pnpm cli transcript +submit --manifest /private/path/batch.json`：显式发起处理。
- `pnpm cli job <jobId>`：查询状态，无正文。
- `pnpm cli transcript +pull --source-id <原始录音SHA256> --library /private/path/library`：先统计，分页下载，原子写入 `transcripts/<sourceId>.json`。只输出保存数量，Rust 自动重新读取。
- `--fields charCount,wordCount`：投影顶层结果字段；`--json` 为默认输出模式。

清单结构是 `recordings` 数组，每项含 `sourceId`（原始录音64位SHA256）、`recordedAt`（采集epoch毫秒）、`audioUrl`（用户授权的可解码音频HTTPS地址）、`mode`。单次最多50项。不要将私有清单、签名URL或录音提交到 Git。

## 安装、升级与 Agent skill

下载 `https://xinliqiu.jiarui.ink/cli/install.sh` 后用 shell 执行，或运行 `curl -fsS https://xinliqiu.jiarui.ink/cli/install.sh | sh`。需要 Node.js 22+，命令安装在 `~/.local/bin/xq`，不依赖源码 checkout；`xq self update` 下载并校验最新版，保留 root Token。未在 PATH 时使用完整命令路径。

`xq auth status` 验证已有 YAML；首次登录用 `xq auth login --base https://xinliqiu.jiarui.ink --token-stdin`。默认读取 `~/.config/xinliqiu/cloud.yaml` 的 `url/token`，`XQ_CLI_CONFIG` 可覆盖路径。`xq auth logout` 只清除本机保存的 Token，不撤销云端凭据。

`xq skill install` 安装到 `~/.codex/skills/xinliqiu-cli/`，`--path` 支持其他 Agent；也可直接下载 `/cli/SKILL.md`。该 skill 通过 CLI 查询，不提供 MCP 入口。`/cli/latest.json` 列出发行标识和文件 SHA-256，安装失败不替换当前可用版本。

## 持续部署

`pnpm cloud:publish` 将已提交的 `backend/` 树发布到 `deploy/transcript-service`，不发布其他设备研究目录和开发分支历史。首次提交无父历史，后续提交基于上次部署分支，正常 push 不强制覆盖并发更新。Dokploy 的 GitHub provider 监听该分支 push，按根目录 `compose.cloud.yaml` 构建 API 镜像和同版本 CLI/skill 资产。数据库继续挂载已有独立持久卷。

开发流程：修改 → `pnpm check` → commit → `pnpm cloud:publish`。以 Dokploy 完成状态及公网 `/cli/latest.json` 的发行标识确认上线；仅 push 成功不代表发布完成。新安装自动取得当前版本，已安装 CLI 显式执行 `xq self update`。

## 契约与验证

`pnpm client:generate` 从 Hono 路由导出 OpenAPI 3.1，再生成 Orval fetch client；CLI 使用该生成客户端。生成目录禁止手改。`pnpm check` 执行 strict 类型检查、权限/字数/异步状态测试，以及实际 HTTP + 可下载安装 CLI + sidecar 集成验证。

2026-11-11 实际供应商验收：官方约1.7秒示例音频的 Qwen3-ASR 与 Fun-ASR 两项任务均成功。使用原 task_id 恢复结果采集，无重复提交；后端完成持久化，当时先获得9个字符的统计，再读回8个时间词条。返回包含逐字毫秒时间、neutral 情绪和局部说话人编号；零时长词条及对齐不足的说话人保留原值/未知，不补造结果。这个短样本不代表长录音识别精度。

`src/summary.ts` 提供有输入预算与来源检查的 AI SDK 文本总结适配器，当前没有自动触发或HTTP总结接口，不把它当成已上线总结功能。

官方能力参考：[非实时语音识别](https://help.aliyun.com/zh/model-studio/non-realtime-speech-recognition-user-guide)、[Qwen-ASR](https://help.aliyun.com/zh/model-studio/qwen-asr-api-reference)、[Fun-ASR](https://help.aliyun.com/zh/model-studio/fun-asr-recorded-speech-recognition-http-api)。新部署需核对所属地域、模型授权与实际费用；用户自己的心力球录音仍需配置可读取的音频地址后单独验收。

## 现有录音的一次性回填

这是服务所在机器的可信本地操作命令，必须能读取选定录音库及后端 SQLite；不向 HTTP API 开放任意本地路径。默认存储命令仍不上传明文，只有用户明确要求云端转录时才运行此导入流程。

- `pnpm library:plan --library /private/library --output /private/run/manifest.json`：固定已有可播放录音快照，跳过已有转录，生成30分钟以内批次；首批使用一份较短录音验收。既有输出清单不会被覆盖。
- 用 `XQ_DATA_DIR=/private/runtime node --env-file=/private/runtime/provider.env --import tsx scripts/transcribe-library.ts --manifest /private/run/manifest.json --max-batches 1 --inflight 1` 处理首批。
- 验收后去掉 `--max-batches 1`，以默认最多3批在途继续同一清单。服务工作线程数受 `XQ_WORKER_CONCURRENCY` 限制（1–4，默认2）。

每份源 WAV 先检查大小和 SHA-256，再无损拼为 FLAC，并核对总时长。两种模型各自获取模型绑定的私有临时 URL，使用 `X-DashScope-OssResourceResolve`，API Key 不转发给 OSS 上传地址。临时文件由百炼限制为同账号/同模型使用、48小时有效；此流程用于有界回填，不替代生产对象存储。

任务结果按输入偏移映射回各原录音的 sourceId 与真实采集时间，保留原来的时间空白。说话人编号带批次作用域，不假设不同批次的同编号是同一人。跨物理文件边界的词按其真实开始时间归属，不人为拆分语音时间。

每批完成后原子发布 `transcripts/<sourceId>.json`，无可识别语音也写完成标记；CLI只输出计数，不把正文灌进上下文。`progress.json` 提供处理时长、数量与失败状态。遇到失败或提交结果未知时停止新增批次，保留 task_id 和上传缓存；重启使用同一清单，已完成任务不会再次提交。异常中止留下锁时，先核实锁内PID确实退出再清理该次运行的锁。

## 可切换的转录服务

`GET /v1/transcription-service` 返回千问、腾讯云和豆包的字段定义、默认模型和当前配置。`PUT` 接收 `provider`、`model`、`credentials`，保存并启用新配置。两个接口使用已有应用 Bearer token，并已纳入 OpenAPI / Scalar / Orval。密钥字段只返回已配置状态，编辑时空白表示沿用同一供应商此前的密钥。

千问使用 `apiKey`、`baseUrl`；腾讯云使用 `secretId`、`secretKey`、`region`；豆包使用 `appId`、`accessToken`、`resourceId`。单个 Model ID 字段分别对应千问转录模型、腾讯 EngineModelType 和豆包 model_name。配置以权限 0600 的私有文件保存于运行目录下 `transcription-configs`，每次修改产生独立版本。HTTP 提交的新任务绑定当时的配置 ID，后续修改不改变在途任务所用的供应商与模型；早期任务继续走原 DashScope 配置。

腾讯云和豆包适配器将句子、词语时间及说话人统一映射为现有 TimedWord。腾讯的词偏移加上句子起点，豆包直接保留音频内偏移。两者当前返回真实时间和匿名说话人，情绪字段为 null；明确请求 emotion 模式会返回能力不支持错误。声纹注册与身份匹配参数尚未开放。

腾讯云采用 TC3 签名及 CreateRecTask / DescribeTaskStatus；豆包采用大模型录音标准版 submit / query。远程提交结果未知仍进入 submission_unknown，禁止自动重新提交。新适配器接收供应商可访问的 HTTPS 音频 URL。现有 library:transcribe 的本地上传仍使用阿里云模型绑定临时文件，此上传流程不能直接给另外两家复用。

离线测试覆盖配置隔离、密钥隐藏和复用、在途任务绑定，以及三家响应解析。腾讯云真实凭证已通过签名验证，普通模型 16k_zh 完成官方约 1.7 秒公开样本的转录并返回 5 个词级时间片；16k_zh_en 提交返回 FailedOperation.UserHasNoAmount，需要对应模型资源额度。短样本不代表长录音准确率。豆包需要配置可用凭证后做实机调用验收。

### 本机 YAML 凭证

转录配置使用数据目录内的 `transcription-configs/<owner-hash>/index.yaml` 和 `<revision-id>.yaml`。凭证以明文保存，文件权限为 0600，根目录为 0700；这些文件必须留在仓库外。既有 JSON 配置首次读取时转换为 YAML，旧文件保留作备份；YAML 存在时始终优先读取，解析失败会报错，不会悄悄回退到旧密钥。保存设置仍创建独立版本，已提交任务继续使用原版本。

### 豆包识别自己的声音

豆包设置使用“录制并确认参考声音 → 识别我的声音”两步流程。保存时上传本人确认的 10—30 秒声音至私有 COS 或 TOS，调用 `UpdateVoiceprint` 注册“我”，再用 `GetVoiceprint` 确认声纹有效后切换配置。普通转录仍使用极速接口；声纹模式使用标准 `submit/query` 链路，携带 `ssd_version=300` 与已验证的 `voiceprints`。本机音频校验哈希后上传 `asr-inputs/`，只通过一小时签名 URL 交给豆包。只有注册模式实际返回“我”才标记 `speakerSource=voiceprint`，跨源映射保持身份标签。

存储配置读取 `XQ_CONFIG` 或 `~/.config/xinliqiu/client.yaml` 的 `storage.tos` 段：`bucket`、`region`、`accessKeyId`、`accessKeySecret`。使用专用桶受限凭证，对象默认私有。临时转录对象建议配置 `asr-inputs/` 前缀一天过期，参考声音保留供重新注册。COS 使用同一个 YAML 的 `storage.cos` 段，字段为 `bucket`、`region`、`secretId`、`secretKey`。两种存储只配置一种。没有云存储时可以录制试听，但不能启用云端身份匹配。

同一用户、同一参考声音重复保存复用 ID。注册前持久化提交状态，网络中断或进程退出导致结果未知时不重复注册，原生效配置不变；已经取得声纹 ID 时再次保存只重查状态。关闭模式只影响后续任务，不删除云端声纹和历史结果。账号接口可用不能代替本人参考音频与独立录音的识别验收。

官方契约：[声纹注册和管理](https://docs.volcengine.com/docs/doubao-voice/voice-print-registration-management-api?lang=zh)、[ASR 声纹匹配](https://docs.volcengine.com/docs/doubao-voice/speaker-separation?lang=zh)。

2026-11-13 联调记录：私有 COS 的签名 GET 返回 200 且字节与上传一致，匿名 GET 返回 403。已获授权的 60 秒样本经私有签名 URL 送入豆包标准链路后完成，得到 95 个时间词项、114 个字符；结果在独立评估库中，未覆盖原转录。声纹管理查询返回正常，但本人参考声音尚未录制，因此尚不能宣称跨录音身份匹配已通过实测。

`node --import tsx scripts/transcribe-doubao-day.ts --date YYYY-MM-DD --library <private-library> --output <private-run-directory>` 按上海时区冻结指定日的已校验音频，要求当前豆包配置已经启用且持有有效声纹 ID。每批默认约60分钟音频（`--batch-minutes` 可显式覆盖）、默认2批在途（`--inflight 4` 可提高至4批），由运行中的后端 worker 处理。运行目录保存固定配置版本、源文件哈希、进度及旧转录备份；失败或提交结果未知时停止新建任务，重启不能盲目重复计费。日期按原文件开始时间选择，所有字词保留原录音时间映射；用户所选日尚未解密的录音会阻止开始。

声纹管理实测接口使用 `/api/proxy/invoke/` 尾斜杠，避免携带凭证的重定向；注册/查询返回 `SpeakID`，同时兼容文档示例的 `SpeakId`。只有返回正常状态的“我”才允许激活，已取得 ID 的恢复只查询、不重复创建。

### 按真实时间比较转录实验

`python3 scripts/render-transcription-comparison.py --experiment <private-experiment-directory> --database <private-backend.sqlite> --output <private-report.html>` 读取已完成的实验任务和原录音映射，生成自包含 HTML。左右版本共用滚动视口，同一行固定对应原始时钟的15秒区间；无录音空档折叠，切换版本保持时间锚点，支持定位已确认句子及筛选文字差异。源数据里的文字仅作为文本节点渲染，脚本数据转义 `<`，页面不加载外部资源。未完成的实验会拒绝导出，不能把缺失结果呈现为空白识别。

2026-11-13 对比验收：三组真实结果（10分钟分批、61.2分钟合并、120.5分钟合并）已映射到相同实际时刻；浏览器验证了左右行顶端对齐、单一滚动容器、切换版本后时间锚点保持、页面外层不滚动。本人确认的11:34:53句子在两个长输入实验中匹配到“我”，10分钟批次未匹配；专有名词存在不同写法，不能据此推断长输入整体识别准确率更高。实验结果没有覆盖全天分批结果。


### 默认按小时自动转录

本机 YAML 的 `transcription.automatic: true` 显式启用 `scripts/watch-hourly-transcription.ts`。调度器每30秒检查已校验音频，按录音 ID 排除已提交或已保留给历史任务的记录，累计有效音频达到3600秒后提交一个完整批次；不足一小时继续积累。成功、失败和结果未知的已提交源均不会自动再次上传。重启会继续原清单、复用已保存的供应商任务 ID，并补写尚未发布的结果；失败批次显示需要处理，不能伪装成没有待处理音频。

历史重跑使用 `transcribe-doubao-day.ts --date all --batch-minutes 60`，冻结全部已解密录音，按日期分组并包含每一天不足一小时的尾段。运行前备份 SQLite 与 sidecar；完成一批后在事务内替换该 owner 的对应录音文字，并使旧字数检查令牌过期，客户端须重新检查字数；不会把新旧结果叠加。源音频保持不变。`reserved-sources.json` 用于在历史任务尚未全部入队时阻止自动调度器重复提交同一批音频。

本机部署可用用户级 launchd 同时管理 API 服务和小时调度器（分别启动 `src/server.ts`、`scripts/watch-hourly-transcription.ts`，WorkingDirectory 指向 backend，显式设置 `XQ_DATA_DIR` 与包含 ffmpeg 的 PATH）。日志与运行清单存于私有数据目录。`GET /v1/transcription-service` 的 `batching` 字段返回是否开启、60分钟批次、待转录秒数和当前状态，设置页按此展示积累进度。

供应商任务 ID 已持久化后，结果查询遇到明确的网络中断、超时或暂时 HTTP 错误时，保留同一个任务 ID，最多重查3次，每次间隔15秒；不重新提交音频。提交阶段的网络结果未知仍保留 `submission_unknown`，禁止自动重投。结果格式和时间映射错误不会作为网络故障重试。

## 私有云文字镜像

`Dockerfile` 编译 API 和可下载 CLI。镜像不包含本机配置或录音；挂载 `/data` 持久化 SQLite。容器通过 `XQ_HOST=0.0.0.0` 监听内部网络，普通本机运行仍默认 loopback。公网入口必须使用 HTTPS，`/v1/*` 继续要求应用 Token，`/docs` 为 Scalar 文档。

Mac 继续拥有蓝牙、原音频和每小时转录调度。`scripts/mirror-transcripts.ts --config <私有cloud.yaml> --watch` 每30秒检查已完成 sidecar，把变化的文字发送到 `POST /v1/transcripts/mirror`。配置包含 `url`、`token`、`library`，明文 YAML 放在仓库外并设为0600。镜像按来源原子替换，重复上传不新增文字，不复制音频、供应商凭证或任务队列，也不发起付费ASR。云端按来源替换旧文字，后续查询直接读取当前结果。

云端根地址由 YAML 配置；root Token 默认长期有效、可以主动撤销，不把供应商 API Key 当作应用 Token。CLI 和 API 均保留每次返回的字数限制，但不使用查询凭据或数据版本号。
