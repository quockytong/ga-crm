import { Hono } from "hono";
import { csrf } from "hono/csrf";
import type { AppEnv } from "./env";
import { ApiError } from "./errors";
import { requireAuth, withDb } from "./middleware";
import { agentRoutes } from "./routes/agents";
import { aiRoutes } from "./routes/ai";
import { importRoutes } from "./routes/imports";
import { clientRoutes } from "./routes/clients";
import { leadRoutes } from "./routes/leads";
import { inviteRoutes } from "./routes/invites";
import { meRoutes } from "./routes/me";
import { permissionRoutes } from "./routes/permissions";
import { platformRoutes } from "./routes/platform";
import { reportRoutes } from "./routes/reports";
import { userRoutes } from "./routes/users";

const api = new Hono<AppEnv>()
  .use(withDb)
  // Better Auth does its own origin checks on its routes.
  .on(["GET", "POST"], "/auth/*", (c) => c.get("auth").handler(c.req.raw))
  .use((c, next) => csrf({ origin: c.env.APP_URL })(c, next))
  .route("/invites", inviteRoutes)
  .use(requireAuth)
  .route("/me", meRoutes)
  .route("/users", userRoutes)
  .route("/agents", agentRoutes)
  .route("/imports", importRoutes)
  .route("/leads", leadRoutes)
  .route("/clients", clientRoutes)
  .route("/reports", reportRoutes)
  .route("/ai", aiRoutes)
  .route("/permissions", permissionRoutes)
  .route("/platform", platformRoutes);

export const app = new Hono<AppEnv>()
  .route("/api", api)
  .notFound((c) => c.json({ error: "not_found" }, 404))
  .onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: err.code }, err.status);
    console.error(err);
    return c.json({ error: "internal" }, 500);
  });
