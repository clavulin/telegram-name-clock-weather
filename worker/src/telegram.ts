// Telegram MTProto wrapper around GramJS (`telegram` npm package — the JS port
// of Telethon). Replaces telethon usage in main.py.
//
// Workers specifics:
//   * Requires `nodejs_compat` (GramJS uses Buffer/crypto/events/stream).
//   * GramJS's default connection is WebSocket in browser-like envs; on Workers
//     it can also run over `cloudflare:sockets` connect(). Pick the transport
//     that connects reliably from the runtime — verify during implementation.
//   * Construct the client INSIDE a handler/alarm (no sockets in global scope).
//
// Session: TG_STRING_SESSION must be a GramJS StringSession (generate via
// scripts/login.mjs). The Telethon string from the Python app is NOT compatible.

import type { Env } from "./config";

export interface TelegramClientHandle {
  /** True if the underlying MTProto connection is currently usable. */
  isConnected(): boolean;
  /** Set the account first_name (UpdateProfileRequest equivalent). Returns the confirmed name. */
  updateProfileName(firstName: string): Promise<string>;
  disconnect(): Promise<void>;
}

function requireText(value: string | undefined, name: string): string {
  const text = value?.trim() ?? "";
  if (!text) throw new Error(`${name} is required`);
  return text;
}

export async function connectTelegram(env: Env): Promise<TelegramClientHandle> {
  const apiId = Number(requireText(env.TG_API_ID, "TG_API_ID"));
  if (!Number.isFinite(apiId)) {
    throw new Error("TG_API_ID must be numeric");
  }
  const apiHash = requireText(env.TG_API_HASH, "TG_API_HASH");
  const session = requireText(env.TG_STRING_SESSION, "TG_STRING_SESSION");

  const [{ Api, TelegramClient }, { StringSession }] = await Promise.all([
    import("telegram"),
    import("telegram/sessions/index.js"),
  ]);
  const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 5,
  });
  // NOTE: GramJS starts keepalive/ping timers once connected, which would keep
  // the Durable Object pinned in memory (continuous GB-s billing). The DO closes
  // this client at the end of every alarm tick (see ClockDurableObject), so the
  // connection only lives for the few seconds it takes to push one rename.
  await client.connect();
  const me = await client.getMe();
  console.log(`[INIT] Current Telegram first_name -> ${me.firstName ?? ""}`);

  return {
    isConnected: () => client.connected === true && !client.disconnected,
    updateProfileName: async (firstName: string) => {
      await client.invoke(new Api.account.UpdateProfile({ firstName }));
      const confirmed = await client.getMe();
      return confirmed.firstName ?? "";
    },
    disconnect: async () => {
      await client.disconnect();
    },
  };
}
