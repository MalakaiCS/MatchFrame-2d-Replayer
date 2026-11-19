/**
 * Login gate for the app. The public website ("/"), auth pages and the API pass through; the
 * library, upload, teams and playlist pages send signed-out visitors to /login and back again.
 *
 * Replay pages (/replays/<id>) are not gated here: a read-only or round link carries its token in
 * the URL fragment, which never reaches the server. The viewer asks the API and sends signed-out
 * visitors without a valid link to /login itself. This check only looks for the session cookie;
 * every API route still verifies the session.
 */
import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

export function proxy(req: NextRequest) {
  if (getSessionCookie(req)) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/replays", "/replays/new", "/replays/team", "/replays/compare", "/replays/multi", "/teams", "/teams/:path*", "/playlists/:path*", "/billing", "/stats", "/stats/team", "/stats/rounds", "/stats/me", "/antistrat", "/join/:path*", "/tactics", "/tactics/:path*"],
};
