/** Build a portable CLI release from public source assets only; no personal configuration is packaged. */
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
