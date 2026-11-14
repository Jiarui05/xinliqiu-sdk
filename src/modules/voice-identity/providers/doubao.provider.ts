/**
 * @file doubao.provider.ts
 * @description 封装豆包声纹注册 HTTP 接口，错误中不返回供应商敏感原文。
 *
 * 职责与入口：
 * - 检查业务结果码，错误不得包含供应商原始消息或签名音频地址 → DoubaoEnrollmentApi.call()
 *
 * 边界：负责外部协议与结果规范化；不得记录密钥、签名地址或私人正文。
 */
import { jsonResponse } from "../../transcription-jobs/providers/qwen.provider.js";
/** 封装豆包声纹注册接口，负责鉴权和供应商结果校验。 */
export class DoubaoEnrollmentApi {
  constructor(private request: typeof fetch = fetch) {}
  /** 检查业务结果码，错误不得包含供应商原始消息或签名音频地址。 */
  async call(apiKey: string, action: string, body: object) {
    const response = await this.request(
      `https://openspeech.bytedance.com/api/proxy/invoke/?Action=${action}`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(20000),
        headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) throw new Error(`VOICEPRINT_HTTP_${response.status}`);
    const result = await jsonResponse(response);
    if (result.ResponseMetadata?.Error || result.Result?.Code !== 1000)
      throw new Error("VOICEPRINT_PROVIDER_REJECTED");
    return result.Result;
  }
}
