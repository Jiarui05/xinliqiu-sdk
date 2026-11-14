/** One-time local-file transfer to the existing DashScope account's private, model-bound temporary storage. */
import { readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
const Policy = z.object({
  policy: z.string().min(1),
  signature: z.string().min(1),
  upload_dir: z.string().startsWith("dashscope-instant/"),
  upload_host: z.string().url(),
  max_file_size_mb: z.coerce.number().positive(),
  oss_access_key_id: z.string().min(1),
  x_oss_object_acl: z.literal("private"),
  x_oss_forbid_overwrite: z.literal("true"),
});
/** Upload credentials remain in memory; filenames disclose neither device identity nor source paths. */
export async function temporaryUpload(
  base: string,
  key: string,
  model: "fun-asr" | "qwen3-asr-flash-filetrans",
  path: string,
) {
  const endpoint = new URL(base + "/uploads");
  endpoint.searchParams.set("action", "getPolicy");
  endpoint.searchParams.set("model", model);
  const r = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(20000),
    redirect: "error",
  });
  if (!r.ok) throw new Error(`UPLOAD_POLICY_HTTP_${r.status}`);
  const p = Policy.parse((await r.json()).data);
  const host = new URL(p.upload_host);
  if (
    host.protocol !== "https:" ||
    host.port ||
    host.username ||
    host.password ||
    !/^dashscope-file-[a-z0-9-]+\.oss-(cn-beijing|ap-southeast-1)\.aliyuncs\.com$/.test(
      host.hostname,
    ) ||
    p.upload_dir.split("/").includes("..")
  )
    throw new Error("UPLOAD_DESTINATION_REJECTED");
  const size = (await stat(path)).size;
  if (size <= 0 || size > Math.min(100, p.max_file_size_mb) * 1024 * 1024)
    throw new Error("UPLOAD_SIZE_LIMIT");
  const name = randomUUID() + ".flac",
    object = p.upload_dir + "/" + name;
  const form = new FormData();
  for (const [field, value] of Object.entries({
    OSSAccessKeyId: p.oss_access_key_id,
    policy: p.policy,
    Signature: p.signature,
    key: object,
    "x-oss-object-acl": "private",
    "x-oss-forbid-overwrite": "true",
    success_action_status: "200",
  }))
    form.append(field, value);
  form.append(
    "file",
    new Blob([await readFile(path)], { type: "audio/flac" }),
    name,
  );
  const uploaded = await fetch(host, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(180000),
    redirect: "error",
  });
  if (uploaded.status !== 200)
    throw new Error(`UPLOAD_HTTP_${uploaded.status}`);
  await uploaded.body?.cancel();
  return "oss://" + object;
}
