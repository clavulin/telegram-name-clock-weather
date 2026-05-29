// One-time interactive login to generate a GramJS StringSession.
//
//   cd worker && npm install && node scripts/login.mjs
//
// Paste the printed string into TG_STRING_SESSION (.dev.vars locally, or
//   wrangler secret put TG_STRING_SESSION
// for production). This runs on plain Node, NOT in the Worker.
//
// Reuses TG_API_ID / TG_API_HASH from the environment if present, otherwise
// prompts for them.

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import input from "input"; // tiny prompt helper; add with `npm i -D input` if missing

const apiId = Number(process.env.TG_API_ID || (await input.text("api_id: ")));
const apiHash = process.env.TG_API_HASH || (await input.text("api_hash: "));

const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
  connectionRetries: 5,
});

await client.start({
  phoneNumber: async () => await input.text("phone (+...): "),
  password: async () => await input.text("2FA password (blank if none): "),
  phoneCode: async () => await input.text("login code: "),
  onError: (err) => console.error(err),
});

console.log("\n=== TG_STRING_SESSION ===");
console.log(client.session.save());
console.log("=========================\n");
await client.disconnect();
process.exit(0);
