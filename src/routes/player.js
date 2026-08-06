/** Routes used by the in-game User Application. */

import { bad, conflict, forbidden, intField, json, notFound, readJson, strField } from '../lib/http.js';
import { issuePlayerToken, requirePlayer } from '../lib/auth.js';
import { assertMayApply, audit, decorateLoan, getSettings, quote } from '../lib/loans.js';
import { getOnlinePlayers } from '../lib/tycoon.js';

/** Public, unauthenticated: what the app shows before a player signs in. */
export async function getPublicConfig(request, env) {
  const s = await getSettings(env);
  return json({
    brand: env.BRAND_NAME || 'Tycoon Loans',
    server: env.TYCOON_SERVER || 'main',
    applicationsOpen: s.applicationsOpen,
    closedMessage: s.closedMessage,
    minLoanAmount: s.minLoanAmount,
    maxLoanAmount: s.maxLoanAmount,
    interestRate: s.interestRate,
    interestModel: s.interestModel,
    allowedTerms: s.allowedTerms,
    payoutInstructions: s.payoutInstructions,
    repayInstructions: s.repayInstructions,
  });
}

/**
 * Exchanges the identity the game handed the web app for a session token.
 * Body: { user_id, name, pkey? }
 *
 * The only free identity signal available is /players.json, which lists who is
 * online right now. We require the user_id to be on it. That does not make
 * impersonation impossible - it makes it require the target to be online, and
 * every loan is approved by a human who can see the name and id anyway.
 */
export async function createSession(request, env) {
  const body = await readJson(request);
  const userId = intField(body, 'user_id', { min: 1 });
  const name = strField(body, 'name', { max: 120, required: true });
  const pkey = strField(body, 'pkey', { max: 200 });

  let verified = false;
  let verifyNote = '';
  let onlineName = null;

  try {
    const online = await getOnlinePlayers(env);
    const entry = online.get(userId);
    if (entry) {
      verified = true;
      onlineName = entry.name;
    } else if (online.size === 0) {
      verifyNote = 'Player list was empty when checked';
    } else {
      verifyNote = 'User ID was not online when checked';
    }
  } catch (err) {
    verifyNote = `Tycoon API unreachable: ${err.message}`;
  }

  if (!verified && env.ALLOW_UNVERIFIED_APPLICATIONS !== '1') {
    throw forbidden(
      'Could not confirm you are online on the server right now. Try again in a moment.'
    );
  }

  await env.DB.prepare(
    'INSERT INTO players (user_id, name, pkey, first_seen, last_seen) ' +
      'VALUES (?, ?, ?, unixepoch(), unixepoch()) ' +
      'ON CONFLICT(user_id) DO UPDATE SET name = excluded.name, ' +
      'pkey = COALESCE(excluded.pkey, players.pkey), last_seen = unixepoch()'
  )
    .bind(userId, name, pkey)
    .run();

  const token = await issuePlayerToken(env.SESSION_SECRET, {
    user_id: userId,
    name,
    verified,
    has_pkey: !!pkey,
  });

  return json({ token, user_id: userId, name, verified, verifyNote, onlineName });
}

/** Everything the player's dashboard needs, in one call. */
export async function getMe(request, env) {
  const session = await requirePlayer(request, env);
  const settings = await getSettings(env);

  const [apps, loans, player] = await Promise.all([
    env.DB.prepare(
      'SELECT id, amount, term_days, interest_rate, total_repayable, purpose, collateral, ' +
        'status, created_at, decided_at, decision_note FROM applications ' +
        'WHERE user_id = ? ORDER BY created_at DESC LIMIT 25'
    )
      .bind(session.user_id)
      .all(),
    env.DB.prepare(
      'SELECT id, application_id, principal, interest_rate, total_due, amount_repaid, term_days, ' +
        'status, approved_at, paid_out_at, due_at, closed_at FROM loans ' +
        'WHERE user_id = ? ORDER BY approved_at DESC LIMIT 25'
    )
      .bind(session.user_id)
      .all(),
    env.DB.prepare('SELECT blocked, blocked_reason FROM players WHERE user_id = ?')
      .bind(session.user_id)
      .first(),
  ]);

  const loanList = (loans.results ?? []).map(decorateLoan);
  const openLoans = loanList.filter((l) => l.status === 'awaiting_payout' || l.status === 'active');
  const pendingApps = (apps.results ?? []).filter((a) => a.status === 'pending');

  return json({
    user_id: session.user_id,
    name: session.name,
    verified: !!session.verified,
    blocked: !!player?.blocked,
    blockedReason: player?.blocked_reason ?? null,
    applications: apps.results ?? [],
    loans: loanList,
    canApply:
      settings.applicationsOpen &&
      !player?.blocked &&
      pendingApps.length < settings.maxPendingApps &&
      openLoans.length < settings.maxActiveLoans,
    totalOutstanding: openLoans.reduce((sum, l) => sum + l.outstanding, 0),
  });
}

/** Live quote as the player drags the amount slider. No writes, no API charges. */
export async function getQuote(request, env) {
  const url = new URL(request.url);
  const settings = await getSettings(env);
  const amount = Math.floor(Number(url.searchParams.get('amount')));
  const termDays = Math.floor(Number(url.searchParams.get('term')));
  if (!Number.isFinite(amount) || amount <= 0) throw bad('amount must be a positive number');
  if (!settings.allowedTerms.includes(termDays)) throw bad('Unsupported term');
  return json(quote(Math.min(amount, settings.maxLoanAmount), termDays, settings));
}

/** Body: { amount, term_days, purpose?, collateral?, snapshot? } */
export async function createApplication(request, env) {
  const session = await requirePlayer(request, env);
  const body = await readJson(request);
  const settings = await getSettings(env);

  const amount = intField(body, 'amount', { min: 1, max: settings.maxLoanAmount });
  const termDays = intField(body, 'term_days', { min: 1, max: 365 });
  const purpose = strField(body, 'purpose', { max: 500 });
  const collateral = strField(body, 'collateral', { max: 500 });

  await assertMayApply(env, settings, session.user_id, amount, termDays);

  const q = quote(amount, termDays, settings);
  const snapshot = buildSnapshot(body.snapshot, session);

  const result = await env.DB.prepare(
    'INSERT INTO applications (user_id, player_name, amount, term_days, interest_rate, ' +
      'total_repayable, purpose, collateral, status, identity_verified, snapshot, created_at) ' +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, unixepoch()) RETURNING id"
  )
    .bind(
      session.user_id,
      session.name,
      amount,
      termDays,
      q.effectiveRate,
      q.totalRepayable,
      purpose,
      collateral,
      session.verified ? 1 : 0,
      JSON.stringify(snapshot)
    )
    .first();

  await audit(
    env,
    `player:${session.user_id}`,
    'application.created',
    result.id,
    `${amount} over ${termDays}d`
  );

  return json({ id: result.id, ...q, status: 'pending' }, 201);
}

export async function cancelApplication(request, env, params) {
  const session = await requirePlayer(request, env);
  const id = Number(params.id);

  const app = await env.DB.prepare('SELECT id, user_id, status FROM applications WHERE id = ?')
    .bind(id)
    .first();
  if (!app) throw notFound('Application not found');
  if (app.user_id !== session.user_id) throw forbidden('That is not your application');
  if (app.status !== 'pending') throw conflict(`This application is already ${app.status}`);

  await env.DB.prepare("UPDATE applications SET status = 'cancelled', decided_at = unixepoch() WHERE id = ?")
    .bind(id)
    .run();
  await audit(env, `player:${session.user_id}`, 'application.cancelled', id, null);

  return json({ id, status: 'cancelled' });
}

/**
 * Keeps only the game data fields worth showing you at approval time, so we
 * never store a whole dump of the player's client state.
 */
const SNAPSHOT_FIELDS = [
  'wallet',
  'bank',
  'job',
  'job_title',
  'job_name',
  'subjob_name',
  'faction_name',
  'faction_id',
  'zoneName',
  'street',
  'discord',
  'weight',
  'max_weight',
];

function buildSnapshot(raw, session) {
  const out = { captured_at: Math.floor(Date.now() / 1000), name: session.name };
  if (raw && typeof raw === 'object') {
    for (const field of SNAPSHOT_FIELDS) {
      const value = raw[field];
      if (value === undefined || value === null || value === '') continue;
      out[field] = typeof value === 'number' ? value : String(value).slice(0, 120);
    }
  }
  return out;
}
