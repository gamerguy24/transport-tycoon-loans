/** Settings, loan arithmetic and the rules that decide who may apply. */

import { bad, conflict } from './http.js';

const DEFAULTS = {
  max_loan_amount: '100000000',
  min_loan_amount: '100000',
  interest_rate: '0.03',
  interest_model: 'flat',
  allowed_terms: '7,14,30',
  max_active_loans: '1',
  max_pending_apps: '1',
  applications_open: '1',
  closed_message: 'Applications are temporarily closed. Check back soon.',
  payout_instructions: 'Once approved, meet the lender in game to receive your payout.',
  repay_instructions:
    'Repay by transferring the amount to the lender in game, then wait for it to be recorded here.',
};

/** Every setting a human is allowed to change from the admin panel. */
export const EDITABLE_SETTINGS = Object.keys(DEFAULTS);

export async function getSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const raw = { ...DEFAULTS };
  for (const row of results ?? []) raw[row.key] = row.value;

  return {
    raw,
    maxLoanAmount: Math.max(1, Math.floor(Number(raw.max_loan_amount))),
    minLoanAmount: Math.max(1, Math.floor(Number(raw.min_loan_amount))),
    interestRate: clampRate(Number(raw.interest_rate)),
    interestModel: raw.interest_model === 'weekly' ? 'weekly' : 'flat',
    allowedTerms: parseTerms(raw.allowed_terms),
    maxActiveLoans: Math.max(0, Math.floor(Number(raw.max_active_loans))),
    maxPendingApps: Math.max(0, Math.floor(Number(raw.max_pending_apps))),
    applicationsOpen: raw.applications_open === '1' || raw.applications_open === 'true',
    closedMessage: raw.closed_message,
    payoutInstructions: raw.payout_instructions,
    repayInstructions: raw.repay_instructions,
  };
}

function clampRate(n) {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 10); // 1000% is already absurd; guards against a typo'd setting
}

function parseTerms(value) {
  const terms = String(value)
    .split(',')
    .map((t) => Math.floor(Number(t.trim())))
    .filter((t) => Number.isFinite(t) && t > 0 && t <= 365);
  return terms.length ? [...new Set(terms)].sort((a, b) => a - b) : [7, 14, 30];
}

export async function setSetting(env, key, value) {
  if (!EDITABLE_SETTINGS.includes(key)) throw bad(`Unknown setting "${key}"`);
  await env.DB.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch()) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()'
  )
    .bind(key, String(value))
    .run();
}

/**
 * What a loan of `principal` over `termDays` costs.
 *   flat   - the rate is charged once, no matter the term
 *   weekly - the rate is charged per started 7-day period
 */
export function quote(principal, termDays, settings) {
  const periods = settings.interestModel === 'weekly' ? Math.max(1, Math.ceil(termDays / 7)) : 1;
  const effectiveRate = settings.interestRate * periods;
  const interest = Math.round(principal * effectiveRate);
  return {
    principal,
    termDays,
    periods,
    ratePerPeriod: settings.interestRate,
    effectiveRate,
    interest,
    totalRepayable: principal + interest,
    model: settings.interestModel,
  };
}

/**
 * Validates a new application against the settings and the player's history.
 * Throws an ApiError describing exactly what blocks them.
 */
export async function assertMayApply(env, settings, userId, amount, termDays) {
  if (!settings.applicationsOpen) throw conflict(settings.closedMessage);

  if (amount < settings.minLoanAmount) {
    throw bad(`The smallest loan is ${settings.minLoanAmount.toLocaleString('en-US')}`);
  }
  if (amount > settings.maxLoanAmount) {
    throw bad(`The largest loan is ${settings.maxLoanAmount.toLocaleString('en-US')} per loan`);
  }
  if (!settings.allowedTerms.includes(termDays)) {
    throw bad(`Term must be one of: ${settings.allowedTerms.join(', ')} days`);
  }

  const player = await env.DB.prepare('SELECT blocked, blocked_reason FROM players WHERE user_id = ?')
    .bind(userId)
    .first();
  if (player?.blocked) {
    throw conflict(player.blocked_reason || 'You are blocked from applying for loans.');
  }

  const pending = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM applications WHERE user_id = ? AND status = 'pending'"
  )
    .bind(userId)
    .first();
  if ((pending?.n ?? 0) >= settings.maxPendingApps) {
    throw conflict(
      settings.maxPendingApps === 1
        ? 'You already have an application waiting for a decision.'
        : `You already have ${settings.maxPendingApps} applications waiting for a decision.`
    );
  }

  const active = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM loans WHERE user_id = ? AND status IN ('awaiting_payout','active','defaulted')"
  )
    .bind(userId)
    .first();
  if ((active?.n ?? 0) >= settings.maxActiveLoans) {
    throw conflict(
      settings.maxActiveLoans === 1
        ? 'You still have an open loan. Pay it off before applying again.'
        : `You already have ${settings.maxActiveLoans} open loans.`
    );
  }
}

/** Adds the derived fields the UI wants without storing them. */
export function decorateLoan(loan) {
  if (!loan) return loan;
  const outstanding = Math.max(0, loan.total_due - loan.amount_repaid);
  const now = Math.floor(Date.now() / 1000);
  return {
    ...loan,
    outstanding,
    progress: loan.total_due > 0 ? Math.min(1, loan.amount_repaid / loan.total_due) : 0,
    overdue: loan.status === 'active' && !!loan.due_at && loan.due_at < now,
    days_remaining: loan.due_at ? Math.ceil((loan.due_at - now) / 86400) : null,
  };
}

export async function audit(env, actor, action, target, detail) {
  await env.DB.prepare(
    'INSERT INTO audit_log (actor, action, target, detail, created_at) VALUES (?, ?, ?, ?, unixepoch())'
  )
    .bind(actor, action, target ? String(target) : null, detail ? String(detail) : null)
    .run();
}
