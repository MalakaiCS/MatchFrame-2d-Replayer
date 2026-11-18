import { betterAuth } from "better-auth";
import { authOptions } from "./auth-options";

declare global {
  // eslint-disable-next-line no-var
  var __mfAuth: ReturnType<typeof betterAuth> | undefined;
}

export function getAuth() {
  if (!globalThis.__mfAuth) globalThis.__mfAuth = betterAuth(authOptions());
  return globalThis.__mfAuth;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

export async function getUser(headers: Headers): Promise<SessionUser | null> {
  const s = await getAuth().api.getSession({ headers });
  if (!s?.user) return null;
  return { id: s.user.id, email: s.user.email, name: s.user.name };
}
