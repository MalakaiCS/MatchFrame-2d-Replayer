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
    emailAndPassword: { enabled: true, minPasswordLength: 10, autoSignIn: true },
    user: { modelName: "auth_user" },
    session: { modelName: "auth_session", expiresIn: 60 * 60 * 24 * 14 },
    account: { modelName: "auth_account" },
    verification: { modelName: "auth_verification" },
    advanced: { database: { generateId: () => crypto.randomUUID() } },
    plugins: [nextCookies()],
  };
}
