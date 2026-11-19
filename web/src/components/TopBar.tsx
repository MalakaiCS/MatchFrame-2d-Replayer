"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { authClient } from "./auth-client";
import { Wordmark } from "./icons";

const NAV = [
  { href: "/replays", label: "Personal" },
  { href: "/replays/team", label: "Team" },
  { href: "/replays/new", label: "Upload" },
  { href: "/stats", label: "Stats" },
  { href: "/teams", label: "Teams" },
  { href: "/billing", label: "Plans" },
];

export function TopBar() {
  const path = usePathname();
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const site = path === "/";
  return (
    <header className={site ? "topbar topbar-mk" : "topbar"}>
      <a href="#main" className="sr-only">Skip to content</a>
      <Link href={session && !site ? "/replays" : "/"} className="wordmark" aria-label="Matchframe2D home">
        <Wordmark />
        <span>Matchframe2D <small>Replayer</small></span>
      </Link>
      {site ? (
        <nav className="mknav" aria-label="Site">
          <a href="#features">Features</a>
          <a href="#how">How it works</a>
          <a href="#maps">Maps</a>
          <a href="#plans">Plans</a>
          <a href="#faq">FAQ</a>
        </nav>
      ) : session ? (
        <nav className="topnav" aria-label="Main">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} aria-current={path === n.href ? "page" : undefined}>{n.label}</Link>
          ))}
        </nav>
      ) : null}
      <div className="topbar-spacer" />
      {isPending ? null : site ? (
        <div className="row">
          {session ? <Link className="btn btn-primary btn-sm" href="/replays">Open library</Link> : (
            <>
              <Link className="btn btn-ghost btn-sm" href="/login">Sign in</Link>
              <Link className="btn btn-primary btn-sm" href="/signup">Get started</Link>
            </>
          )}
        </div>
      ) : session ? (
        <div className="row">
          <span className="muted" style={{ fontSize: 13 }}>{session.user.name}</span>
          <button className="btn btn-ghost btn-sm" onClick={async () => { await authClient.signOut(); router.push("/"); router.refresh(); }}>
            Sign out
          </button>
        </div>
      ) : (
        <div className="row">
          <Link className="btn btn-ghost btn-sm" href={`/login?next=${encodeURIComponent(path)}`}>Sign in</Link>
        </div>
      )}
    </header>
  );
}
