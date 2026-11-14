/** Verify generated artifacts against their checked-in bytes, including inside Docker without .git. */
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
