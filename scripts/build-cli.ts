/**
 * @file build-cli.ts
 * @description 仅使用公开源码资源构建独立 CLI 发行包，不打包用户配置。
 *
 * 职责与入口：
 * - 模块初始化与配置 → 本文件的顶层声明或命令入口
 *
 * 边界：具体读写和执行时机以各入口为准；凭据与用户数据不得进入日志或发行包。
 */
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
const output = "cli-release";
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
mkdirSync(output, { recursive: true });
await build({
  entryPoints: ["src/cli/main.ts"],
  outfile: join(output, "xq.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  banner: {
    js: 'import {createRequire as __nodeCreateRequire} from "node:module"; const require=__nodeCreateRequire(import.meta.url);',
  },
  target: "node22",
  define: { XQ_CLI_VERSION: JSON.stringify(version) },
});
for (const [source, name] of [
  ["openapi.json", "openapi.json"],
  ["skill/SKILL.md", "SKILL.md"],
  ["scripts/install-cli.mjs", "install.mjs"],
  ["scripts/install-cli.sh", "install.sh"],
])
  copyFileSync(source!, join(output, name!));
const files = Object.fromEntries(
  ["xq.mjs", "openapi.json", "SKILL.md", "install.mjs"].map((name) => [
    name,
    createHash("sha256")
      .update(readFileSync(join(output, name)))
      .digest("hex"),
  ]),
);
const release =
  version +
  "-" +
  createHash("sha256").update(JSON.stringify(files)).digest("hex").slice(0, 12);
writeFileSync(
  join(output, "latest.json"),
  JSON.stringify({ version, release, files }),
);
console.log(JSON.stringify({ release, files: Object.keys(files) }));
