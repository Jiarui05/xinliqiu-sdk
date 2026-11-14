/** Export contracts offline; this script does not start a listener, access credentials or submit audio. */
import { writeFileSync } from "node:fs";
import { createApp } from "../src/api/app.js";
import { Repository } from "../src/infrastructure/database.js";
const repo = new Repository(":memory:");
const app = createApp(repo, { providerConfigured: false, audioHosts: [] });
const response = await app.request("/openapi.json");
writeFileSync(
  "openapi.json",
  JSON.stringify(await response.json(), null, 2) + "\n",
);
repo.db.close();
