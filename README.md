# Tycoon Loans

A loan service for the Transport Tycoon FiveM server. Players apply from inside the game, you
approve or reject from a web dashboard, and every loan is tracked through to repayment.

- **Players** open the app in game with <kbd>F1</kbd> and enter your URL. It reads their name,
  user ID, wallet, bank, job and faction straight from the game client, so there is nothing to log in to.
- **You** open `/admin`, review each application with the applicant's finances and track record
  in front of you, and approve, counter-offer or reject.
- **Defaults:** 100,000,000 maximum per person per loan, 3% interest. Both are editable in the panel.

Built as a single Cloudflare Worker with a D1 database and static assets — all on Cloudflare's free tier.

---

## How the money actually moves

**It doesn't — not through this app.** The Transport Tycoon API is read-only: there is no endpoint
that transfers money between players. So the flow is:

1. Player applies in game.
2. You approve. The loan is created with status `awaiting payout`.
3. **You hand the money over in game**, then click *Mark paid out*. That is when the repayment
   clock starts and the due date is set.
4. Player pays you back in game. You record each repayment. When the total is reached the loan
   closes itself as `repaid`.

The app is the ledger and the agreement. You are still the bank.

---

## Setup

### 1. Create the database

```bash
npm install
npx wrangler login
npm run db:create
```

Copy the `database_id` it prints into `wrangler.jsonc`, replacing `REPLACE_WITH_YOUR_D1_DATABASE_ID`.

Then create the tables:

```bash
npm run db:init
```

### 2. Deploy

```bash
npm run deploy
```

Wrangler prints your URL, something like `https://tt-loans.<your-subdomain>.workers.dev`.

### 3. Set your secrets

Your private API key is already in `.dev.vars` for local development. Production reads it from an
encrypted secret instead, so set it once here:

```bash
npx wrangler secret put TYCOON_API_KEY   # your private key from /api private new
npx wrangler secret put ADMIN_PASSWORD   # your admin panel password
npx wrangler secret put SESSION_SECRET   # any long random string
```

Generate a session secret with:

```bash
node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"
```

Secrets are encrypted at rest and never appear in the code or in `wrangler.jsonc`. If the key ever
does need replacing, `/api private new` in game and re-run the first command — nothing else changes.

### 4. Check the connection

Open `https://your-worker-url/api/health` first. It reports whether D1 is bound, whether the tables
exist and whether each secret is set, and names the command to fix anything that is missing. It never
echoes a secret value — only `set` or `MISSING`.

If it says `ok: true`, open `/admin`, sign in, and go to **Settings → Test connection**. You want at
least one of the two API routes to report `ok`. See *Reaching the game API* below if both fail.

> **Deploying from the Cloudflare dashboard?** Uploading the project there creates the D1 database
> for you, but it does **not** run `schema.sql`. You still have to run `npm run db:init` once, or
> every request fails. `/api/health` will tell you if this is what happened.

### 5. Give players the URL

Tell them to press <kbd>F1</kbd> in game and enter your worker URL. That is the whole install.

---

## Local development

```bash
cp .dev.vars.example .dev.vars    # then fill it in
npm run db:init:local
npm run dev
```

Visit `http://localhost:8787`. Outside the game there is no data feed, so the player app shows a
manual sign-in box — it only appears on `localhost`, never in production.

---

## Reaching the game API

The Tycoon API is used for two things: confirming a player is online when they sign in (free), and
looking up a live wallet/bank balance when you click the button on an application (1 charge).

Getting to it from a Worker is awkward, so the client tries two routes:

| Route | Transport | Notes |
| --- | --- | --- |
| `https://tycoon-2epova.users.cfx.re/status/…` | normal `fetch()` | The cfx.re proxy. Fast when up; `servers.json` warns it "may not always be available", and it was down when this was built. |
| `server.tycoon.community:30120` | raw TCP socket | A deployed Worker silently drops non-standard ports on `fetch()`, so this speaks HTTP/1.1 over `cloudflare:sockets` instead. This is the route that currently works. |

Only one needs to work. If neither does, players can still apply — their applications are just
flagged *identity unconfirmed* for you to eyeball. Set `ALLOW_UNVERIFIED_APPLICATIONS` to `"0"` in
`wrangler.jsonc` to block sign-in instead.

**Charges.** Your private key spends one charge per call. This app is deliberately frugal: sign-in
uses the free `/players.json`, the balance check is manual and cached for 2 minutes, and the charge
counter on the dashboard is free to read. Normal use costs almost nothing. Refill in game with
`/api private refill`.

Switch servers by changing `TYCOON_SERVER` in `wrangler.jsonc` to `main`, `beta` or `lite`.

---

## How players are identified — read this

The game hands the web app the player's `user_id`, `name` and `pkey`. The app sends those to the
Worker, which checks the user ID against the server's live player list before issuing a session.

**That check proves someone is online with that ID. It does not prove the applicant is that person.**
The game platform provides no signed token, so a determined player could craft a request claiming
another online player's ID. Applications from an unconfirmed session are badged
*identity unconfirmed* in the queue.

In practice this is contained by the thing you asked for: **you approve every loan by hand**, with
the name, user ID and in-game finances in front of you, and no money moves until you personally hand
it over in game. Treat the badge as a prompt to check the name against who you are actually talking to.

---

## Approving from inside the game

There is a **Staff** tab in the in-game app that lets you clear the queue without alt-tabbing:
approve (at the asked amount or a counter-offer), deny, mark a loan paid out, and record repayments.

Turn it on with two secrets:

```bash
npx wrangler secret put ADMIN_USER_ID   # your in-game user ID
npx wrangler secret put ADMIN_PIN       # a PIN only you know
```

**Leave either unset and the tab does not exist for anybody, including you.** That is the default.

### Why a PIN and not just your user ID

The game tells the web app what your `user_id` is, but nothing signs it — the app cannot prove the
claim, and every user ID on the server is public in `/players.json`. Gating on the ID alone would
mean anyone who looked yours up could approve their own loans.

So unlocking the staff tab requires **all four** of:

1. a valid player session,
2. that session's user ID matching `ADMIN_USER_ID`,
3. that ID being confirmed online against the live player list,
4. the correct `ADMIN_PIN`.

A wrong ID and a wrong PIN return the same message, so probing tells an attacker nothing about which
half they got wrong. Failures are rate limited to 8 per IP per 15 minutes and every attempt — success
or failure — is written to the audit log. The tab is only sent to your client at all: `/api/me`
decides server-side, so nobody else's app ever learns your user ID.

Because of check 3, the staff tab needs you to be online *and* the Tycoon API to be reachable. If the
API is down, use the web panel at `/admin` — it has no such dependency.

Buttons that move money need two taps to fire (the second confirms), because native `confirm()`
dialogs are unreliable inside the game client and a stray click should not approve 100M.

---

## Locking down the admin panel

`/admin` is protected by `ADMIN_PASSWORD`, with a lockout after 8 failed attempts from an IP in 15
minutes. That is fine for a single operator.

For something stronger, put **Cloudflare Access** in front of `/admin*` (free for up to 50 users) and
sign in with Discord or Google instead. Zero Trust → Access → Applications → Self-hosted, path
`/admin*`. The password login stays as a fallback behind it.

---

## Settings you can change without redeploying

Everything below lives in the database and is editable on the **Settings** tab:

| Setting | Default | What it does |
| --- | --- | --- |
| `max_loan_amount` | `100000000` | Hard cap per loan, enforced on both the player form and the approve endpoint |
| `min_loan_amount` | `100000` | Smallest loan you will write |
| `interest_rate` | `0.03` | 3% |
| `interest_model` | `flat` | `flat` charges 3% once; `weekly` charges 3% per started 7 days of term |
| `allowed_terms` | `7,14,30` | Repayment terms offered, in days |
| `max_active_loans` | `1` | Open loans per player — keeping this at 1 is what makes the per-person cap meaningful |
| `max_pending_apps` | `1` | Applications a player can have in the queue |
| `applications_open` | `1` | Set to `0` to close the queue |
| `closed_message` | … | Shown in game when the queue is closed |
| `payout_instructions` | … | Shown on the *How it works* tab |
| `repay_instructions` | … | Shown on the *How it works* tab |

Interest is simple, not compound: a 100,000,000 loan at 3% flat repays 103,000,000 regardless of term.
Switch to `weekly` if you want longer terms to cost more.

---

## Project layout

```
src/
  index.js            router; everything under /api/* lands here
  lib/
    tycoon.js         game API client, dual transport, response cache
    auth.js           HMAC-signed sessions for players and for you
    loans.js          settings, interest maths, eligibility rules
    http.js           JSON responses, validation, errors
  routes/
    player.js         /api/session, /api/me, /api/applications
    admin.js          /api/admin/*
public/
  index.html app.js   the in-game User Application
  admin.html admin.js the approval dashboard
  style.css           shared styling
schema.sql            D1 tables and default settings
```

`applications` records what was asked for. `loans` records what you agreed to and is created on
approval. `repayments` is append-only. `audit_log` records every decision with a timestamp, so you
can always show a player what happened to their application.

---

## Costs

Free tier covers this comfortably: Workers gives 100,000 requests/day, D1 gives 5 GB of storage and
5 million row reads/day, and static assets are unmetered. A loan service for one server will not get
close to any of those.

---

## Reference

- [User Applications](https://dash.tycoon.community/wiki/index.php/User_Applications) — how F1 apps work
- [Tycoon API](https://dash.tycoon.community/wiki/index.php/API) — endpoints, keys, charges
- [servers.json](https://cdn.tycoon.community/servers.json) — server IDs and proxy template
- [Sample user app](https://cdn.tycoon.community/dev/userapp/sample.html) — the postMessage bridge
