/**
 * @file contracts.ts
 * @description 集中导出公开 API 校验结构和领域类型，供生成客户端与 CLI 使用。
 *
 * 职责与入口：
 * - 模块初始化与配置 → 本文件的顶层声明或命令入口
 *
 * 边界：具体读写和执行时机以各入口为准；凭据与用户数据不得进入日志或发行包。
 */
export * from "./modules/transcripts/transcripts.schema.js";
export * from "./modules/transcription-jobs/transcription-jobs.schema.js";
export * from "./api/schema.js";
export type {
  QueryFilters,
  TimedWord,
} from "./modules/transcripts/transcripts.types.js";
export type { RecordingInput } from "./modules/transcription-jobs/transcription-jobs.types.js";
