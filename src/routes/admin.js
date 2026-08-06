/** Routes for the lender's approval panel at /admin. */

import {
  ApiError,
  bad,
  conflict,
  intField,
  json,
  notFound,
  readJson,
  strField,
} from '../lib/http.js';
import {
  adminCookie,
  clearAdminCookie,
  issueAdminToken,
  requireAdmin,
  timingSafeEqual,
} from '../lib/auth.js';
import {
  EDITABLE_SETTINGS,
  audit,
  decorateLoan,
  getSettings,
  quote,
  setSetting,
} from '../lib/loans.js';
import { diagnose, getCharges, getWealth } from '../lib/tycoon.js';

const ACTOR = 'admin';
const LOGIN_MAX_ATTEMPTS = 8;
const LOGIN_WINDOW = 15 * 60;

/* ----------------------------------------------------------------- session */

export async function login(request, env) {
  if (!env.ADMIN_PASSWORD) throw new ApiError(500, 'ADMIN_PASSWORD secret is not set');

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const attempts = await bumpLoginAttempts(env, ip);
  if (attempts > LOGIN_MAX_ATTEMPTS) {
    throw new ApiError(429, 'Too many failed sign-ins. Wait 15 minutes and try again.');
  }

  const body = await readJson(request);
  if (!timingSafeEqual(body.password, env.ADMIN_PASSWORD)) {
    await audit(env, `ip:${ip}`, 'admin.login_failed', null, null);
    throw new ApiError(401, 'Wrong password');
  }

  await clearLoginAttempts(env, ip);
  await audit(env, ACTOR, 'admin.login', null, `ip:${ip}`);

  const token = await issueAdminToken(env.SESSION_SECRET);
  const secure = new URL(request.url).protocol === 'https:';
  return json({ ok: true }, 200, { 'set-cookie': adminCookie(token, secure) });
}

export async function logout(request, env) {
  const secure = new URL(request.url).protocol === 'https:';
  return json({ ok: true }, 200, { 'set-cookie': clearAdminCookie(secure) });
}

export async function session(request, env) {
  await requireAdmin(request, env);
  return json({ ok: true });
}

async function bumpLoginAttempts(env, ip) {
  const key = `login:${ip}`;
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare('SELECT value, expires_at FROM api_cache WHERE key = ?')
    .bind(key)
    .first();
  const count = row && row.expires_at > now ? Number(row.value) + 1 : 1;
  await env.DB.prepare(
    'INSERT INTO api_cache (key, value, expires_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at'
  )
    .bind(key, String(count), now + LOGIN_WINDOW)
    .run();
  return count;
}

const clearLoginAttempts = (env, ip) =>
  env.DB.prepare('DELETE FROM api_cache WHERE key = ?').bind(`login:${ip}`).run();

/* ---------------------------------------------------------------- overview */

export async function overview(request, env) {
  await requireAdmin(request, env);

  const stats = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM applications WHERE status = 'pending')                     AS pending_apps,
      (SELECT COUNT(*) FROM loans WHERE status = 'awaiting_payout')                    AS awaiting_payout,
      (SELECT COUNT(*) FROM loans WHERE status = 'active')                             AS active_loans,
      (SELECT COUNT(*) FROM loans WHERE status = 'repaid')                             AS repaid_loans,
      (SELECT COUNT(*) FROM loans WHERE status = 'defaulted')                          AS defaulted_loans,
      (SELECT COALESCE(SUM(total_due - amount_repaid), 0) FROM loans
         WHERE status IN ('awaiting_payout','active','defaulted'))                     AS outstanding,
      (SELECT COALESCE(SUM(principal), 0) FROM loans WHERE status != 'awaiting_payout') AS lent_total,
      (SELECT COALESCE(SUM(amount_repaid), 0) FROM loans)                              AS repaid_total,
      (SELECT COALESCE(SUM(total_due - principal), 0) FROM loans WHERE status = 'repaid') AS interest_earned,
      (SELECT COUNT(*) FROM loans WHERE status = 'active'
         AND due_at IS NOT NULL AND due_at < unixepoch())                              AS overdue_loans
  `).first();

  let charges = null;
  try {
    const res = await getCharges(env);
    charges = { remaining: res.remaining, via: res.via, error: res.ok ? null : res.error };
  } catch (err) {
    charges = { remaining: null, error: err.message };
  }

  return json({ stats, charges });
}

export async function diagnostics(request, env) {
  await requireAdmin(request, env);
  return json(await diagnose(env));
}

/* ------------------------------------------------------------ applications */

export async function listApplications(request, env) {
  await requireAdmin(request, env);
  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'pending';
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));

  const where = status === 'all' ? '' : 'WHERE status = ?';
  const stmt = env.DB.prepare(
    `SELECT id, user_id, player_name, amount, term_days, interest_rate, total_repayable, purpose,
            collateral, status, identity_verified, snapshot, created_at, decided_at, decision_note
       FROM applications ${where} ORDER BY created_at DESC LIMIT ?`
  );
  const { results } = await (status === 'all' ? stmt.bind(limit) : stmt.bind(status, limit)).all();

  return json({ applications: (results ?? []).map(parseSnapshot) });
}

export async function getApplication(request, env, params) {
  await requireAdmin(request, env);
  const id = Number(params.id);

  const app = await env.DB.prepare('SELECT * FROM applications WHERE id = ?').bind(id).first();
  if (!app) throw notFound('Application not found');

  const [history, loans, player] = await Promise.all([
    env.DB.prepare(
      'SELECT id, amount, status, created_at, decided_at FROM applications ' +
        'WHERE user_id = ? AND id != ? ORDER BY created_at DESC LIMIT 20'
    )
      .bind(app.user_id, id)
      .all(),
    env.DB.prepare('SELECT * FROM loans WHERE user_id = ? ORDER BY approved_at DESC LIMIT 20')
      .bind(app.user_id)
      .all(),
    env.DB.prepare('SELECT * FROM players WHERE user_id = ?').bind(app.user_id).first(),
  ]);

  const loanList = (loans.results ?? []).map(decorateLoan);
  return json({
    application: parseSnapshot(app),
    player,
    history: history.results ?? [],
    loans: loanList,
    track_record: {
      loans_taken: loanList.length,
      repaid: loanList.filter((l) => l.status === 'repaid').length,
      defaulted: loanList.filter((l) => l.status === 'defaulted').length,
      currently_open: loanList.filter((l) => l.status === 'active' || l.status === 'awaiting_payout').length,
    },
  });
}

/**
 * Approve, optionally with different terms than were requested (a counter-offer).
 * Body: { amount?, term_days?, note? }
 * Creates the loan in `awaiting_payout` - the clock only starts once you record
 * the payout, because the money moves in game and not through this app.
 */
export async function approveApplication(request, env, params) {
  await requireAdmin(request, env);
  const id = Number(params.id);
  const body = await readJson(request).catch(() => ({}));
  const settings = await getSettings(env);

  const app = await env.DB.prepare('SELECT * FROM applications WHERE id = ?').bind(id).first();
  if (!app) throw notFound('Application not found');
  if (app.status !== 'pending') throw conflict(`Already ${app.status}`);

  const amount = body.amount ? intField(body, 'amount', { min: 1, max: settings.maxLoanAmount }) : app.amount;
  const termDays = body.term_days ? intField(body, 'term_days', { min: 1, max: 365 }) : app.term_days;
  const note = strField(body, 'note', { max: 500 });

  if (amount > settings.maxLoanAmount) {
    throw bad(`Over the ${settings.maxLoanAmount.toLocaleString('en-US')} cap`);
  }

  const openLoans = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM loans WHERE user_id = ? AND status IN ('awaiting_payout','active','defaulted')"
  )
    .bind(app.user_id)
    .first();
  if ((openLoans?.n ?? 0) >= settings.maxActiveLoans) {
    throw conflict('This player already has an open loan. Close it before approving another.');
  }

  const q = quote(amount, termDays, settings);

  await env.DB.batch([
    env.DB.prepare(
      "UPDATE applications SET status = 'approved', amount = ?, term_days = ?, interest_rate = ?, " +
        'total_repayable = ?, decided_at = unixepoch(), decided_by = ?, decision_note = ? WHERE id = ?'
    ).bind(amount, termDays, q.effectiveRate, q.totalRepayable, ACTOR, note, id),
    env.DB.prepare(
      'INSERT INTO loans (application_id, user_id, player_name, principal, interest_rate, total_due, ' +
        "term_days, status, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting_payout', unixepoch())"
    ).bind(id, app.user_id, app.player_name, amount, q.effectiveRate, q.totalRepayable, termDays),
  ]);

  await audit(env, ACTOR, 'application.approved', id, `${amount} over ${termDays}d`);
  const loan = await env.DB.prepare('SELECT * FROM loans WHERE application_id = ?').bind(id).first();
  return json({ application_id: id, loan: decorateLoan(loan), quote: q });
}

export async function rejectApplication(request, env, params) {
  await requireAdmin(request, env);
  const id = Number(params.id);
  const body = await readJson(request).catch(() => ({}));
  const note = strField(body, 'note', { max: 500 });

  const app = await env.DB.prepare('SELECT id, status FROM applications WHERE id = ?').bind(id).first();
  if (!app) throw notFound('Application not found');
  if (app.status !== 'pending') throw conflict(`Already ${app.status}`);

  await env.DB.prepare(
    "UPDATE applications SET status = 'rejected', decided_at = unixepoch(), decided_by = ?, " +
      'decision_note = ? WHERE id = ?'
  )
    .bind(ACTOR, note, id)
    .run();
  await audit(env, ACTOR, 'application.rejected', id, note);

  return json({ id, status: 'rejected' });
}

/* -------------------------------------------------------------------- loans */

export async function listLoans(request, env) {
  await requireAdmin(request, env);
  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'open';
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 100));

  let sql = 'SELECT * FROM loans';
  const binds = [];
  if (status === 'open') {
    sql += " WHERE status IN ('awaiting_payout','active','defaulted')";
  } else if (status !== 'all') {
    sql += ' WHERE status = ?';
    binds.push(status);
  }
  sql += ' ORDER BY approved_at DESC LIMIT ?';
  binds.push(limit);

  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return json({ loans: (results ?? []).map(decorateLoan) });
}

export async function getLoan(request, env, params) {
  await requireAdmin(request, env);
  const id = Number(params.id);
  const loan = await env.DB.prepare('SELECT * FROM loans WHERE id = ?').bind(id).first();
  if (!loan) throw notFound('Loan not found');
  const { results } = await env.DB.prepare(
    'SELECT * FROM repayments WHERE loan_id = ? ORDER BY created_at DESC'
  )
    .bind(id)
    .all();
  return json({ loan: decorateLoan(loan), repayments: results ?? [] });
}

/** Records that you handed over the money in game. Starts the repayment clock. */
export async function payoutLoan(request, env, params) {
  await requireAdmin(request, env);
  const id = Number(params.id);
  const loan = await env.DB.prepare('SELECT * FROM loans WHERE id = ?').bind(id).first();
  if (!loan) throw notFound('Loan not found');
  if (loan.status !== 'awaiting_payout') throw conflict(`Loan is already ${loan.status}`);

  await env.DB.prepare(
    "UPDATE loans SET status = 'active', paid_out_at = unixepoch(), " +
      'due_at = unixepoch() + (term_days * 86400) WHERE id = ?'
  )
    .bind(id)
    .run();
  await audit(env, ACTOR, 'loan.paid_out', id, String(loan.principal));

  const updated = await env.DB.prepare('SELECT * FROM loans WHERE id = ?').bind(id).first();
  return json({ loan: decorateLoan(updated) });
}

/** Body: { amount, note? } - records a repayment the player made in game. */
export async function addRepayment(request, env, params) {
  await requireAdmin(request, env);
  const id = Number(params.id);
  const body = await readJson(request);
  const note = strField(body, 'note', { max: 300 });

  const loan = await env.DB.prepare('SELECT * FROM loans WHERE id = ?').bind(id).first();
  if (!loan) throw notFound('Loan not found');
  if (loan.status === 'awaiting_payout') throw conflict('Mark the loan as paid out first');
  if (loan.status === 'repaid') throw conflict('This loan is already fully repaid');

  const outstanding = loan.total_due - loan.amount_repaid;
  const amount = intField(body, 'amount', { min: 1, max: outstanding });

  const repaid = loan.amount_repaid + amount;
  const settled = repaid >= loan.total_due;

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO repayments (loan_id, amount, note, recorded_by, created_at) ' +
        'VALUES (?, ?, ?, ?, unixepoch())'
    ).bind(id, amount, note, ACTOR),
    env.DB.prepare(
      'UPDATE loans SET amount_repaid = ?, status = ?, closed_at = ? WHERE id = ?'
    ).bind(repaid, settled ? 'repaid' : 'active', settled ? Math.floor(Date.now() / 1000) : null, id),
  ]);

  await audit(env, ACTOR, 'loan.repayment', id, `${amount}${settled ? ' (settled)' : ''}`);

  const updated = await env.DB.prepare('SELECT * FROM loans WHERE id = ?').bind(id).first();
  return json({ loan: decorateLoan(updated), settled });
}

/** Body: { status: 'active' | 'defaulted' | 'repaid', note? } - manual override. */
export async function setLoanStatus(request, env, params) {
  await requireAdmin(request, env);
  const id = Number(params.id);
  const body = await readJson(request);
  const status = strField(body, 'status', { required: true });
  const note = strField(body, 'note', { max: 300 });

  if (!['active', 'defaulted', 'repaid'].includes(status)) throw bad('Unsupported status');

  const loan = await env.DB.prepare('SELECT * FROM loans WHERE id = ?').bind(id).first();
  if (!loan) throw notFound('Loan not found');
  if (loan.status === 'awaiting_payout') throw conflict('Mark the loan as paid out first');

  const closed = status === 'repaid' ? Math.floor(Date.now() / 1000) : null;
  await env.DB.prepare('UPDATE loans SET status = ?, closed_at = ?, notes = ? WHERE id = ?')
    .bind(status, closed, note, id)
    .run();
  await audit(env, ACTOR, 'loan.status', id, `${loan.status} -> ${status}`);

  const updated = await env.DB.prepare('SELECT * FROM loans WHERE id = ?').bind(id).first();
  return json({ loan: decorateLoan(updated) });
}

/* ------------------------------------------------------------------ players */

/** Live wallet/bank/loan from the game. Costs one API charge; player must be online. */
export async function playerWealth(request, env, params) {
  await requireAdmin(request, env);
  const userId = Number(params.id);
  const player = await env.DB.prepare('SELECT pkey FROM players WHERE user_id = ?').bind(userId).first();

  try {
    const res = await getWealth(env, userId, player?.pkey || null);
    return json({
      ok: res.ok,
      cached: !!res.cached,
      via: res.via,
      charges: res.charges,
      data: res.data,
      error: res.ok ? null : res.error,
    });
  } catch (err) {
    return json({ ok: false, error: err.message }, 502);
  }
}

/** Body: { blocked: boolean, reason? } */
export async function setPlayerBlock(request, env, params) {
  await requireAdmin(request, env);
  const userId = Number(params.id);
  const body = await readJson(request);
  const blocked = body.blocked ? 1 : 0;
  const reason = strField(body, 'reason', { max: 300 });

  const changed = await env.DB.prepare(
    'UPDATE players SET blocked = ?, blocked_reason = ? WHERE user_id = ?'
  )
    .bind(blocked, blocked ? reason : null, userId)
    .run();
  if (!changed.meta.changes) throw notFound('That player has never opened the app');

  await audit(env, ACTOR, blocked ? 'player.blocked' : 'player.unblocked', userId, reason);
  return json({ user_id: userId, blocked: !!blocked, reason });
}

/* ----------------------------------------------------------------- settings */

export async function getAdminSettings(request, env) {
  await requireAdmin(request, env);
  const s = await getSettings(env);
  return json({ settings: s.raw, editable: EDITABLE_SETTINGS, parsed: { ...s, raw: undefined } });
}

/** Body: { <setting>: <value>, ... } - only known keys are accepted. */
export async function updateAdminSettings(request, env) {
  await requireAdmin(request, env);
  const body = await readJson(request);

  const applied = [];
  for (const [key, value] of Object.entries(body)) {
    if (!EDITABLE_SETTINGS.includes(key)) continue;
    await setSetting(env, key, value);
    applied.push(key);
  }
  if (!applied.length) throw bad('No known settings in that request');

  await audit(env, ACTOR, 'settings.updated', null, applied.join(', '));
  const s = await getSettings(env);
  return json({ settings: s.raw, applied });
}

export async function auditLog(request, env) {
  await requireAdmin(request, env);
  const limit = Math.min(500, Math.max(1, Number(new URL(request.url).searchParams.get('limit')) || 100));
  const { results } = await env.DB.prepare(
    'SELECT * FROM audit_log ORDER BY created_at DESC, id DESC LIMIT ?'
  )
    .bind(limit)
    .all();
  return json({ entries: results ?? [] });
}

function parseSnapshot(row) {
  if (!row?.snapshot) return row;
  try {
    return { ...row, snapshot: JSON.parse(row.snapshot) };
  } catch {
    return { ...row, snapshot: null };
  }
}
