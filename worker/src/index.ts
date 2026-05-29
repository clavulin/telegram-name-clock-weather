// Worker entry point.
//
// The actual clock loop lives in the ClockDurableObject. The top-level Worker
// only routes a couple of HTTP endpoints to the single DO instance and (re)arms
// its alarm. There is one logical clock, so we pin to a fixed DO name.

import { ClockDurableObject } from "./clock-do";
import type { Env } from "./config";

export { ClockDurableObject, ClockDurableObject as ClockSchedulerV2 };

const SINGLETON_NAME = "clock";
const TOKEN_ENCODER = new TextEncoder();

function clockNamespace(env: Env): DurableObjectNamespace<ClockDurableObject> {
  const namespace = env.CLOCK_SCHEDULER ?? env.CLOCK;
  if (!namespace) {
    throw new Error("CLOCK_SCHEDULER Durable Object binding is required");
  }
  return namespace;
}

function digestToken(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", TOKEN_ENCODER.encode(value));
}

function constantTimeEqual(left: ArrayBuffer, right: ArrayBuffer): boolean {
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return diff === 0;
}

async function requireControlAccess(request: Request, env: Env): Promise<Response | null> {
  const expected = env.CONTROL_TOKEN?.trim();
  if (!expected) {
    return Response.json({ error: "CONTROL_TOKEN is required for /start and /status" }, { status: 503 });
  }

  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
  const provided = match?.[1]?.trim() ?? "";
  if (provided && constantTimeEqual(await digestToken(provided), await digestToken(expected))) return null;

  return Response.json(
    { error: "Unauthorized" },
    {
      status: 401,
      headers: { "www-authenticate": "Bearer" },
    },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      // Call once after deploy (or from a cron kicker) to ensure the alarm loop
      // is armed. Idempotent.
      case "/start": {
        const denied = await requireControlAccess(request, env);
        if (denied) return denied;
        const stub = clockNamespace(env).getByName(SINGLETON_NAME);
        await stub.start();
        return Response.json({ ok: true, alarmAt: (await stub.status()).alarmAt });
      }

      // Health/debug: last set name, last weather, next fire time.
      case "/status": {
        const denied = await requireControlAccess(request, env);
        if (denied) return denied;
        const stub = clockNamespace(env).getByName(SINGLETON_NAME);
        return Response.json(await stub.status());
      }

      default:
        return new Response("telegram-name-clock-weather worker\n", {
          headers: { "content-type": "text/plain" },
        });
    }
  },

  // Optional cron "kicker": only needed as a safety net to re-arm the alarm if
  // it was ever lost. The real scheduling is the DO's self-rescheduling alarm.
  // Enable by adding `"triggers": { "crons": ["* * * * *"] }` to wrangler.jsonc.
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const stub = clockNamespace(env).getByName(SINGLETON_NAME);
    await stub.start();
  },
} satisfies ExportedHandler<Env>;
