import { NextResponse } from "next/server";
import { ZodError } from "zod";

export const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Vary: "Cookie, X-Share-Token",
};

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const notFound = () => new HttpError(404, "NOT_FOUND", "Not found.");
export const unauthorized = () => new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
export const forbidden = (msg = "You do not have access to this resource.") => new HttpError(403, "FORBIDDEN", msg);
export const badRequest = (msg: string, code = "BAD_REQUEST") => new HttpError(400, code, msg);
export const conflict = (msg: string, code = "CONFLICT") => new HttpError(409, code, msg);

export function json(data: unknown, init: ResponseInit = {}) {
  return NextResponse.json(data, { ...init, headers: { ...PRIVATE_HEADERS, ...(init.headers ?? {}) } });
}

type Handler<C> = (req: Request, ctx: C) => Promise<Response>;

/** Wrap a route handler: typed errors -> JSON, never log share tokens or bodies. */
export function route<C>(h: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    try {
      return await h(req, ctx);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: { code: e.code, message: e.message } }, { status: e.status });
      if (e instanceof ZodError) {
        return json({ error: { code: "VALIDATION", message: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") } }, { status: 400 });
      }
      console.error(`[api] ${req.method} ${new URL(req.url).pathname} failed:`, e instanceof Error ? e.message : e);
      return json({ error: { code: "INTERNAL", message: "Something went wrong. Try again." } }, { status: 500 });
    }
  };
}

export async function body<T>(req: Request, schema: { parse: (v: unknown) => T }): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw badRequest("Request body must be JSON.");
  }
  return schema.parse(raw);
}
