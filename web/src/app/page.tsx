import type { Metadata } from "next";
import Link from "next/link";
import { priceFor } from "@/lib/billing";
import registry from "@/shared/maps.json";
import { formatPrice, PLAN_COPY } from "@/shared/plans";
import "./marketing.css";

export const metadata: Metadata = {
  title: { absolute: "Matchframe2D — CS2 demo replays on a 2D radar" },
  description:
    "Upload a CS2 demo and review every round from above: player positions, utility, economy, kills and the bomb, with notes, bookmarks, playlists, voice comms and shareable round links.",
  robots: { index: true, follow: true },
};

const MAPS = Object.entries(registry.maps as Record<string, { displayName: string }>).map(([id, m]) => ({ id, name: m.displayName }));

const FEATURES: { title: string; body: string; icon: React.ReactNode }[] = [
  {
    title: "Every player, every tick",
    body: "Positions, view direction, health, armour and the weapon in hand, drawn on the official radar and synced to the round clock.",
    icon: <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 5v4l3 2" />,
  },
  {
    title: "Utility you can read",
    body: "Smokes, molotovs, flashes and HEs with throw paths, landing spots and how long each one lasts, including where an HE cleared a smoke.",
    icon: <path d="M7 15a5 5 0 1 1 9.6-2A4 4 0 1 1 17 21H8a4 4 0 0 1-1-6Z" />,
  },
  {
    title: "Both floors at once",
    body: "Nuke, Vertigo and Train show upper and lower levels side by side, so you never flick between floors to follow a rotate.",
    icon: <path d="M3 6h8v12H3zM13 6h8v12h-8z" />,
  },
  {
    title: "Economy and ammo",
    body: "Scoreboards with money, armour, utility, kits and magazine ammo for every player, plus buy type for every round: pistol, eco, half buy, full buy.",
    icon: <path d="M12 3v18M17 7H9.5a3 3 0 0 0 0 6h5a3 3 0 0 1 0 6H6" />,
  },
  {
    title: "Find the round you need",
    body: "Filter by pistol, buy type, side, winner, overtime or bomb plant. Round numbers always match the real match.",
    icon: <path d="M4 5h16l-6 8v6l-4-2v-4L4 5Z" />,
  },
  {
    title: "A timeline that tells the story",
    body: "Kills, plant, defuse and explosion on the scrubber. Jump event to event, skip freeze time, change speed from 0.25× to 8×.",
    icon: <path d="M3 12h18M7 8v8M12 6v12M17 9v6" />,
  },
  {
    title: "Notes, bookmarks, playlists",
    body: "Pin a comment to the exact tick, bookmark key moments, and string them into playlists that play across demos.",
    icon: <path d="M6 3h12v18l-6-4-6 4V3Z" />,
  },
  {
    title: "Voice comms in sync",
    body: "Upload your team's comms recording and it plays in time with the replay, at any speed, wherever you scrub.",
    icon: <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Zm-7 9a7 7 0 0 0 14 0M12 19v3" />,
  },
  {
    title: "Draw on the map",
    body: "Sketch rotations and crossfires straight onto the radar in four colours. Drawings stay pinned to the map as you zoom.",
    icon: <path d="m4 20 4-1L19 8l-3-3L5 16l-1 4ZM14 7l3 3" />,
  },
  {
    title: "Teams and roles",
    body: "Put replays in a team library. Owners and coaches manage, analysts review, viewers watch.",
    icon: <path d="M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2 20a6 6 0 0 1 12 0M14 14.5A6 6 0 0 1 22 20" />,
  },
  {
    title: "Whole series in one upload",
    body: "Drop a BO3 archive (.zip, .rar, .gz or .bz2) and every map becomes its own replay, linked as a series.",
    icon: <path d="M4 7h16v13H4zM9 4h6v3M4 12h16" />,
  },
  {
    title: "Keyboard first",
    body: "Space to play, arrows to seek, J/L for events, [ and ] for rounds, B and N for bookmarks and notes.",
    icon: <path d="M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M8 14h8" />,
  },
];

const FAQ: [string, React.ReactNode][] = [
  ["Which demos work?", "CS2 GOTV and match demos (.dem), including partial recordings that start mid-match and files cut off at the end. Archives in .zip, .rar, .gz and .bz2 are unpacked for you."],
  ["How big can an upload be?", "Up to 1 GB per file by default. A series archive can hold up to seven maps."],
  ["How long does processing take?", "Typically a minute or two for a full match. You can close the page; the replay appears in your library when it is ready."],
  ["Who can see my replays?", "Only you, until you share. You can add a replay to a team, give one person access, or create a read-only link. Links can be revoked at any time and stop working immediately."],
  ["Can I share a single round?", "Yes. Press “Round link” under the map and send it on. The link opens that one round, and anyone can watch it without an account."],
  ["What's the difference between Personal and Team?", "Personal covers one account: your own library and uploads, plus any team you're in. Team covers every member of one team for that team's library, so the whole roster can upload and review. The team owner pays and manages the plan."],
  ["Do people I share with need a plan?", "No. Anyone can watch a read-only or round link without an account. Teammates on a team plan only need a free account."],
  ["Does it show the game in 3D?", "No. Matchframe2D is a 2D radar replayer built for reviewing positions, utility and timing quickly."],
  ["Which maps are supported?", `${MAPS.map((m) => m.name).join(", ")}. Each map uses the official radar and its published coordinates.`],
];

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

/** Prices come from Stripe; refresh the page every ten minutes. */
export const revalidate = 600;

export default async function Landing() {
  const [personalPrice, teamPrice] = await Promise.all([priceFor("personal"), priceFor("team")]).catch(() => [null, null]);
  const prices = { personal: formatPrice(personalPrice), team: formatPrice(teamPrice) };
  return (
    <div className="mk">
      {/* ---------- hero ---------- */}
      <section className="mk-hero">
        <div className="mk-hero-glow" aria-hidden="true" />
        <div className="mk-wrap mk-hero-inner">
          <p className="mk-eyebrow">CS2 demo review</p>
          <h1>
            Every round,<br />
            <span className="mk-grad">seen from above.</span>
          </h1>
          <p className="mk-lede">
            Upload a CS2 demo and watch it back on a 2D radar: every player, every grenade, every buy. Scrub, filter, take notes, and share a single round with one link.
          </p>
          <div className="mk-cta-row">
            <Link className="mk-btn mk-btn-primary" href="/signup">Create an account</Link>
            <Link className="mk-btn" href="/login">Sign in</Link>
          </div>
          <ul className="mk-hero-facts" aria-label="At a glance">
            <li><strong>{MAPS.length}</strong> maps on official radars</li>
            <li><strong>.dem</strong> plus .zip, .rar, .gz, .bz2</li>
            <li><strong>1 link</strong> per round to share</li>
          </ul>
        </div>
        <div className="mk-wrap">
          <figure className="mk-frame mk-frame-hero">
            <div className="mk-frame-bar" aria-hidden="true"><span /><span /><span /><em>2d.matchframe.tv</em></div>
            <img src="/marketing/hero.webp" width={1800} height={1065}
              alt="The Matchframe2D replayer showing a Dust II round: players on the radar, smokes, both team scoreboards with health, money and ammo, the round bar and the timeline with kill markers." />
          </figure>
        </div>
      </section>

      {/* ---------- features ---------- */}
      <section className="mk-section" id="features" aria-labelledby="features-title">
        <div className="mk-wrap">
          <p className="mk-eyebrow">Features</p>
          <h2 id="features-title">Everything in the demo, laid out for review</h2>
          <p className="mk-sub">Built for coaches, analysts and players who need to see what happened, fast, and show it to the team.</p>
          <div className="mk-grid">
            {FEATURES.map((f) => (
              <article key={f.title} className="mk-card">
                <span className="mk-card-icon"><Icon>{f.icon}</Icon></span>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- showcase rows ---------- */}
      <section className="mk-section mk-alt" aria-label="Product tour">
        <div className="mk-wrap mk-rows">
          <div className="mk-row">
            <div className="mk-row-text">
              <p className="mk-eyebrow">Multi-level maps</p>
              <h2>Upper and lower, side by side</h2>
              <p>On Nuke, Vertigo and Train each floor gets its own panel with the same zoom and pan. Follow a player down ramp without switching views. Prefer one view? Overlay the floors or pick one.</p>
            </div>
            <figure className="mk-frame">
              <img src="/marketing/floors.webp" width={1600} height={947}
                alt="Nuke shown with the upper and lower floors side by side, players on both levels." />
            </figure>
          </div>

          <div className="mk-row mk-row-flip">
            <div className="mk-row-text">
              <p className="mk-eyebrow">Scoreboards</p>
              <h2>The whole economy at a glance</h2>
              <p>Each team box shows health bars, armour, money, magazine ammo, the gun in hand and every grenade, defuse kit and the bomb. Dead players are greyed out. Click anyone to highlight them on the map, follow them, or copy their setpos.</p>
            </div>
            <figure className="mk-frame mk-frame-narrow">
              <img src="/marketing/scoreboard.webp" width={600} height={851}
                alt="Two team scoreboards with player names, health bars, ammo counts, weapons, money and utility icons." />
            </figure>
          </div>

          <div className="mk-row">
            <div className="mk-row-text">
              <p className="mk-eyebrow">Review</p>
              <h2>Notes on the exact tick</h2>
              <p>Open Review for the round&apos;s kill and bomb log, your notes and bookmarks, playlists and comms. Every item is anchored to a round and a tick, so clicking it puts you right back at the moment.</p>
            </div>
            <figure className="mk-frame">
              <img src="/marketing/review.webp" width={1600} height={947}
                alt="The replayer with the Review panel open, listing kills, assists, a bomb plant and the round result with times." />
            </figure>
          </div>

          <div className="mk-row mk-row-flip">
            <div className="mk-row-text">
              <p className="mk-eyebrow">Rounds and sharing</p>
              <h2>One link per round</h2>
              <p>Filter the round bar by buy, side, winner or plant, then press <strong>Round link</strong>. The link opens that round for anyone: no account, nothing else in the demo. Revoke it whenever you like.</p>
            </div>
            <figure className="mk-frame">
              <img src="/marketing/filters.webp" width={1400} height={319}
                alt="The round bar with round numbers underlined in the winning side's colour, the filter options and the Round link button." />
            </figure>
          </div>
        </div>
      </section>

      {/* ---------- how it works ---------- */}
      <section className="mk-section" id="how" aria-labelledby="how-title">
        <div className="mk-wrap">
          <p className="mk-eyebrow">How it works</p>
          <h2 id="how-title">From demo file to review in three steps</h2>
          <ol className="mk-steps">
            <li>
              <span className="mk-step-n">1</span>
              <h3>Upload</h3>
              <p>Drag in a .dem or an archive straight from your match page. Large files upload directly to private storage.</p>
            </li>
            <li>
              <span className="mk-step-n">2</span>
              <h3>We parse it</h3>
              <p>Rounds, kills, utility, the bomb and every player&apos;s state are extracted and checked against the in-game scoreboard.</p>
            </li>
            <li>
              <span className="mk-step-n">3</span>
              <h3>Review and share</h3>
              <p>Open the replay, skip freeze time automatically, mark the moments that matter and send a round link to the team.</p>
            </li>
          </ol>
        </div>
      </section>

      {/* ---------- audiences ---------- */}
      <section className="mk-section mk-alt" aria-labelledby="who-title">
        <div className="mk-wrap">
          <p className="mk-eyebrow">Who it&apos;s for</p>
          <h2 id="who-title">One replayer, every seat on the team</h2>
          <div className="mk-grid mk-grid-3">
            <article className="mk-card mk-card-tall">
              <h3>Coaches</h3>
              <p>Build playlists of executes and retakes, leave notes on the tick, and run review sessions with comms playing in sync.</p>
            </article>
            <article className="mk-card mk-card-tall">
              <h3>Analysts</h3>
              <p>Filter an opponent&apos;s rounds by buy and side, step through every kill, and track utility usage across a whole series.</p>
            </article>
            <article className="mk-card mk-card-tall">
              <h3>Players</h3>
              <p>See your own positioning and timings from above, and share the one round you want feedback on with a single link.</p>
            </article>
          </div>
        </div>
      </section>

      {/* ---------- maps ---------- */}
      <section className="mk-section" id="maps" aria-labelledby="maps-title">
        <div className="mk-wrap">
          <p className="mk-eyebrow">Maps</p>
          <h2 id="maps-title">The competitive pool and the classics</h2>
          <ul className="mk-maps">
            {MAPS.map((m) => (
              <li key={m.id}>
                <img src={`/cs2/map_icons/${m.id}.svg`} alt="" width={36} height={36} />
                <span>{m.name}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ---------- privacy ---------- */}
      <section className="mk-section mk-alt" aria-labelledby="privacy-title">
        <div className="mk-wrap mk-split">
          <div>
            <p className="mk-eyebrow">Privacy</p>
            <h2 id="privacy-title">Private by default</h2>
            <p className="mk-sub">Your demos are your prep. Nothing is public unless you make it so.</p>
          </div>
          <ul className="mk-checks">
            <li>Replays are visible only to you until you share them.</li>
            <li>Demo files sit in private storage and are never served by a public URL.</li>
            <li>Read-only and round links can be revoked in one click and stop working at once.</li>
            <li>The secret part of a share link stays in the browser and is never written to server logs.</li>
            <li>Comms recordings stay private unless you choose to include them in links.</li>
          </ul>
        </div>
      </section>

      {/* ---------- plans ---------- */}
      <section className="mk-section" id="plans" aria-labelledby="plans-title">
        <div className="mk-wrap">
          <p className="mk-eyebrow">Plans</p>
          <h2 id="plans-title">For you, or for the whole team</h2>
          <p className="mk-sub">A personal plan is for one person. A team plan covers everyone on the roster, and members only need a free account.</p>
          <div className="mk-plans">
            {(["personal", "team"] as const).map((k) => (
              <article key={k} className={`mk-plan${k === "team" ? " mk-plan-team" : ""}`}>
                <header>
                  <h3>{PLAN_COPY[k].name}</h3>
                  <p>{PLAN_COPY[k].tagline}</p>
                  {prices[k] ? <p className="mk-plan-price">{prices[k]}</p> : null}
                </header>
                <ul>{PLAN_COPY[k].points.map((p) => <li key={p}>{p}</li>)}</ul>
                <Link className={`mk-btn${k === "team" ? " mk-btn-primary" : ""}`} href={`/signup?next=${encodeURIComponent("/billing")}`}>
                  {k === "team" ? "Get a team plan" : "Get Personal"}
                </Link>
              </article>
            ))}
          </div>
          <p className="mk-plan-note">Anyone can watch a read-only or round link you share, with no account and no plan.</p>
        </div>
      </section>

      {/* ---------- FAQ ---------- */}
      <section className="mk-section" id="faq" aria-labelledby="faq-title">
        <div className="mk-wrap mk-faq-wrap">
          <p className="mk-eyebrow">FAQ</p>
          <h2 id="faq-title">Questions</h2>
          <div className="mk-faq">
            {FAQ.map(([q, a]) => (
              <details key={q}>
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- final CTA ---------- */}
      <section className="mk-final">
        <div className="mk-wrap">
          <h2>Bring your next demo.</h2>
          <p>Create an account, upload a match, and send your team the round that decided it.</p>
          <div className="mk-cta-row mk-center">
            <Link className="mk-btn mk-btn-primary" href="/signup">Create an account</Link>
            <Link className="mk-btn" href="/login">Sign in</Link>
          </div>
        </div>
      </section>

      <footer className="mk-footer">
        <div className="mk-wrap mk-footer-inner">
          <div>
            <strong>Matchframe2D</strong>
            <p>CS2 demo replays on a 2D radar.</p>
          </div>
          <nav aria-label="Footer">
            <a href="#features">Features</a>
            <a href="#how">How it works</a>
            <a href="#maps">Maps</a>
            <a href="#plans">Plans</a>
            <a href="#faq">FAQ</a>
            <Link href="/login">Sign in</Link>
          </nav>
          <p className="mk-legal">
            Matchframe2D is not affiliated with or endorsed by Valve Corporation. Counter-Strike, its maps, radar images and weapon art are the property of Valve Corporation.
          </p>
        </div>
      </footer>
    </div>
  );
}
