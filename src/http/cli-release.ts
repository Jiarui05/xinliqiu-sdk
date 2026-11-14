/** Serve only public, build-generated CLI assets; never expose the application data directory. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const types: Record<string, string> = {
  "latest.json": "application/json",
  "xq.mjs": "text/javascript",
  "openapi.json": "application/json",
  "SKILL.md": "text/markdown; charset=utf-8",
  "install.mjs": "text/javascript",
  "install.sh": "text/plain; charset=utf-8",
};
/** Exact filenames prevent requests from traversing into credentials or the SQLite volume. */
export function cliRelease(filename: string) {
  const root = process.env.XQ_CLI_RELEASE_DIR;
  if (!root || !Object.hasOwn(types, filename))
    return new Response("Not found", { status: 404 });
  const path = join(root, filename);
  if (!existsSync(path)) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(readFileSync(path)), {
    headers: {
      "Content-Type": types[filename]!,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
