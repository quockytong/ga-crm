import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { aiProviderKeys } from "../../db/schema";
import { AI_PROVIDERS, PROVIDER_INFO, type AiProvider } from "../../shared/ai";
import { inTenant, type Scope } from "../scope";

/**
 * Provider API keys. A GA Head may store the GA's own key per provider; it is encrypted
 * (AES-GCM, key derived from AI_KEYS_SECRET, else BETTER_AUTH_SECRET) and never sent back
 * to the browser, only its last 4 characters. Without a GA key, the platform's Worker
 * secret is used. Rotating the secret makes stored keys unreadable: GA Heads re-enter them.
 */

export type AiKeys = Partial<Record<AiProvider, string>>;
export type KeySource = "GA" | "PLATFORM" | null;

async function cryptoKey(env: Env): Promise<CryptoKey> {
  const secret = env.AI_KEYS_SECRET || env.BETTER_AUTH_SECRET;
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("ga-crm"), info: new TextEncoder().encode("ai-provider-keys") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** "iv.ciphertext", both base64. The tenant and provider are bound as additional data. */
export async function encryptKey(env: Env, tenantId: string, provider: AiProvider, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(`${tenantId}:${provider}`) },
    await cryptoKey(env),
    new TextEncoder().encode(plain),
  );
  return `${b64(iv)}.${b64(new Uint8Array(data))}`;
}

async function decryptKey(env: Env, tenantId: string, provider: AiProvider, stored: string): Promise<string | null> {
  const [iv, data] = stored.split(".");
  if (!iv || !data) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(iv), additionalData: new TextEncoder().encode(`${tenantId}:${provider}`) },
      await cryptoKey(env),
      unb64(data),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

/** Keys usable by the GA: its own first, then the platform's. */
export async function loadKeys(db: Db, env: Env, scope: Scope): Promise<{ keys: AiKeys; source: Record<AiProvider, KeySource> }> {
  const rows = await db.select().from(aiProviderKeys).where(inTenant(scope, aiProviderKeys));
  const keys: AiKeys = {};
  const source = {} as Record<AiProvider, KeySource>;
  for (const p of AI_PROVIDERS) {
    const row = rows.find((r) => r.provider === p);
    const own = row ? await decryptKey(env, scope.tenantId, p, row.encryptedKey) : null;
    const platform = env[PROVIDER_INFO[p].secret];
    keys[p] = own ?? platform ?? undefined;
    source[p] = own ? "GA" : platform ? "PLATFORM" : null;
  }
  return { keys, source };
}

export async function keyRow(db: Db, scope: Scope, provider: AiProvider) {
  return db
    .select()
    .from(aiProviderKeys)
    .where(and(inTenant(scope, aiProviderKeys), eq(aiProviderKeys.provider, provider)))
    .get();
}
