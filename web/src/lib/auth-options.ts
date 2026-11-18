import type { BetterAuthOptions } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { getPool } from "./db";

/**
 * Shared Better Auth options. Table names are prefixed so they never collide
 * with the reserved Postgres word "user" or with app tables.
 */
export function authOptions(): BetterAuthOptions {
  return {
    appName: "Matchframe2D Replayer",
    baseURL: process.env.APP_ORIGIN ?? "http://localhost:3000",
    secret: process.env.AUTH_SECRET,
    database: getPool(),
    emailAndPassword: { enabled: true, minPasswordLength: 10, autoSignIn: true, disableSignUp: process.env.ALLOW_SIGNUP === "0" },
    user: { modelName: "auth_user" },
    session: { modelName: "auth_session", expiresIn: 60 * 60 * 24 * 14 },
    account: { modelName: "auth_account" },
    verification: { modelName: "auth_verification" },
    advanced: { database: { generateId: () => crypto.randomUUID() } },
    // Built-in per-instance rate limiting stays on in production; AUTH_RATE_LIMIT=0 is for test environments only.
    rateLimit: { enabled: process.env.AUTH_RATE_LIMIT === "0" ? false : undefined },
    plugins: [nextCookies()],
  };
}
