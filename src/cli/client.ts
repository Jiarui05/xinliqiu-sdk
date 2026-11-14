/**
 * @file client.ts
 * @description 封装 CLI 的 Token 鉴权请求；错误信息不包含凭据或签名地址。
 *
 * 职责与入口：
 * - 验证应用身份，不读取转录正文 → Client.me()
 * - 查询供应商及脱敏配置，不获取录音文字 → Client.transcriptionService()
 * - 通过与桌面端一致的 API 契约保存供应商配置 → Client.saveTranscriptionService()
 * - 查询匹配文字的数量和时间覆盖，不返回正文 → Client.stats()
 * - 按筛选条件与分页预算读取正文，返回词项和后续游标 → Client.read()
 * - 读取所属用户的任务状态，不暴露音频地址或供应商原文 → Client.job()
 * - 提交已校验的任务输入 → Client.submit()
 *
 * 边界：具体读写和执行时机以各入口为准；凭据与用户数据不得进入日志或发行包。
 */
import {
  getMe,
  getTranscriptionService,
  saveTranscriptionService,
  getTranscriptStats,
  getTranscripts,
  getJob,
  submitTranscriptionBatch,
} from "../generated/client.js";
import type { QueryFilters } from "../contracts.js";
/** 进程环境中的应用 Token 与供应商 API Key 相互独立。 */
export class Client {
  constructor(private token: string) {
    const base = process.env.XQ_API_URL ?? "http://127.0.0.1:4317";
    const u = new URL(base);
    if (
      u.protocol !== "https:" &&
      !(
        u.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)
      )
    )
      throw new Error("HTTPS required for remote API");
    if (u.username || u.password || u.search || u.hash)
      throw new Error("Invalid API base");
  }
  /** 为生成客户端设置同源鉴权请求参数，保留原有路由与查询条件。 */
  private options() {
    return {
      headers: { Authorization: `Bearer ${this.token}` },
      redirect: "error" as const,
      signal: AbortSignal.timeout(30000),
    };
  }
  /** 验证应用身份，不读取转录正文。 */
  async me() {
    return this.unwrap(await getMe(this.options()));
  }
  /** 查询供应商及脱敏配置，不获取录音文字。 */
  async transcriptionService() {
    return this.unwrap(await getTranscriptionService(this.options()));
  }
  /** 通过与桌面端一致的 API 契约保存供应商配置。 */
  async saveTranscriptionService(
    body: Parameters<typeof saveTranscriptionService>[0],
  ) {
    return this.unwrap(await saveTranscriptionService(body, this.options()));
  }
  /** 查询匹配文字的数量和时间覆盖，不返回正文。 */
  async stats(filters: Partial<QueryFilters>) {
    return this.unwrap(await getTranscriptStats(filters, this.options()));
  }
  /** 按筛选条件与分页预算读取正文，返回词项和后续游标。 */
  async read(
    filters: Partial<QueryFilters> = {},
    cursor = 0,
    maxChars = 2000,
    limit = 100,
  ) {
    return this.unwrap(
      await getTranscripts(
        { ...filters, cursor, maxChars, limit },
        this.options(),
      ),
    );
  }
  /** 读取所属用户的任务状态，不暴露音频地址或供应商原文。 */
  async job(id: string) {
    return this.unwrap(await getJob(id, this.options()));
  }
  /** 提交已校验的任务输入；该操作可能触发付费识别。 */
  async submit(body: Parameters<typeof submitTranscriptionBatch>[0]) {
    return this.unwrap(await submitTranscriptionBatch(body, this.options()));
  }
  /** 校验生成客户端返回的 HTTP 状态，失败响应不得当作成功数据使用。 */
  private unwrap<T extends { status: number; data: unknown }>(
    response: T,
  ): Extract<T, { status: 200 | 202 }>["data"] {
    if (response.status < 200 || response.status >= 300)
      throw new Error(`API_HTTP_${response.status}`);
    return response.data as Extract<T, { status: 200 | 202 }>["data"];
  }
}
