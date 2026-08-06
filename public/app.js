/**
 * In-game User Application.
 *
 * The game client posts key/value data into this frame (see the User Applications
 * docs) and listens for command objects posted back to `window.parent`. We use
 * `user_id`, `name` and `pkey` for sign-in, and a handful of other keys as a
 * financial snapshot attached to the application.
 */

const $ = (id) => document.getElementById(id);
const parentPost = (msg) => window.parent.postMessage(msg, '*');

const state = {
  config: null,
  token: localStorage.getItem('tt_loans_token'),
  me: null,
  game: {},        // latest key/value cache from the game client
  signedIn: false,
  signingIn: false,
  tab: 'apply',
};

/* ------------------------------------------------------------- formatting */

/** Matches the in-game HUD, which groups with spaces: $4 949 226 366 */
const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US').replace(/,/g, ' ');
const pct = (r) => `${(Number(r) * 100).toFixed(2).replace(/\.?0+$/, '')}%`;
const parseAmount = (s) => Number(String(s ?? '').replace(/[^\d]/g, '')) || 0;

function whenAt(unixSeconds) {
  if (!unixSeconds) return '—';
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function relative(unixSeconds) {
  if (!unixSeconds) return '';
  const days = Math.ceil((unixSeconds - Date.now() / 1000) / 86400);
  if (days > 1) return `in ${days} days`;
  if (days === 1) return 'tomorrow';
  if (days === 0) return 'today';
  return `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue`;
}

function notice(kind, text) {
  return `<div class="notice ${kind}">${escapeHtml(text)}</div>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* -------------------------------------------------------------- API calls */

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers['content-type'] = 'application/json';
  if (state.token) headers.authorization = `Bearer ${state.token}`;

  const res = await fetch(path, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }

  if (res.status === 401) {
    state.token = null;
    state.signedIn = false;
    localStorage.removeItem('tt_loans_token');
  }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

/* ----------------------------------------------------- game client bridge */

window.addEventListener('message', (event) => {
  const payload = event.data;
  if (!payload || typeof payload !== 'object' || !payload.data) return;

  Object.assign(state.game, payload.data);

  // Cross / Circle: submit or step back, so the app is usable from a controller.
  if ('trigger_cross' in payload.data) $('applyForm')?.requestSubmit();
  if ('trigger_circle' in payload.data) parentPost({ type: 'pin' });

  if (!state.signedIn && !state.signingIn && state.game.user_id) signIn();
  if (state.signedIn) renderPlayerHeader();
});

// Ask for the whole cache immediately - the client only pushes changed keys.
parentPost({ type: 'getData' });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') parentPost({ type: 'pin' });
});

/* ------------------------------------------------------------------ sign in */

async function signIn() {
  state.signingIn = true;
  try {
    const result = await api('/api/session', {
      method: 'POST',
      body: {
        user_id: Number(state.game.user_id),
        name: String(state.game.name || `Player ${state.game.user_id}`),
        pkey: state.game.pkey || null,
      },
    });
    state.token = result.token;
    localStorage.setItem('tt_loans_token', result.token);
    state.signedIn = true;
    $('footStatus').textContent = result.verified ? 'Verified online' : 'Identity unconfirmed';
    await refresh();
    showTab(state.tab);
  } catch (err) {
    $('viewConnecting').innerHTML = notice('error', err.message) +
      '<p class="small muted">Press <kbd>F1</kbd> and reload to try again.</p>';
  } finally {
    state.signingIn = false;
  }
}

/** Restores an existing session on reload without waiting for the game data. */
async function resumeSession() {
  if (!state.token) return false;
  try {
    state.me = await api('/api/me');
    state.signedIn = true;
    renderAll();
    showTab(state.tab);
    return true;
  } catch {
    return false;
  }
}

async function refresh() {
  state.me = await api('/api/me');
  renderAll();
}

/* -------------------------------------------------------------- rendering */

function renderAll() {
  renderPlayerHeader();
  renderApply();
  renderMine();
}

function renderPlayerHeader() {
  const name = state.me?.name || state.game.name;
  const id = state.me?.user_id || state.game.user_id;
  if (!name) return;

  $('whoName').textContent = name;
  $('whoName').classList.remove('muted');

  const bits = [`<span class="pill info">#${escapeHtml(id)}</span>`];
  if (state.me && !state.me.verified) bits.push('<span class="pill pending">unverified</span>');
  if (state.game.bank !== undefined) {
    bits.push(`<span class="small muted mono">bank ${money(state.game.bank)}</span>`);
  }
  $('whoBadge').innerHTML = bits.join(' ');
}

function renderApply() {
  const cfg = state.config;
  const me = state.me;
  if (!cfg || !me) return;

  const block = $('applyBlock');
  const form = $('applyForm');

  let blockedReason = null;
  if (me.blocked) blockedReason = me.blockedReason || 'You are blocked from applying for loans.';
  else if (!cfg.applicationsOpen) blockedReason = cfg.closedMessage;
  else if (!me.canApply) {
    blockedReason = me.applications.some((a) => a.status === 'pending')
      ? 'You already have an application waiting for a decision. Check "My loans".'
      : 'You still have an open loan. Pay it off before applying again.';
  }

  if (blockedReason) {
    block.innerHTML = notice('warn', blockedReason);
    form.classList.add('hidden');
  } else {
    block.innerHTML = '';
    form.classList.remove('hidden');
  }

  $('amountHint').textContent =
    `Between ${money(cfg.minLoanAmount)} and ${money(cfg.maxLoanAmount)} per loan.`;

  if (!$('amountChips').dataset.built) {
    const steps = [0.1, 0.25, 0.5, 1].map((f) => Math.round(cfg.maxLoanAmount * f));
    $('amountChips').innerHTML = steps
      .map((v) => `<button type="button" class="btn sm ghost" data-amount="${v}">${money(v)}</button>`)
      .join('');
    $('amountChips').dataset.built = '1';
    $('amountChips').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-amount]');
      if (!btn) return;
      $('amount').value = money(btn.dataset.amount).slice(1);
      renderQuote();
    });
  }

  if (!$('term').options.length) {
    $('term').innerHTML = cfg.allowedTerms
      .map((d) => `<option value="${d}">${d} days</option>`)
      .join('');
  }

  renderQuote();
}

function renderQuote() {
  const cfg = state.config;
  if (!cfg) return;

  const raw = parseAmount($('amount').value);
  const amount = Math.min(raw, cfg.maxLoanAmount);
  const term = Number($('term').value) || cfg.allowedTerms[0];

  const periods = cfg.interestModel === 'weekly' ? Math.max(1, Math.ceil(term / 7)) : 1;
  const effectiveRate = cfg.interestRate * periods;
  const interest = Math.round(amount * effectiveRate);

  $('quoteRate').textContent =
    cfg.interestModel === 'weekly'
      ? `${pct(cfg.interestRate)}/week · ${pct(effectiveRate)} total`
      : `${pct(effectiveRate)} flat`;
  $('quoteTotal').textContent = money(amount + interest);
  $('quotePrincipal').textContent = money(amount);
  $('quoteInterest').textContent = money(interest);
  $('quoteDue').textContent = `${term} days after payout`;

  $('submitBtn').disabled = amount < cfg.minLoanAmount || amount > cfg.maxLoanAmount;
}

function renderMine() {
  const me = state.me;
  if (!me) return;

  const pending = me.applications.filter((a) => a.status === 'pending');
  const open = me.loans.filter((l) => l.status === 'active' || l.status === 'awaiting_payout');
  $('mineCount').textContent = pending.length + open.length ? `(${pending.length + open.length})` : '';

  $('mineSummary').innerHTML = me.totalOutstanding
    ? `<div class="card spread"><span class="muted">Outstanding right now</span>
         <b class="mono" style="font-size:1.25rem">${money(me.totalOutstanding)}</b></div>`
    : '';

  const parts = [];

  for (const app of me.applications) {
    if (app.status === 'approved') continue; // shown as a loan instead
    parts.push(`
      <div class="card loan-item stack">
        <div class="spread">
          <b>Application #${app.id}</b>
          <span class="pill ${app.status}">${app.status}</span>
        </div>
        <dl class="kv">
          <dt>Requested</dt><dd>${money(app.amount)}</dd>
          <dt>Repay</dt><dd>${money(app.total_repayable)} over ${app.term_days} days</dd>
          <dt>Submitted</dt><dd>${whenAt(app.created_at)}</dd>
        </dl>
        ${app.decision_note ? notice('info', `Lender: ${app.decision_note}`) : ''}
        ${app.status === 'pending'
          ? `<button class="btn sm bad" data-cancel="${app.id}">Withdraw application</button>`
          : ''}
      </div>`);
  }

  for (const loan of me.loans) {
    const statusPill = loan.overdue ? 'overdue' : loan.status;
    const statusText = loan.overdue ? 'overdue' : loan.status.replace(/_/g, ' ');
    parts.push(`
      <div class="card loan-item stack">
        <div class="spread">
          <b>Loan #${loan.id}</b>
          <span class="pill ${statusPill}">${statusText}</span>
        </div>
        <div class="bar"><i style="width:${Math.round(loan.progress * 100)}%"></i></div>
        <dl class="kv">
          <dt>Borrowed</dt><dd>${money(loan.principal)}</dd>
          <dt>Total due</dt><dd>${money(loan.total_due)}</dd>
          <dt>Repaid</dt><dd>${money(loan.amount_repaid)}</dd>
          <dt>Still owed</dt><dd><b>${money(loan.outstanding)}</b></dd>
          <dt>Due date</dt><dd>${loan.due_at ? `${whenAt(loan.due_at)} <span class="muted">(${relative(loan.due_at)})</span>` : 'starts at payout'}</dd>
        </dl>
        ${loan.status === 'awaiting_payout'
          ? notice('ok', 'Approved. Meet the lender in game to collect your money.')
          : ''}
        ${loan.overdue ? notice('error', 'This loan is past its due date. Settle up with the lender.') : ''}
      </div>`);
  }

  $('mineList').innerHTML = parts.length
    ? parts.join('')
    : '<div class="empty">No applications or loans yet.</div>';
}

/* ----------------------------------------------------------------- events */

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => showTab(tab.dataset.tab));
});

function showTab(name) {
  state.tab = name;
  document.querySelectorAll('.tab').forEach((t) => {
    t.setAttribute('aria-selected', String(t.dataset.tab === name));
  });
  $('viewConnecting').classList.toggle('hidden', state.signedIn);
  for (const [view, key] of [['viewApply', 'apply'], ['viewMine', 'mine'], ['viewInfo', 'info']]) {
    $(view).classList.toggle('hidden', !state.signedIn || key !== name);
  }
}

$('amount').addEventListener('input', (e) => {
  const digits = parseAmount(e.target.value);
  e.target.value = digits ? digits.toLocaleString('en-US').replace(/,/g, ' ') : '';
  renderQuote();
});
$('term').addEventListener('change', renderQuote);

$('applyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('submitBtn');
  btn.disabled = true;
  btn.textContent = 'Submitting…';
  $('applyError').innerHTML = '';

  try {
    const result = await api('/api/applications', {
      method: 'POST',
      body: {
        amount: parseAmount($('amount').value),
        term_days: Number($('term').value),
        purpose: $('purpose').value.trim() || null,
        collateral: $('collateral').value.trim() || null,
        snapshot: state.game,
      },
    });
    parentPost({ type: 'notification', text: `Loan application #${result.id} submitted` });
    parentPost({ type: 'sfx', sfx: 6 });
    $('amount').value = '';
    $('purpose').value = '';
    $('collateral').value = '';
    await refresh();
    showTab('mine');
  } catch (err) {
    $('applyError').innerHTML = notice('error', err.message);
    parentPost({ type: 'sfx', sfx: 11 });
  } finally {
    btn.disabled = false;
    btn.textContent = 'Submit application';
    renderQuote();
  }
});

$('mineList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-cancel]');
  if (!btn) return;
  btn.disabled = true;
  try {
    await api(`/api/applications/${btn.dataset.cancel}/cancel`, { method: 'POST' });
    parentPost({ type: 'notification', text: 'Application withdrawn' });
    await refresh();
  } catch (err) {
    parentPost({ type: 'notification', text: err.message });
    btn.disabled = false;
  }
});

$('devGo')?.addEventListener('click', () => {
  state.game.user_id = Number($('devId').value);
  state.game.name = $('devName').value || `Player ${$('devId').value}`;
  if (state.game.user_id) signIn();
});

/* ------------------------------------------------------------------ start */

(async function start() {
  try {
    state.config = await api('/api/config');
  } catch {
    $('viewConnecting').innerHTML = notice('error', 'Cannot reach the loan service.');
    return;
  }

  document.title = state.config.brand;
  $('brand').textContent = state.config.brand;
  $('infoRate').textContent =
    state.config.interestModel === 'weekly'
      ? `${pct(state.config.interestRate)} per week`
      : `${pct(state.config.interestRate)} flat, charged once`;
  $('infoMax').textContent = money(state.config.maxLoanAmount);
  $('infoMin').textContent = money(state.config.minLoanAmount);
  $('infoTerms').textContent = state.config.allowedTerms.map((d) => `${d} days`).join(' · ');
  $('infoPayout').textContent = state.config.payoutInstructions;
  $('infoRepay').textContent = state.config.repayInstructions;

  if (await resumeSession()) return;

  // Outside the game there is no data feed, so offer a manual sign-in locally.
  if (['localhost', '127.0.0.1'].includes(location.hostname)) {
    $('devLogin').classList.remove('hidden');
  }
  showTab('apply');
})();
