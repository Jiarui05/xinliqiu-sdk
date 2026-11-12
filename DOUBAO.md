# 豆包录音转录

新版控制台使用豆包语音 API Key（不是方舟聊天模型 Key）。设置里选择豆包后填写 API Key，模型为 `bigmodel`。

资源可选：

- `volc.seedasr.auc`：2.0，默认。HTTPS 音频 URL 使用异步查询；本机音频走 `recognize/flash` 直接提交数据，无需 COS。当前账号已用 60 秒样本验证此组合。
- `volc.bigasr.auc_turbo`：旧极速版资源，需要独立授权；不要把开通 2.0 误认为同时开通此资源。
- `volc.bigasr.auc`：旧标准版。已保存的旧 App ID / Access Token 配置仍可执行；新建配置使用 API Key。

请求不设置 `audio.language`，让模型识别四川话等方言。开启标点与说话人；关闭 ITN 和语义顺滑以保留口语。使用原始字／词时间戳；若词文本无法和句子对应，则保留句级时间，不能制造字级精度。极速版不启用情绪检测。

## 本机小样本验证

`pnpm exec tsx scripts/transcribe-doubao.ts --library <录音库> --source <录音SHA256> --output <私有结果目录>`，通过 `XQ_DATA_DIR` 指定本机后端目录。可用 `--config-id` 固定豆包配置版本。单次只接受一个不超过 120 秒的已校验 WAV。

脚本使用结果目录中的独立 SQLite 队列：网络返回未知时不自动重发。默认仅生成私有对比结果，不覆盖现有转录；明确传入 `--apply` 才会备份旧 sidecar 并原子替换该条录音的转录。完整文本保存在结果文件，终端只输出状态、字数和路径。

云端支持并不等于当前账号已开通或四川话实测更准确。需要分别验证 API Key、资源权限、余额、真实结果和原始音频对照。

官方文档：
- https://www.volcengine.com/docs/6561/1354868?lang=zh
- https://www.volcengine.com/docs/6561/1631584?lang=zh
