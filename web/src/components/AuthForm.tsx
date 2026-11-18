"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { authClient } from "./auth-client";

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next");
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/replays";
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    const email = String(f.get("email"));
    const password = String(f.get("password"));
    const res = mode === "login"
      ? await authClient.signIn.email({ email, password })
      : await authClient.signUp.email({ email, password, name: String(f.get("name")) });
    setBusy(false);
    if (res.error) {
      setError(res.error.message ?? "Sign-in failed.");
      return;
    }
    router.push(safeNext);
    router.refresh();
  }

  return (
    <div className="auth card">
      <h1>{mode === "login" ? "Sign in" : "Create your account"}</h1>
      <form onSubmit={submit}>
        {mode === "signup" ? (
          <div className="field">
            <label htmlFor="name">Display name</label>
            <input className="input" id="name" name="name" required maxLength={60} autoComplete="nickname" />
          </div>
        ) : null}
        <div className="field">
          <label htmlFor="email">Email</label>
          <input className="input" id="email" name="email" type="email" required autoComplete="email" />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input className="input" id="password" name="password" type="password" required minLength={10}
            autoComplete={mode === "login" ? "current-password" : "new-password"} />
        </div>
        {error ? <p className="alert alert-err" role="alert">{error}</p> : null}
        <button className="btn btn-primary" style={{ width: "100%" }} disabled={busy}>
          {busy ? "Working…" : mode === "login" ? "Sign in" : "Create account"}
        </button>
      </form>
      <p className="muted" style={{ marginTop: 14, fontSize: 13 }}>
        {mode === "login" ? <>No account? <Link href={`/signup${next ? `?next=${encodeURIComponent(next)}` : ""}`}>Create one</Link></> :
          <>Already registered? <Link href="/login">Sign in</Link></>}
      </p>
    </div>
  );
}
