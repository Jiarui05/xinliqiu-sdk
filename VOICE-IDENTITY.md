# 腾讯云“识别我的声音”

客户端转录设置仅在腾讯云下显示两步：服务配置，以及参考声音。点击录制才请求麦克风权限，最多 30 秒；至少 10 秒、试听并确认后，私有云存储可用时才能开启。关闭设置或离开录音区会停止采集和试听。确认后的本机样本保存在 `~/Library/Application Support/XinliqiuRust/voice-reference/reference.wav`（文件 0600、目录 0700）。

## 私有存储

目前尚未开通实际 COS；没有配置时可以本机录制试听，识别开关禁用。后端部署需要：

- `XQ_VOICE_COS_BUCKET`：私有桶全名（含 APPID）。
- `XQ_VOICE_COS_REGION`：桶地域。
- `XQ_VOICE_COS_SECRET_ID`、`XQ_VOICE_COS_SECRET_KEY`：仅允许专用参考声音前缀 PutObject/GetObject 的凭证，不复用 ASR 子账号权限。

上传对象保持 private。后端在提交转录时生成有效期 6 小时的 HTTPS 下载链接，以覆盖异步队列等待；不把链接写入设置响应或日志。旧参考样本保留给已排队任务，替换录音只影响后续配置版本。云端旧样本清理目前需运营端按任务引用关系处理。

## 接口和数据链路

`POST /v1/voice-reference` 通过应用 Token 隔离 owner，接收 Base64 PCM WAV。检查 RIFF 边界、16kHz、单声道、16bit 和真实时长，然后上传，返回 ID 和时长。此处只校验文件结构，不宣称识别了说话人身份或录音环境质量。

`PUT /v1/transcription-service` 的可选 `voiceIdentity` 包含 `enabled` 和 `referenceId`。服务端拒绝其他 owner 的 ID、其他 provider、未配置存储、未提供样本或不支持的模型。

腾讯云支持 `16k_zh_en`、`16k_zh_en_2.0`。启用后使用 `SpeakerDiarization: 3` 与 `SpeakerRoles[{RoleAudioUrl,RoleName:"我"}]`；关闭时继续匿名分离。不能因为模型或存储不可用而静默退回匿名模式。此模式为增值服务，尚需真实账号权限和样本效果验收。

## 豆包方言

豆包标准版 `bigmodel` 在 language 留空时支持四川话等方言；当前适配器不强制指定普通话。腾讯云的参考声音选项不应用于豆包，也不会自动切换用户正在使用的 provider。需对同一段四川话进行实际转录对比后再判断准确率。
