/** Resolve and persist CLI root credentials in private YAML without exposing them in arguments or output. */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  chmodSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import YAML from "yaml";
import { Client } from "./client.js";

/** An explicit CLI config takes precedence over the standard cloud YAML shared with local text replication. */
export function configPath() {
  return (
    process.env.XQ_CLI_CONFIG ?? join(homedir(), ".config/xinliqiu/cloud.yaml")
  );
}
/** Parse errors never echo YAML lines that may contain credentials. */
function saved(): Record<string, unknown> {
  if (!existsSync(configPath())) return {};
  try {
    const value = YAML.parse(readFileSync(configPath(), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error();
    return value;
  } catch {
    throw Error("CONFIG_INVALID");
  }
}
/** Keep library and mirror settings intact when changing only CLI login fields. */
function save(value: Record<string, unknown>) {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + "." + randomUUID();
  writeFileSync(temp, YAML.stringify(value), { mode: 0o600, flag: "wx" });
  renameSync(temp, path);
  chmodSync(path, 0o600);
}
/** Environment overrides remain available for CI; ordinary interactive use reads the saved YAML. */
export function cliClient() {
  const config = saved();
  process.env.XQ_API_URL ??=
    typeof config.url === "string" ? config.url : "https://xinliqiu.jiarui.ink";
  const token =
    process.env.XQ_TOKEN ??
    (process.env.XQ_TOKEN_FILE
      ? readFileSync(process.env.XQ_TOKEN_FILE, "utf8").trim()
      : config.token);
  if (typeof token !== "string" || !token)
    throw Error("ROOT_TOKEN_REQUIRED: use xq auth login --token-stdin");
  return new Client(token);
}
/** Verify the supplied root token before persisting it; no token is printed. */
export async function login(base: string, token: string) {
  process.env.XQ_API_URL = base.replace(/\/$/, "");
  if (token.length < 32 || token.length > 512)
    throw Error("INVALID_ROOT_TOKEN");
  const identity = await new Client(token).me();
  save({ ...saved(), url: process.env.XQ_API_URL, token });
  return {
    authenticated: true,
    owner: identity.owner,
    url: process.env.XQ_API_URL,
    config: configPath(),
  };
}
/** Forget local credentials only; revocation is a separate server operation. */
export function logout() {
  const config = saved();
  delete config.token;
  save(config);
  return { removed: true, revoked: false };
}
