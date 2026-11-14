/**
 * @file check-generated.ts
 * @description 离线重新生成并比对已提交契约；没有 Git 目录的 Docker 环境也能执行。
 *
 * 职责与入口：
 * - 模块初始化与配置 → 本文件的顶层声明或命令入口
 *
 * 边界：具体读写和执行时机以各入口为准；凭据与用户数据不得进入日志或发行包。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const paths = ["openapi.json", "src/generated/client.ts"];
const before = paths.map((path) => readFileSync(path));
try {
  execFileSync("pnpm", ["client:generate"], { stdio: "pipe" });
  const changed = paths.filter(
    (path, i) => !readFileSync(path).equals(before[i]!),
  );
  if (changed.length)
    throw Error(
      "Generated contract drift: " +
        changed.join(", ") +
        "; run pnpm client:generate and commit the outputs",
    );
  console.log("Generated contracts match");
} finally {
  paths.forEach((path, i) => writeFileSync(path, before[i]!));
}
