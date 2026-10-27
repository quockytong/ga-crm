import { env } from "cloudflare:test";
import { hashPassword } from "better-auth/crypto";
import { createDb } from "../src/db/client";
import { DEV_PASSWORD, seed } from "../src/db/seed";
import { app } from "../src/server/app";

export const db = createDb(env.DB);

export async function seedDb() {
  await seed(db, await hashPassword(DEV_PASSWORD));
}

type Init = { method?: string; json?: unknown; headers?: Record<string, string> };
export type Client = (path: string, init?: Init) => Promise<Response>;

async function request(path: string, init: Init = {}, cookie?: string): Promise<Response> {
  return app.request(
    path,
    {
      method: init.method ?? (init.json === undefined ? "GET" : "POST"),
      headers: {
        origin: env.APP_URL,
        ...(init.json === undefined ? {} : { "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}),
        ...init.headers,
      },
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    },
    env,
  );
}

/** Not signed in. */
export const anon: Client = (path, init) => request(path, init);

export async function signIn(email: string, password = DEV_PASSWORD) {
  return request("/api/auth/sign-in/email", { json: { email, password } });
}

const cookies = new Map<string, string>();

/** A client signed in (through the real sign-in endpoint) as the seeded user with this email. */
export async function as(email: string, password = DEV_PASSWORD): Promise<Client> {
  let cookie = cookies.get(email);
  if (!cookie) {
    const res = await signIn(email, password);
    if (!res.ok) throw new Error(`sign-in failed for ${email}: ${res.status} ${await res.text()}`);
    cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    cookies.set(email, cookie);
  }
  return (path, init) => request(path, init, cookie);
}

export const json = async <T = any>(res: Response): Promise<T> => (await res.json()) as T;
