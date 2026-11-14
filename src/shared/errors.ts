/**
 * @file errors.ts
 * @description 定义稳定的业务错误码，不携带 HTTP 状态或私有诊断内容。
 *
 * 职责与入口：
 * - 定义稳定的业务错误码，不携带 HTTP 状态或私有诊断内容 → DomainError
 *
 * 边界：具体读写和执行时机以各入口为准；凭据与用户数据不得进入日志或发行包。
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
