// QWeather dynamic JWT (EdDSA / Ed25519).
//
// Porting note: main.py used the `cryptography` library to load the key and sign.
// Workers' Web Crypto natively supports Ed25519 (algorithm name "Ed25519"), so
// this ports cleanly with crypto.subtle — no external dependency.
//
//   header  = base64url({"alg":"EdDSA","kid":QW_KEY_ID})
//   payload = base64url({"sub":QW_PROJECT_ID,"iat":..,"exp":..})
//   sig     = base64url(Ed25519-sign(`${header}.${payload}`))
//
// QW_PRIVATE_KEY may be PEM ("-----BEGIN PRIVATE KEY-----") or base64 DER (PKCS#8).
// crypto.subtle.importKey("pkcs8", der, {name:"Ed25519"}, false, ["sign"]).

import type { Env } from "./config";

export function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let index = 0; index < view.length; index += 1) {
    binary += String.fromCharCode(view[index] ?? 0);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function privateKeyTextToPkcs8(keyText: string): Uint8Array {
  const trimmed = keyText.trim();
  const body = trimmed.startsWith("-----BEGIN")
    ? trimmed
        .replace(/-----BEGIN [^-]+-----/g, "")
        .replace(/-----END [^-]+-----/g, "")
        .replace(/\s+/g, "")
    : trimmed.replace(/\s+/g, "");

  if (!body) {
    throw new Error("QW_PRIVATE_KEY is empty");
  }
  return base64ToBytes(body);
}

export async function importEd25519PrivateKey(keyText: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    privateKeyTextToPkcs8(keyText),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
}

/** Ported from build_qweather_jwt (main.py:207). */
export async function buildQweatherJwt(env: Env, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const kid = (env.QW_KEY_ID ?? env.QW_JWT_KID)?.trim();
  const sub = env.QW_PROJECT_ID?.trim();
  const privateKeyText = (env.QW_PRIVATE_KEY ?? env.QW_JWT_PRIVATE_KEY)?.trim();
  if (!kid || !sub || !privateKeyText) {
    throw new Error("QW_PROJECT_ID plus QW_KEY_ID/QW_JWT_KID and QW_PRIVATE_KEY/QW_JWT_PRIVATE_KEY are required for dynamic QWeather JWT auth");
  }

  const ttlSeconds = Number(env.QW_JWT_TTL_SECONDS || "900");
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error("QW_JWT_TTL_SECONDS must be a positive number");
  }

  const iat = Math.floor(nowSeconds) - 30;
  const exp = iat + Math.floor(ttlSeconds);
  const textEncoder = new TextEncoder();
  const header = base64UrlEncode(textEncoder.encode(JSON.stringify({ alg: "EdDSA", kid })));
  const payload = base64UrlEncode(textEncoder.encode(JSON.stringify({ sub, iat, exp })));
  const signingInput = `${header}.${payload}`;
  const key = await importEd25519PrivateKey(privateKeyText);
  const signature = await crypto.subtle.sign("Ed25519", key, textEncoder.encode(signingInput));
  return `${signingInput}.${base64UrlEncode(signature)}`;
}
