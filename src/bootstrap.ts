/** Register an operator-created application token from stdin; never print token values. */
import { mkdirSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { Repository } from "./repository.js";
const folder = process.env.XQ_DATA_DIR ?? ".data";
mkdirSync(folder, { recursive: true, mode: 0o700 });
chmodSync(folder, 0o700);
process.umask(0o077);
const repo = new Repository(join(folder, "backend.sqlite"));
const token = readFileSync(0, "utf8").trim();
repo.token(token, process.env.XQ_OWNER ?? "local");
repo.db.close();
console.log(JSON.stringify({ created: true, expires: false }));
