import type { Db } from "../db/client";
import type { Role } from "../shared/enums";
import type { Permission } from "../shared/permissions";
import type { Auth } from "./auth";

/** The signed-in user, resolved from the session and the database. Never from client input. */
export type Actor = {
  userId: string;
  tenantId: string | null;
  email: string;
  name: string;
  agentCode: string | null;
  roles: readonly Role[];
  /** Functions granted to the user's roles in their tenant (RBAC). */
  permissions: readonly Permission[];
};

export type AppEnv = {
  Bindings: Env;
  Variables: { db: Db; auth: Auth; actor: Actor };
};

declare global {
  interface Env {
    // AI provider keys (Worker secrets). A provider without a key cannot be chosen.
    GEMINI_API_KEY?: string;
    DEEPSEEK_API_KEY?: string;
    QWEN_API_KEY?: string;
    // Encrypts the API keys GAs enter themselves (falls back to BETTER_AUTH_SECRET).
    AI_KEYS_SECRET?: string;
  }
}
