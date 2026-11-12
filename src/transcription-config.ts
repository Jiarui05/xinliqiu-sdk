/** Private, immutable provider configurations. Public views expose credential presence, never secret values. */
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
  linkSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import YAML from "yaml";
import { DoubaoVoiceprints } from "./doubao-voiceprint.js";
import type { VoiceReferences, VoiceReference } from "./voice-reference.js";
export const ProviderId = z.enum(["qwen", "tencent", "doubao"]);
export const ServiceInput = z.object({
  provider: ProviderId,
  model: z.string().trim().min(1).max(120),
  credentials: z.record(z.string(), z.string().max(4096)),
  voiceIdentity: z
    .object({ enabled: z.boolean(), referenceId: z.string().uuid().optional() })
    .optional(),
});
export type ServiceConfig = z.infer<typeof ServiceInput> & {
  id: string;
  voiceReference?: VoiceReference;
  voiceprintId?: string;
};
const Field = (
  key: string,
  label: string,
  secret = false,
  defaultValue = "",
) => ({ key, label, secret, required: true, defaultValue });
export const providers = [
  {
    id: "qwen",
    name: "千问",
    defaultModel: "qwen3-asr-flash-filetrans",
    fields: [
      Field("apiKey", "API Key", true),
      Field(
        "baseUrl",
        "API 地址",
        false,
        "https://dashscope.aliyuncs.com/api/v1",
      ),
    ],
  },
  {
    id: "tencent",
    name: "腾讯云",
    defaultModel: "16k_zh",
    fields: [
      Field("secretId", "SecretId", true),
      Field("secretKey", "SecretKey", true),
      Field("region", "地域", false, "ap-beijing"),
    ],
  },
  {
    id: "doubao",
    name: "豆包",
    defaultModel: "bigmodel",
    fields: [
      Field("apiKey", "API Key", true),
      Field("resourceId", "Resource ID", false, "volc.seedasr.auc"),
    ],
  },
] as const;
/** Publish YAML atomically. Immutable revisions and migrations cannot replace an existing file. */
function writeYaml(path: string, value: unknown, exclusive = false) {
  const temporary = path + "." + randomUUID() + ".tmp";
  writeFileSync(temporary, YAML.stringify(value), { mode: 0o600, flag: "wx" });
  try {
    if (exclusive) linkSync(temporary, path);
    else renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}
/** Import legacy JSON on demand; subsequent reads always use the editable YAML snapshot. */
function readRecord(folder: string, name: string): any {
  const file = join(folder, name + ".yaml");
  try {
    return YAML.parse(readFileSync(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("INVALID_PROVIDER_YAML");
  }
  const old = JSON.parse(readFileSync(join(folder, name + ".json"), "utf8"));
  try {
    writeYaml(file, old, true);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  try {
    return YAML.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error("INVALID_PROVIDER_YAML");
  }
}
/** Each owner has an atomic active pointer and append-only configuration revisions for running jobs. */
export class TranscriptionConfigs {
  constructor(
    private root: string,
    public voices?: VoiceReferences,
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
  }
  private folder(owner: string) {
    const p = join(this.root, createHash("sha256").update(owner).digest("hex"));
    mkdirSync(p, { recursive: true, mode: 0o700 });
    return p;
  }
  private manifest(owner: string): {
    activeConfigId: string | null;
    ids: string[];
  } {
    try {
      return readRecord(this.folder(owner), "index");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        return { activeConfigId: null, ids: [] };
      throw e;
    }
  }
  /** Resolve only a revision belonging to this owner. */
  get(owner: string, id: string): ServiceConfig {
    if (!this.manifest(owner).ids.includes(id))
      throw new Error("PROVIDER_CONFIG_NOT_FOUND");
    return readRecord(this.folder(owner), id);
  }
  active(owner: string) {
    const id = this.manifest(owner).activeConfigId;
    return id ? this.get(owner, id) : null;
  }
  /** Hide secrets in both list and save responses. */
  view(c: ServiceConfig) {
    const fields = providers.find((p) => p.id === c.provider)!.fields;
    return {
      id: c.id,
      provider: c.provider,
      model: c.model,
      credentials: Object.fromEntries(
        fields
          .filter((f) => !f.secret)
          .map((f) => [f.key, c.credentials[f.key]]),
      ),
      voiceIdentity: {
        enabled: c.voiceIdentity?.enabled ?? false,
        referenceId: c.voiceReference?.id,
        durationSeconds: c.voiceReference?.durationSeconds,
      },
      secrets: fields
        .filter((f) => f.secret && c.credentials[f.key])
        .map((f) => f.key),
    };
  }
  list(owner: string) {
    const m = this.manifest(owner);
    const latest = new Map<string, ServiceConfig>();
    for (const id of m.ids) {
      const c = this.get(owner, id);
      latest.set(c.provider, c);
    }
    return {
      activeConfigId: m.activeConfigId,
      providers,
      voiceStorageReady: this.voices?.ready ?? false,
      configurations: [...latest.values()].map((c) => this.view(c)),
    };
  }
  /** Register a confirmed reference before activating Doubao identity mode; failures preserve the active config. */
  async saveWithVoice(owner: string, value: unknown) {
    const input = ServiceInput.parse(value);
    if (input.provider !== "doubao" || !input.voiceIdentity?.enabled)
      return this.save(owner, input);
    if (
      Object.keys(input.credentials).some(
        (key) => !["apiKey", "resourceId"].includes(key),
      )
    )
      throw new Error("INVALID_PROVIDER_FIELD");
    const previous = [...this.manifest(owner).ids]
      .reverse()
      .map((id) => this.get(owner, id))
      .find((c) => c.provider === "doubao");
    const referenceId =
      input.voiceIdentity.referenceId ?? previous?.voiceReference?.id;
    const apiKey =
      input.credentials.apiKey?.trim() || previous?.credentials.apiKey;
    const resource = input.credentials.resourceId?.trim() || "volc.seedasr.auc";
    if (
      input.model !== "bigmodel" ||
      resource !== "volc.seedasr.auc" ||
      !referenceId ||
      !apiKey ||
      !this.voices?.ready
    )
      throw new Error("VOICE_MODE_NOT_READY");
    const reference = this.voices.get(owner, referenceId);
    const id = await new DoubaoVoiceprints(
      join(this.root, "voiceprints"),
    ).ensure(owner, referenceId, apiKey, () => this.voices!.url(reference));
    return this.save(owner, input, id);
  }
  /** Empty secret fields retain the previous provider credential; a completed revision is immutable. */
  save(owner: string, value: unknown, voiceprintId?: string) {
    const input = ServiceInput.parse(value);
    const m = this.manifest(owner);
    const previous = [...m.ids]
      .reverse()
      .map((id) => this.get(owner, id))
      .find((c) => c.provider === input.provider);
    const fields = providers.find((p) => p.id === input.provider)!.fields;
    if (
      Object.keys(input.credentials).some(
        (key) => !fields.some((f) => f.key === key),
      )
    )
      throw new Error("INVALID_PROVIDER_FIELD");
    const credentials: Record<string, string> = {};
    for (const f of fields) {
      const v =
        input.credentials[f.key]?.trim() ||
        (f.secret ? previous?.credentials[f.key] : undefined) ||
        f.defaultValue;
      if (!v) throw new Error("PROVIDER_CREDENTIAL_REQUIRED");
      credentials[f.key] = v;
    }
    if (input.provider === "qwen") {
      const u = new URL(credentials.baseUrl);
      if (
        u.protocol !== "https:" ||
        u.username ||
        u.password ||
        u.search ||
        u.hash
      )
        throw new Error("INVALID_PROVIDER_URL");
    }
    if (
      input.provider === "doubao" &&
      (input.model !== "bigmodel" ||
        ![
          "volc.seedasr.auc",
          "volc.bigasr.auc",
          "volc.bigasr.auc_turbo",
        ].includes(credentials.resourceId))
    )
      throw new Error("INVALID_PROVIDER_MODEL");
    let voiceReference: VoiceReference | undefined;
    if (input.voiceIdentity) {
      if (!["tencent", "doubao"].includes(input.provider))
        throw new Error("VOICE_PROVIDER_UNSUPPORTED");
      const id =
        input.voiceIdentity.referenceId ?? previous?.voiceReference?.id;
      if (id) voiceReference = this.voices?.get(owner, id);
      if (
        input.voiceIdentity.enabled &&
        (!voiceReference ||
          !this.voices?.ready ||
          (input.provider === "tencent"
            ? !["16k_zh_en", "16k_zh_en_2.0"].includes(input.model)
            : !voiceprintId))
      )
        throw new Error("VOICE_MODE_NOT_READY");
    }
    const c = {
      ...input,
      credentials,
      voiceReference,
      voiceprintId,
      id: randomUUID(),
    };
    const folder = this.folder(owner);
    writeYaml(join(folder, c.id + ".yaml"), c, true);
    writeYaml(join(folder, "index.yaml"), {
      activeConfigId: c.id,
      ids: [...m.ids, c.id],
    });
    return this.view(c);
  }
}
