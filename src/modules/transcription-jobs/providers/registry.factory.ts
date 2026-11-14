/**
 * @file registry.factory.ts
 * @description 适配腾讯云和豆包异步 ASR，并统一词项时间格式。
 *
 * 职责与入口：
 * - 每个词项写入持久存储前都要通过规范化校验 → word()
 * - 腾讯云词项时间以所属句子的开始时间为基准 → tencentWords()
 * - 豆包词项时间以提交音频的起点为基准 → doubaoWords()
 * - 列出当前输入需要执行的识别阶段，不发起网络请求 → SinglePass.passes()
 * - 将已完成的供应商结果转换为统一词项，保留时间和身份来源 → SinglePass.finish()
 * - 提交已校验的任务输入 → SinglePass.submit()
 * - 查询已有供应商任务，不重复提交识别请求 → SinglePass.poll()
 * - 提交已校验的任务输入 → TencentTranscription.submit()
 * - 查询已有供应商任务，不重复提交识别请求 → TencentTranscription.poll()
 * - 提交付费请求前，确认所选端点支持直接接收本机音频数据 → DoubaoTranscription.passes()
 * - 提交已校验的任务输入 → DoubaoTranscription.submit()
 * - 查询已有供应商任务，不重复提交识别请求 → DoubaoTranscription.poll()
 * - 按已固定的配置版本创建适配器，不受后续设置修改影响 → configuredProvider()
 *
 * 边界：负责外部协议与结果规范化；不得记录密钥、签名地址或私人正文。
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { readFile, stat } from "node:fs/promises";
import { Word, type TimedWord } from "../../../contracts.js";
import type { ReferenceStorage } from "../../voice-identity/voice-identity.service.js";
import type { JobInput } from "../transcription-jobs.types.js";
import {
  DashScope,
  jsonResponse,
  type Provider,
  type Pass,
} from "./qwen.provider.js";
import type { ServiceConfig } from "../../provider-settings/provider-settings.service.js";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const hmac = (key: string | Buffer, s: string) =>
  createHmac("sha256", key).update(s).digest();
/** 每个词项写入持久存储前都要通过规范化校验。 */
function word(
  text: string,
  startMs: number,
  endMs: number,
  speaker: unknown,
): TimedWord {
  return Word.parse({
    text,
    startMs,
    endMs,
    speaker: speaker === undefined || speaker === null ? null : String(speaker),
    emotion: null,
    timing: Array.from(text).length === 1 ? "character" : "word",
    speakerSource:
      speaker === undefined || speaker === null ? "unknown" : "provider",
  });
}
const TencentSentence = z.object({
  StartMs: z.number(),
  EndMs: z.number(),
  FinalSentence: z.string(),
  SpeakerId: z.union([z.number(), z.string()]).nullish(),
  Words: z
    .array(
      z.object({
        Word: z.string(),
        OffsetStartMs: z.number(),
        OffsetEndMs: z.number(),
      }),
    )
    .nullish(),
});
/** 腾讯云词项时间以所属句子的开始时间为基准。 */
export function tencentWords(raw: unknown): TimedWord[] {
  return z
    .array(TencentSentence)
    .parse(raw)
    .flatMap((s) =>
      s.Words?.length
        ? s.Words.map((w) =>
            word(
              w.Word,
              s.StartMs + w.OffsetStartMs,
              s.StartMs + w.OffsetEndMs,
              s.SpeakerId,
            ),
          )
        : [
            {
              ...word(s.FinalSentence, s.StartMs, s.EndMs, s.SpeakerId),
              timing: "sentence" as const,
            },
          ],
    );
}
const DoubaoSentence = z.object({
  start_time: z.number(),
  end_time: z.number(),
  text: z.string(),
  additions: z
    .object({
      speaker: z.union([z.string(), z.number()]).optional(),
      speaker_id: z.union([z.string(), z.number()]).optional(),
    })
    .optional(),
  words: z
    .array(
      z.object({
        text: z.string(),
        start_time: z.number(),
        end_time: z.number(),
      }),
    )
    .optional(),
});
/** 豆包词项时间以提交音频的起点为基准。 */
export function doubaoWords(
  raw: unknown,
  registeredVoiceId?: string,
): TimedWord[] {
  return z
    .object({ utterances: z.array(DoubaoSentence) })
    .parse(raw)
    .utterances.flatMap((s) => {
      const speaker = s.additions?.speaker ?? s.additions?.speaker_id;
      const sentence = () => [
        {
          ...word(s.text, s.start_time, s.end_time, speaker),
          timing: "sentence" as const,
        },
      ];
      if (!s.words?.length) return sentence();
      // 标准接口可能返回时间戳为 -1 的独立标点。
      // 从句子文本还原标点；正文词项缺少时间时回退到句级精度。
      const timed = s.words.filter(
        (w) => w.start_time >= 0 && w.end_time >= w.start_time,
      );
      if (
        !timed.length ||
        s.words.some(
          (w) =>
            (w.start_time < 0 || w.end_time < w.start_time) &&
            !/^[\p{P}\p{Z}\s]*$/u.test(w.text),
        )
      )
        return sentence();
      const tokens = timed.map((w) =>
        word(w.text, w.start_time, w.end_time, speaker),
      );
      let cursor = 0;
      for (let i = 0; i < tokens.length; i++) {
        const original = tokens[i].text,
          position = s.text.indexOf(original, cursor);
        if (position < 0) return sentence();
        const gap = s.text.slice(cursor, position);
        if (!/^[\p{P}\p{Z}\s]*$/u.test(gap)) return sentence();
        if (i > 0) tokens[i - 1].text += gap;
        else tokens[i].text = gap + original;
        cursor = position + original.length;
      }
      const tail = s.text.slice(cursor);
      if (!/^[\p{P}\p{Z}\s]*$/u.test(tail)) return sentence();
      tokens[tokens.length - 1].text += tail;
      return tokens.map((t) => Word.parse(t));
    })
    .map((w) =>
      registeredVoiceId && w.speaker === "我"
        ? { ...w, speakerSource: "voiceprint" as const }
        : w,
    );
}
/** 供应商轮询返回规范化词项；每个适配器只提交一次对应识别任务。 */
abstract class SinglePass implements Provider {
  /** 列出当前输入需要执行的识别阶段，不发起网络请求。 */
  passes(input: JobInput): Pass[] {
    if (input.mode === "emotion")
      throw new Error("PROVIDER_UNSUPPORTED_CAPABILITY");
    return ["transcription"];
  }
  /** 将已完成的供应商结果转换为统一词项，保留时间和身份来源。 */
  finish(results: Partial<Record<Pass, unknown>>): TimedWord[] {
    return z.array(Word).parse(results.transcription);
  }
  /** 提交已校验的任务输入；该操作可能触发付费识别。 */
  abstract submit(
    input: JobInput,
    pass: Pass,
  ): Promise<string | { completed: unknown }>;
  /** 查询已有供应商任务，不重复提交识别请求。 */
  abstract poll(id: string, pass: Pass): Promise<unknown | null>;
}
/** TC3 签名必须使用与实际 HTTPS 请求完全一致的序列化正文。 */
export class TencentTranscription extends SinglePass {
  constructor(
    private config: ServiceConfig,
    private request: typeof fetch = fetch,
    private referenceUrl?: () => string,
  ) {
    super();
  }
  /** 执行已签名或已鉴权的供应商请求，并检查返回状态。 */
  private async call(action: string, body: object) {
    const payload = JSON.stringify(body),
      timestamp = Math.floor(Date.now() / 1000),
      date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const headers =
      "content-type:application/json; charset=utf-8\nhost:asr.tencentcloudapi.com\n";
    const canonical = `POST\n/\n\n${headers}\ncontent-type;host\n${hash(payload)}`;
    const scope = `${date}/asr/tc3_request`,
      signing = hmac(
        hmac(hmac("TC3" + this.config.credentials.secretKey, date), "asr"),
        "tc3_request",
      );
    const signature = createHmac("sha256", signing)
      .update(`TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonical)}`)
      .digest("hex");
    const r = await this.request("https://asr.tencentcloudapi.com/", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-TC-Action": action,
        "X-TC-Version": "2019-06-14",
        "X-TC-Timestamp": String(timestamp),
        "X-TC-Region": this.config.credentials.region,
        Authorization: `TC3-HMAC-SHA256 Credential=${this.config.credentials.secretId}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`,
      },
      body: payload,
    });
    if (!r.ok) throw new Error("PROVIDER_HTTP_" + r.status);
    const result = (await jsonResponse(r)).Response;
    if (result?.Error) {
      if (result.Error.Code === "FailedOperation.UserHasNoAmount")
        throw new Error("PROVIDER_INSUFFICIENT_QUOTA");
      throw new Error("PROVIDER_REMOTE_ERROR");
    }
    if (!result?.Data) throw new Error("PROVIDER_RESPONSE_INVALID");
    return result.Data;
  }
  /** 开启身份识别后，不允许静默回退成匿名说话人分离。 */
  private voiceUrl() {
    if (
      !this.referenceUrl ||
      !["16k_zh_en", "16k_zh_en_2.0"].includes(this.config.model)
    )
      throw new Error("VOICE_MODE_NOT_READY");
    return this.referenceUrl();
  }
  /** 提交已校验的任务输入；该操作可能触发付费识别。 */
  async submit(input: JobInput) {
    const data = await this.call("CreateRecTask", {
      EngineModelType: this.config.model,
      ChannelNum: 1,
      ResTextFormat: 2,
      SourceType: 0,
      Url: input.audioUrl,
      SpeakerDiarization: this.config.voiceIdentity?.enabled ? 3 : 1,
      ...(this.config.voiceIdentity?.enabled
        ? { SpeakerRoles: [{ RoleAudioUrl: this.voiceUrl(), RoleName: "我" }] }
        : {}),
    });
    return String(z.number().int().positive().parse(data.TaskId));
  }
  /** 查询已有供应商任务，不重复提交识别请求。 */
  async poll(id: string) {
    const data = await this.call("DescribeTaskStatus", { TaskId: Number(id) });
    if (data.Status === 0 || data.Status === 1) return null;
    if (data.Status !== 2) throw new Error("PROVIDER_TASK_FAILED");
    return tencentWords(data.ResultDetail);
  }
}
/** 豆包使用调用方生成的请求 UUID 作为可持久化任务标识。 */
export class DoubaoTranscription extends SinglePass {
  constructor(
    private config: ServiceConfig,
    private request: typeof fetch = fetch,
    private audioStorage?: ReferenceStorage,
  ) {
    super();
  }
  /** 执行已签名或已鉴权的供应商请求，并检查返回状态。 */
  private async call(
    operation: "submit" | "query" | "recognize/flash",
    id: string,
    body: object,
  ) {
    const c = this.config.credentials;
    if (!c.apiKey && !(c.appId && c.accessToken))
      throw new Error("PROVIDER_NOT_CONFIGURED");
    const r = await this.request(
      "https://openspeech.bytedance.com/api/v3/auc/bigmodel/" + operation,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(
          operation === "recognize/flash" ? 90000 : 30000,
        ),
        headers: {
          "Content-Type": "application/json",
          ...(c.apiKey
            ? { "X-Api-Key": c.apiKey }
            : { "X-Api-App-Key": c.appId, "X-Api-Access-Key": c.accessToken }),
          "X-Api-Resource-Id": c.resourceId,
          "X-Api-Request-Id": id,
          "X-Api-Sequence": "-1",
        },
        body: JSON.stringify(body),
      },
    );
    const status = r.headers.get("X-Api-Status-Code");
    if (!r.ok) {
      if (status && /^\d{8}$/.test(status))
        throw new Error("PROVIDER_DOUBAO_" + status);
      throw new Error("PROVIDER_HTTP_" + r.status);
    }
    if (
      operation === "query" &&
      (status === "20000001" || status === "20000002")
    )
      return null;
    if (status === "20000003") return { utterances: [] };
    if (status !== "20000000") {
      const code = status && /^\d{8}$/.test(status) ? status : "UNKNOWN";
      throw new Error("PROVIDER_DOUBAO_" + code);
    }
    if (operation === "submit") return {};
    return (await jsonResponse(r)).result;
  }
  /** 提交付费请求前，确认所选端点支持直接接收本机音频数据。 */
  passes(input: JobInput): Pass[] {
    if (
      input.localAudio &&
      !["volc.bigasr.auc_turbo", "volc.seedasr.auc"].includes(
        this.config.credentials.resourceId,
      )
    )
      throw new Error("PROVIDER_LOCAL_AUDIO_REQUIRES_TURBO");
    if (
      this.config.voiceIdentity?.enabled &&
      (!this.config.voiceprintId ||
        this.config.credentials.resourceId !== "volc.seedasr.auc" ||
        (input.localAudio && !this.audioStorage))
    )
      throw new Error("PROVIDER_VOICE_MODE_NOT_READY");
    return super.passes(input);
  }
  /** 提交已校验的任务输入；该操作可能触发付费识别。 */
  async submit(input: JobInput) {
    this.passes(input);
    const identity = Boolean(this.config.voiceIdentity?.enabled);
    const id = randomUUID();
    const turbo =
      !identity &&
      (this.config.credentials.resourceId === "volc.bigasr.auc_turbo" ||
        Boolean(input.localAudio));
    let audio: Record<string, string> = {
      url: input.audioUrl,
      format: input.audioFormat ?? "wav",
    };
    if (input.localAudio) {
      const metadata = await stat(input.localAudio.path);
      if (metadata.size <= 0 || metadata.size > 20 * 1024 * 1024)
        throw new Error("PROVIDER_LOCAL_AUDIO_SIZE_LIMIT");
      const data = await readFile(input.localAudio.path);
      if (
        createHash("sha256").update(data).digest("hex") !==
        input.localAudio.sha256
      )
        throw new Error("PROVIDER_LOCAL_AUDIO_CHECKSUM");
      if (identity) {
        const key = `asr-inputs/${input.localAudio.sha256}.wav`;
        await this.audioStorage!.put(key, data);
        audio = {
          url: this.audioStorage!.url(key),
          format: input.audioFormat ?? "wav",
        };
      } else {
        audio = {
          data: data.toString("base64"),
          format: input.audioFormat ?? "wav",
        };
      }
    }
    const result = await this.call(turbo ? "recognize/flash" : "submit", id, {
      user: { uid: "xinliqiu" },
      audio,
      request: {
        model_name: this.config.model,
        enable_itn: false,
        enable_punc: true,
        enable_ddc: false,
        enable_speaker_info: true,
        show_utterances: true,
        ...(identity
          ? {
              ssd_version: "300",
              voiceprints: [{ id: this.config.voiceprintId }],
            }
          : {}),
      },
    });
    return turbo
      ? {
          completed: doubaoWords(
            result,
            this.config.voiceIdentity?.enabled
              ? this.config.voiceprintId
              : undefined,
          ),
        }
      : id;
  }
  /** 查询已有供应商任务，不重复提交识别请求。 */
  async poll(id: string) {
    const raw = await this.call("query", id, {});
    return raw === null
      ? null
      : doubaoWords(
          raw,
          this.config.voiceIdentity?.enabled
            ? this.config.voiceprintId
            : undefined,
        );
  }
}
/** 按已固定的配置版本创建适配器，不受后续设置修改影响。 */
export function configuredProvider(
  c: ServiceConfig,
  resultHosts?: string[],
  referenceUrl?: () => string,
  audioStorage?: ReferenceStorage,
): Provider {
  if (c.provider === "tencent")
    return new TencentTranscription(c, fetch, referenceUrl);
  if (c.provider === "doubao")
    return new DoubaoTranscription(c, fetch, audioStorage);
  return new DashScope(
    c.credentials.baseUrl,
    c.credentials.apiKey,
    resultHosts?.length
      ? resultHosts
      : [
          "dashscope-result-bj.oss-cn-beijing.aliyuncs.com",
          "dashscope-result-sh.oss-cn-shanghai.aliyuncs.com",
          "dashscope-result-sg.oss-ap-southeast-1.aliyuncs.com",
        ],
    c.model,
  );
}
