#!/usr/bin/env node
/**
 * @file install-cli.mjs
 * @description 校验 CLI 发行文件并原子安装，保留用户凭据和已有可用版本。
 *
 * 职责与入口：
 * - 下载公开发行资源，不携带应用 Token，不跟随重定向 → download()
 * - 目标位置已有其他程序时拒绝覆盖，避免替换不属于本项目的命令 → checkExecutable()
 *
 * 边界：具体读写和执行时机以各入口为准；凭据与用户数据不得进入日志或发行包。
 */
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  mkdir,
  readFile,
  writeFile,
  mkdtemp,
  rename,
  symlink,
  readlink,
  rm,
  chmod,
  lstat,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
const { values } = parseArgs({
  options: {
    prefix: { type: "string", default: join(homedir(), ".local") },
    base: { type: "string", default: "https://xinliqiu.jiarui.ink" },
  },
});
const base = new URL(values.base);
if (
  base.protocol !== "https:" &&
  !(
    base.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
  )
)
  throw Error("HTTPS_REQUIRED");
if (
  base.username ||
  base.password ||
  base.search ||
  base.hash ||
  base.pathname !== "/"
)
  throw Error("INVALID_RELEASE_ORIGIN");
if (Number(process.versions.node.split(".")[0]) < 22)
  throw Error("NODE_22_REQUIRED");
const prefix = resolve(values.prefix),
  root = join(prefix, "share/xinliqiu-cli"),
  releases = join(root, "releases"),
  executable = join(prefix, "bin/xq");
/** 下载公开发行资源，不携带应用 Token，不跟随重定向。 */
async function download(name) {
  const r = await fetch(new URL("/cli/" + name, base), {
    redirect: "error",
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw Error(`RELEASE_HTTP_${r.status}`);
  if (Number(r.headers.get("content-length")) > 10000000)
    throw Error("RELEASE_TOO_LARGE");
  const bytes = Buffer.from(await r.arrayBuffer());
  if (bytes.length > 10000000) throw Error("RELEASE_TOO_LARGE");
  return bytes;
}
/** 目标位置已有其他程序时拒绝覆盖，避免替换不属于本项目的命令。 */
async function checkExecutable() {
  try {
    const stat = await lstat(executable);
    if (
      !stat.isSymbolicLink() ||
      (await readlink(executable)) !== join(root, "current/xq.mjs")
    )
      throw Error("EXECUTABLE_ALREADY_EXISTS");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}
let temp;
try {
  await checkExecutable();
  const manifest = JSON.parse((await download("latest.json")).toString());
  if (!/^\d+\.\d+\.\d+-[a-f0-9]{12}$/.test(manifest.release))
    throw Error("INVALID_RELEASE_ID");
  const names = ["xq.mjs", "openapi.json", "SKILL.md", "install.mjs"];
  if (names.some((n) => !/^[a-f0-9]{64}$/.test(manifest.files?.[n] ?? "")))
    throw Error("INVALID_RELEASE_MANIFEST");
  await mkdir(releases, { recursive: true });
  temp = await mkdtemp(join(releases, ".install-"));
  for (const name of names) {
    const bytes = await download(name);
    if (
      createHash("sha256").update(bytes).digest("hex") !== manifest.files[name]
    )
      throw Error("RELEASE_CHECKSUM_MISMATCH");
    await writeFile(join(temp, name), bytes);
  }
  await chmod(join(temp, "xq.mjs"), 0o755);
  await writeFile(
    join(temp, "install.json"),
    JSON.stringify({ prefix, base: base.origin, release: manifest.release }),
  );
  const target = join(releases, manifest.release);
  try {
    await rename(temp, target);
    temp = undefined;
  } catch (e) {
    if (!["EEXIST", "ENOTEMPTY"].includes(e.code)) throw e;
    for (const name of names)
      if (
        createHash("sha256")
          .update(await readFile(join(target, name)))
          .digest("hex") !== manifest.files[name]
      )
        throw Error("EXISTING_RELEASE_CORRUPTED");
  }
  const link = join(root, ".current-" + randomUUID());
  await symlink(target, link);
  await rename(link, join(root, "current"));
  await mkdir(join(prefix, "bin"), { recursive: true });
  const binLink = executable + "." + randomUUID();
  await symlink(join(root, "current/xq.mjs"), binLink);
  await rename(binLink, executable);
  console.log(
    JSON.stringify({
      installed: true,
      release: manifest.release,
      command: executable,
      next: "xq auth status; xq skill install",
    }),
  );
} catch (e) {
  console.error(
    JSON.stringify({
      error: /^[A-Z_0-9]+$/.test(e.message ?? "")
        ? e.message
        : "INSTALL_FAILED",
    }),
  );
  process.exitCode = 1;
} finally {
  if (temp) await rm(temp, { recursive: true, force: true });
}
