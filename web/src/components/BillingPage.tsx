"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { formatPrice, PLAN_COPY, type PriceView } from "@/shared/plans";
import { api } from "./api";

interface Plan { active: boolean; status: string; provider: "stripe" | "manual"; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean }
interface BillingState {
  enabled: boolean;
  configured: boolean;
  teamMemberLimit: number | null;
  prices: { personal: PriceView | null; team: PriceView | null };
  yearly: { personal: PriceView | null; team: PriceView | null };
  perSeat: boolean;
  minSeats: number;
  personal: Plan | null;
  teams: { id: string; name: string; role: string; canManageBilling: boolean; members: number; plan: Plan | null }[];
  access: { personal: boolean; coveredTeams: string[]; canUse: boolean };
}

const STATUS: Record<string, string> = {
  active: "Active", trialing: "Trial", past_due: "Payment due", canceled: "Cancelled", unpaid: "Unpaid",
  incomplete: "Incomplete", incomplete_expired: "Expired", paused: "Paused",
};

function PlanStatus({ plan }: { plan: Plan | null }) {
  if (!plan) return <span className="badge">No plan</span>;
  const end = plan.currentPeriodEnd ? new Date(plan.currentPeriodEnd).toLocaleDateString() : null;
  return (
    <span className="row wrap" style={{ gap: 6 }}>
      <span className={`badge ${plan.active ? "badge-ok" : "badge-warn"}`}>{STATUS[plan.status] ?? plan.status}</span>
      {plan.provider === "manual" ? <span className="badge">Granted</span> : null}
      {end ? <span className="faint" style={{ fontSize: 12 }}>{plan.active ? (plan.cancelAtPeriodEnd ? `Ends ${end}` : `Renews ${end}`) : `Ended ${end}`}</span> : null}
    </span>
  );
}

export function BillingPage() {
  const params = useSearchParams();
  const [s, setS] = useState<BillingState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [interval, setInterval_] = useState<"month" | "year">("month");
  const [error, setError] = useState<string | null>(null);
  const checkout = params.get("checkout");

  const load = useCallback(async () => {
    try {
      setS(await api<BillingState>("/api/billing"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your plans.");
    }
  }, []);
  useEffect(() => void load(), [load]);
  // Stripe confirms by webhook a moment after checkout; refresh a few times.
  useEffect(() => {
    if (checkout !== "success") return;
    let n = 0;
    const t = setInterval(() => { n++; void load(); if (n >= 6) clearInterval(t); }, 2500);
    return () => clearInterval(t);
  }, [checkout, load]);

  async function go(path: string, json: unknown, key: string) {
    setBusy(key);
    setError(null);
    try {
      const r = await api<{ url: string }>(path, { method: "POST", json });
      window.location.assign(r.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setBusy(null);
    }
  }

  const hasYearly = !!(s?.yearly.personal || s?.yearly.team);
  const view = (k: "personal" | "team") => (interval === "year" ? s?.yearly[k] : s?.prices[k]) ?? null;
  const price = (k: "personal" | "team") => {
    const f = formatPrice(view(k));
    return f && k === "team" && s?.perSeat ? f.replace(" / ", " per member / ") : f;
  };
  /** Yearly saving against twelve monthly payments. */
  const saving = (k: "personal" | "team") => {
    const m = s?.prices[k];
    const y = s?.yearly[k];
    if (!m || !y || m.interval !== "month" || y.interval !== "year" || m.currency !== y.currency) return null;
    const pct = Math.round(100 * (1 - y.amount / (m.amount * 12)));
    return pct > 0 ? pct : null;
  };
  const canPay = !!s?.enabled && !!s.configured;
  const ownedTeams = s?.teams.filter((t) => t.canManageBilling) ?? [];

  return (
    <div className="page" style={{ maxWidth: 1000 }}>
      <h1>Plans &amp; billing</h1>
      <p className="page-sub">A personal plan covers you. A team plan covers everyone on one team.</p>

      {checkout === "success" ? <p className="alert" role="status">Thanks! Your plan is being activated. This page updates in a few seconds.</p> : null}
      {checkout === "cancelled" ? <p className="alert" role="status">Checkout was cancelled. Nothing was charged.</p> : null}
      {error ? <p className="alert alert-err" role="alert">{error}</p> : null}
      {s && !s.enabled ? (
        <p className="alert" role="status">Plans are not enforced on this server yet: everyone can use every feature.</p>
      ) : null}
      {s && s.enabled && !s.configured ? (
        <p className="alert alert-warn" role="status">Online payments are not set up yet. Ask the site operator to grant you a plan.</p>
      ) : null}

      {hasYearly ? (
        <div className="ins-group" role="group" aria-label="Billing period" style={{ marginBottom: 12 }}>
          <button type="button" className="chip" aria-pressed={interval === "month"} onClick={() => setInterval_("month")}>Monthly</button>
          <button type="button" className="chip" aria-pressed={interval === "year"} onClick={() => setInterval_("year")}>
            Yearly{saving("personal") || saving("team") ? ` · save up to ${Math.max(saving("personal") ?? 0, saving("team") ?? 0)}%` : ""}
          </button>
        </div>
      ) : null}

      <div className="plan-grid">
        <section className="card plan-card" aria-labelledby="plan-personal">
          <header className="plan-head">
            <div>
              <h2 id="plan-personal">{PLAN_COPY.personal.name}</h2>
              <p className="faint">{PLAN_COPY.personal.tagline}</p>
            </div>
            {price("personal") ? <span className="plan-price">{price("personal")}</span> : null}
          </header>
          <ul className="plan-points">{PLAN_COPY.personal.points.map((p) => <li key={p}>{p}</li>)}</ul>
          <div className="plan-foot">
            <PlanStatus plan={s?.personal ?? null} />
            <span className="grow" />
            {s?.personal?.active && s.personal.provider === "stripe" ? (
              <button className="btn" disabled={!canPay || busy !== null} onClick={() => go("/api/billing/portal", { kind: "personal" }, "portal-personal")}>
                {busy === "portal-personal" ? "Opening…" : "Manage billing"}
              </button>
            ) : !s?.personal?.active ? (
              <button className="btn btn-primary" disabled={!canPay || busy !== null} onClick={() => go("/api/billing/checkout", { kind: "personal", interval }, "buy-personal")}>
                {busy === "buy-personal" ? "Opening checkout…" : "Get Personal"}
              </button>
            ) : null}
          </div>
        </section>

        <section className="card plan-card" aria-labelledby="plan-team">
          <header className="plan-head">
            <div>
              <h2 id="plan-team">{PLAN_COPY.team.name}</h2>
              <p className="faint">{PLAN_COPY.team.tagline}</p>
            </div>
            {price("team") ? <span className="plan-price">{price("team")}</span> : null}
          </header>
          <ul className="plan-points">
            {PLAN_COPY.team.points.map((p) => <li key={p}>{p}</li>)}
            {s?.teamMemberLimit ? <li>Up to {s.teamMemberLimit} members</li> : null}
            {s?.perSeat ? <li>Billed per member; adding or removing members adjusts the next invoice</li> : null}
          </ul>
          <div className="plan-teams">
            {s && s.teams.length === 0 ? (
              <p className="faint" style={{ margin: 0 }}>You are not in a team yet. <Link href="/teams">Create a team</Link>, then subscribe it here.</p>
            ) : null}
            {s?.teams.map((t) => (
              <div key={t.id} className="plan-team-row">
                <strong className="grow">
                  {t.name}
                  {s?.perSeat ? (
                    <span className="faint" style={{ fontWeight: 400, fontSize: 12 }}>
                      {" "}· {t.members} member{t.members === 1 ? "" : "s"}
                      {view("team") ? ` · ${formatPrice({ ...view("team")!, amount: view("team")!.amount * Math.max(s.minSeats, t.members) })}` : ""}
                    </span>
                  ) : null}
                </strong>
                <PlanStatus plan={t.plan} />
                {t.canManageBilling ? (
                  t.plan?.active ? (
                    t.plan.provider === "stripe" ? (
                      <button className="btn btn-sm" disabled={!canPay || busy !== null} onClick={() => go("/api/billing/portal", { kind: "team", teamId: t.id }, `portal-${t.id}`)}>
                        {busy === `portal-${t.id}` ? "Opening…" : "Manage billing"}
                      </button>
                    ) : null
                  ) : (
                    <button className="btn btn-sm btn-primary" disabled={!canPay || busy !== null} onClick={() => go("/api/billing/checkout", { kind: "team", teamId: t.id, interval }, `buy-${t.id}`)}>
                      {busy === `buy-${t.id}` ? "Opening checkout…" : "Get Team plan"}
                    </button>
                  )
                ) : <span className="faint" style={{ fontSize: 12 }}>{t.plan?.active ? "Covered" : "Ask the team owner"}</span>}
              </div>
            ))}
            {s && s.teams.length > 0 && ownedTeams.length === 0 ? <p className="faint" style={{ fontSize: 12, margin: "6px 0 0" }}>Only a team owner can buy or manage a team plan.</p> : null}
          </div>
        </section>
      </div>

      {s ? (
        <section className="card" style={{ marginTop: 16 }} aria-labelledby="coverage-title">
          <h2 id="coverage-title" style={{ fontSize: 16, margin: "0 0 6px" }}>What you can use now</h2>
          <p className="muted" style={{ margin: 0 }}>
            {s.access.personal
              ? "Everything: your library, uploads, and every team you're in."
              : s.access.coveredTeams.length
                ? `Team libraries of ${s.teams.filter((t) => s.access.coveredTeams.includes(t.id)).map((t) => t.name).join(", ")}. Upload to the team; a personal plan adds your own library.`
                : "Watching links people send you. Get a plan to upload and review demos."}
          </p>
        </section>
      ) : null}
    </div>
  );
}

/** Small notice for app pages when the signed-in user has no plan covering anything. */
export function PlanNotice() {
  const [s, setS] = useState<Pick<BillingState, "enabled" | "access"> | null>(null);
  useEffect(() => { api<BillingState>("/api/billing").then(setS).catch(() => {}); }, []);
  if (!s?.enabled || s.access.canUse) return null;
  return (
    <p className="alert alert-warn" role="status">
      You don&apos;t have a plan yet, so replays and uploads are locked. <Link href="/billing">See plans</Link>
    </p>
  );
}
