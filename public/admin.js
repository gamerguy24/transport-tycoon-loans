/** Lender's approval panel. Talks to /api/admin/* using the admin session cookie. */

const $ = (id) => document.getElementById(id);

const state = { view: 'queue', queue: [], loans: [], settings: null, reviewing: null, loanOpen: null };

/* ------------------------------------------------------------- formatting */

const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US').replace(/,/g, ' ');
const pct = (r) => `${(Number(r) * 100).toFixed(2).replace(/\.?0+$/, '')}%`;
const parseAmount = (s) => Number(String(s ?? '').replace(/[^\d]/g, '')) || 0;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const when = (t) => (t ? new Date(t * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

function ago(t) {
  if (!t) return '';
  const mins = Math.round((Date.now() / 1000 - t) / 60);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

/* --------------------------------------------------------------- requests */

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers['content-type'] = 'application/json';

  const res = await fetch(path, {
    ...options,
    headers,
    credentials: 'same-origin',
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }

  if (res.status === 401 && !path.endsWith('/login')) {
    showLogin();
    throw new Error('Session expired');
  }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

/* -------------------------------------------------------------- app shell */

function showLogin() {
  $('login').classList.remove('hidden');
  $('app').classList.add('hidden');
}

function showApp() {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
}

function showView(name) {
  state.view = name;
  document.querySelectorAll('.topbar .tab').forEach((t) => {
    t.setAttribute('aria-selected', String(t.dataset.view === name));
  });
  for (const [id, key] of [
    ['viewQueue', 'queue'], ['viewLoans', 'loans'],
    ['viewHistory', 'history'], ['viewSettings', 'settings'],
  ]) {
    $(id).classList.toggle('hidden', key !== name);
  }
  if (name === 'loans') loadLoans();
  if (name === 'history') loadHistory();
  if (name === 'settings') loadSettings();
}

document.querySelectorAll('.topbar .tab').forEach((tab) => {
  tab.addEventListener('click', () => showView(tab.dataset.view));
});

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginError').innerHTML = '';
  try {
    await api('/api/admin/login', { method: 'POST', body: { password: $('password').value } });
    $('password').value = '';
    showApp();
    await boot();
  } catch (err) {
    $('loginError').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
  }
});

$('logoutBtn').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

$('refreshBtn').addEventListener('click', () => loadQueue());

/* ------------------------------------------------------------------ queue */

async function loadOverview() {
  const { stats, charges } = await api('/api/admin/overview');

  const tiles = [
    ['Pending', stats.pending_apps],
    ['Awaiting payout', stats.awaiting_payout],
    ['Active loans', stats.active_loans],
    ['Overdue', stats.overdue_loans],
    ['Outstanding', money(stats.outstanding)],
    ['Interest earned', money(stats.interest_earned)],
    ['Repaid loans', stats.repaid_loans],
    ['Defaulted', stats.defaulted_loans],
  ];
  $('stats').innerHTML = tiles
    .map(([label, value]) => `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`)
    .join('');

  if (charges?.error) {
    $('charges').innerHTML = `<div class="notice warn">API key: ${esc(charges.error)}</div>`;
  } else if (charges?.remaining !== null && charges?.remaining !== undefined) {
    const low = charges.remaining < 100;
    $('charges').innerHTML = `<div class="notice ${low ? 'warn' : ''}">
      API charges remaining: <b>${esc(charges.remaining)}</b>
      ${low ? ' — top up in game with <code>/api private refill</code>' : ''}</div>`;
  } else {
    $('charges').innerHTML = '';
  }
}

async function loadQueue() {
  const { applications } = await api('/api/admin/applications?status=pending&limit=100');
  state.queue = applications;
  $('queueCount').textContent = applications.length ? `(${applications.length})` : '';

  if (!applications.length) {
    $('queueList').innerHTML = '<div class="empty">Nothing waiting. All caught up.</div>';
    return;
  }

  $('queueList').innerHTML = applications.map(queueCard).join('');
  await loadOverview();
}

function queueCard(app) {
  const snap = app.snapshot || {};
  const funds = (snap.wallet ?? 0) + (snap.bank ?? 0);
  return `
    <div class="panel stack">
      <div class="spread">
        <div>
          <h2>${esc(app.player_name)} <span class="muted small">#${esc(app.user_id)}</span></h2>
          <span class="small muted">Application #${app.id} · ${ago(app.created_at)}</span>
        </div>
        <div class="right">
          <div style="font-size:1.4rem;font-weight:700" class="mono">${money(app.amount)}</div>
          <span class="small muted">repay ${money(app.total_repayable)} in ${app.term_days}d</span>
        </div>
      </div>

      <div class="row small">
        <span class="pill ${app.identity_verified ? 'active' : 'pending'}">
          ${app.identity_verified ? 'verified online' : 'identity unconfirmed'}
        </span>
        ${snap.job_title ? `<span class="pill info">${esc(snap.job_title)}</span>` : ''}
        ${snap.faction_name ? `<span class="pill info">${esc(snap.faction_name)}</span>` : ''}
        <span class="pill cancelled">${pct(app.interest_rate)} interest</span>
      </div>

      <dl class="kv">
        <dt>Wallet + bank at apply time</dt><dd>${snap.wallet === undefined && snap.bank === undefined ? '—' : money(funds)}</dd>
        ${app.purpose ? `<dt>Purpose</dt><dd style="text-align:left">${esc(app.purpose)}</dd>` : ''}
        ${app.collateral ? `<dt>Collateral</dt><dd style="text-align:left">${esc(app.collateral)}</dd>` : ''}
      </dl>

      <div class="row">
        <button class="btn primary" data-review="${app.id}">Review</button>
      </div>
    </div>`;
}

$('queueList').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-review]');
  if (btn) openReview(Number(btn.dataset.review));
});

/* --------------------------------------------------------------- review */

async function openReview(id) {
  const detail = await api(`/api/admin/applications/${id}`);
  state.reviewing = detail;
  const app = detail.application;
  const snap = app.snapshot || {};
  const tr = detail.track_record;

  $('reviewTitle').textContent = `${app.player_name} · #${app.user_id}`;
  $('reviewBody').innerHTML = `
    <div class="card">
      <dl class="kv">
        <dt>Requested</dt><dd class="mono"><b>${money(app.amount)}</b></dd>
        <dt>Term</dt><dd>${app.term_days} days</dd>
        <dt>Interest</dt><dd>${pct(app.interest_rate)} → ${money(app.total_repayable - app.amount)}</dd>
        <dt>Total repayable</dt><dd class="mono"><b>${money(app.total_repayable)}</b></dd>
        <dt>Submitted</dt><dd>${when(app.created_at)}</dd>
      </dl>
    </div>

    ${app.identity_verified
      ? ''
      : `<div class="notice warn">This player was not confirmed online when they signed in.
           Check the name and ID against the server before approving.</div>`}
    ${detail.player?.blocked ? `<div class="notice error">Player is blocked: ${esc(detail.player.blocked_reason || '')}</div>` : ''}

    ${app.purpose ? `<div class="card"><h3>Purpose</h3><p class="small" style="margin:6px 0 0">${esc(app.purpose)}</p></div>` : ''}
    ${app.collateral ? `<div class="card"><h3>Collateral</h3><p class="small" style="margin:6px 0 0">${esc(app.collateral)}</p></div>` : ''}

    <div class="card">
      <div class="spread"><h3>In-game snapshot at apply time</h3>
        <button class="btn sm ghost" id="wealthBtn">Check live balance (1 charge)</button></div>
      <dl class="kv" style="margin-top:8px">
        <dt>Wallet</dt><dd>${snap.wallet !== undefined ? money(snap.wallet) : '—'}</dd>
        <dt>Bank</dt><dd>${snap.bank !== undefined ? money(snap.bank) : '—'}</dd>
        <dt>Job</dt><dd>${esc(snap.job_title || snap.job || '—')}</dd>
        <dt>Faction</dt><dd>${esc(snap.faction_name || '—')}</dd>
        <dt>Location</dt><dd>${esc(snap.zoneName || snap.street || '—')}</dd>
      </dl>
      <div id="wealthResult"></div>
    </div>

    <div class="card">
      <h3>Track record</h3>
      <dl class="kv" style="margin-top:8px">
        <dt>Loans taken</dt><dd>${tr.loans_taken}</dd>
        <dt>Repaid in full</dt><dd>${tr.repaid}</dd>
        <dt>Defaulted</dt><dd>${tr.defaulted}</dd>
        <dt>Previous applications</dt><dd>${detail.history.length}</dd>
      </dl>
      ${detail.loans.length
        ? `<div class="table-wrap" style="margin-top:10px"><table><thead><tr>
             <th>#</th><th class="num">Principal</th><th class="num">Repaid</th><th>Status</th></tr></thead><tbody>
             ${detail.loans.map((l) => `<tr><td>${l.id}</td><td class="num">${money(l.principal)}</td>
               <td class="num">${money(l.amount_repaid)}</td><td><span class="pill ${l.status}">${l.status.replace(/_/g, ' ')}</span></td></tr>`).join('')}
           </tbody></table></div>`
        : ''}
    </div>

    <div class="card stack">
      <h3>Your decision</h3>
      <div class="row">
        <div class="field" style="margin:0">
          <label for="counterAmount">Amount to lend</label>
          <input id="counterAmount" inputmode="numeric" value="${app.amount.toLocaleString('en-US').replace(/,/g, ' ')}">
        </div>
        <div class="field" style="margin:0">
          <label for="counterTerm">Term (days)</label>
          <input id="counterTerm" inputmode="numeric" value="${app.term_days}">
        </div>
      </div>
      <div class="field" style="margin:0">
        <label for="decisionNote">Note to the player</label>
        <textarea id="decisionNote" maxlength="500" placeholder="Optional — shown to them in game"></textarea>
      </div>
      <p class="small muted" style="margin:0">
        Approving records the agreement. You still hand over the money in game, then mark it paid out on the Loans tab —
        that is when the repayment clock starts.
      </p>
    </div>`;

  $('wealthBtn').addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Checking…';
    try {
      const res = await api(`/api/admin/players/${app.user_id}/wealth`);
      $('wealthResult').innerHTML = res.ok
        ? `<div class="notice ok" style="margin-top:10px">Live: wallet ${money(res.data?.wallet)} ·
             bank ${money(res.data?.bank)} · existing game loan ${money(res.data?.loan ?? 0)}
             ${res.cached ? '<span class="muted">(cached)</span>' : ''}</div>`
        : `<div class="notice warn" style="margin-top:10px">${esc(res.error || 'Lookup failed')} —
             the player usually has to be online for this.</div>`;
    } catch (err) {
      $('wealthResult').innerHTML = `<div class="notice error" style="margin-top:10px">${esc(err.message)}</div>`;
    } finally {
      e.target.disabled = false;
      e.target.textContent = 'Check live balance (1 charge)';
    }
  });

  $('reviewDialog').showModal();
}

$('approveBtn').addEventListener('click', async () => {
  const app = state.reviewing?.application;
  if (!app) return;
  const amount = parseAmount($('counterAmount').value);
  const term = Number($('counterTerm').value);
  if (!confirm(`Approve ${money(amount)} to ${app.player_name} over ${term} days?`)) return;

  try {
    const res = await api(`/api/admin/applications/${app.id}/approve`, {
      method: 'POST',
      body: { amount, term_days: term, note: $('decisionNote').value.trim() || null },
    });
    $('reviewDialog').close();
    toast(`Approved. Loan #${res.loan.id} is awaiting payout of ${money(res.loan.principal)}.`);
    await loadQueue();
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('rejectBtn').addEventListener('click', async () => {
  const app = state.reviewing?.application;
  if (!app) return;
  const note = $('decisionNote').value.trim();
  if (!confirm(`Reject application #${app.id} from ${app.player_name}?`)) return;

  try {
    await api(`/api/admin/applications/${app.id}/reject`, { method: 'POST', body: { note: note || null } });
    $('reviewDialog').close();
    toast('Application rejected.');
    await loadQueue();
  } catch (err) {
    toast(err.message, 'error');
  }
});

/* ------------------------------------------------------------------ loans */

$('loanFilter').addEventListener('change', loadLoans);

async function loadLoans() {
  const { loans } = await api(`/api/admin/loans?status=${encodeURIComponent($('loanFilter').value)}`);
  state.loans = loans;

  $('loansBody').innerHTML = loans.length
    ? loans.map((l) => `
      <tr>
        <td>${l.id}</td>
        <td>${esc(l.player_name)}<div class="small muted">#${l.user_id}</div></td>
        <td class="num">${money(l.principal)}</td>
        <td class="num">${money(l.total_due)}</td>
        <td class="num">${money(l.amount_repaid)}</td>
        <td class="num"><b>${money(l.outstanding)}</b></td>
        <td><span class="pill ${l.overdue ? 'overdue' : l.status}">${l.overdue ? 'overdue' : l.status.replace(/_/g, ' ')}</span></td>
        <td class="small">${l.due_at ? when(l.due_at) : '<span class="muted">not paid out</span>'}</td>
        <td class="right">
          ${l.status === 'awaiting_payout'
            ? `<button class="btn sm good" data-payout="${l.id}">Mark paid out</button>`
            : `<button class="btn sm" data-loan="${l.id}">Open</button>`}
        </td>
      </tr>`).join('')
    : '<tr><td colspan="9" class="empty">No loans here.</td></tr>';
}

$('loansBody').addEventListener('click', async (e) => {
  const payout = e.target.closest('[data-payout]');
  if (payout) {
    if (!confirm('Confirm you have handed over the money in game. This starts the repayment clock.')) return;
    try {
      const res = await api(`/api/admin/loans/${payout.dataset.payout}/payout`, { method: 'POST' });
      toast(`Loan #${res.loan.id} is now active, due ${when(res.loan.due_at)}.`);
      await loadLoans();
    } catch (err) {
      toast(err.message, 'error');
    }
    return;
  }
  const open = e.target.closest('[data-loan]');
  if (open) openLoan(Number(open.dataset.loan));
});

async function openLoan(id) {
  const { loan, repayments } = await api(`/api/admin/loans/${id}`);
  state.loanOpen = loan;

  $('loanTitle').textContent = `Loan #${loan.id} · ${loan.player_name}`;
  $('loanBody').innerHTML = `
    <div class="card">
      <dl class="kv">
        <dt>Principal</dt><dd>${money(loan.principal)}</dd>
        <dt>Interest</dt><dd>${pct(loan.interest_rate)} → ${money(loan.total_due - loan.principal)}</dd>
        <dt>Total due</dt><dd><b>${money(loan.total_due)}</b></dd>
        <dt>Repaid</dt><dd>${money(loan.amount_repaid)}</dd>
        <dt>Outstanding</dt><dd><b>${money(loan.outstanding)}</b></dd>
        <dt>Paid out</dt><dd>${when(loan.paid_out_at)}</dd>
        <dt>Due</dt><dd>${when(loan.due_at)}</dd>
      </dl>
      <div class="bar" style="margin-top:10px"><i style="width:${Math.round(loan.progress * 100)}%"></i></div>
    </div>

    ${loan.status === 'repaid' ? '<div class="notice ok">Fully repaid and closed.</div>' : `
      <div class="card stack">
        <h3>Record a repayment</h3>
        <div class="row">
          <input id="repayAmount" inputmode="numeric" placeholder="${loan.outstanding.toLocaleString('en-US').replace(/,/g, ' ')}">
          <input id="repayNote" placeholder="Note (optional)">
          <button class="btn good" id="repayBtn" style="flex:0 0 auto">Add</button>
        </div>
        <button class="btn sm ghost" id="repayFull" style="align-self:flex-start">Settle in full (${money(loan.outstanding)})</button>
      </div>

      <div class="card stack">
        <h3>Status override</h3>
        <div class="row">
          <button class="btn sm bad" data-status="defaulted" style="flex:0 0 auto">Mark defaulted</button>
          <button class="btn sm" data-status="active" style="flex:0 0 auto">Back to active</button>
        </div>
      </div>`}

    <div class="card">
      <h3>Repayment history</h3>
      ${repayments.length
        ? `<div class="table-wrap" style="margin-top:8px"><table>
             <thead><tr><th>When</th><th class="num">Amount</th><th>Note</th></tr></thead>
             <tbody>${repayments.map((r) => `<tr><td class="small">${when(r.created_at)}</td>
               <td class="num">${money(r.amount)}</td><td class="small">${esc(r.note || '')}</td></tr>`).join('')}</tbody>
           </table></div>`
        : '<p class="small muted" style="margin:6px 0 0">Nothing recorded yet.</p>'}
    </div>`;

  $('repayBtn')?.addEventListener('click', () => submitRepayment(loan.id, parseAmount($('repayAmount').value)));
  $('repayFull')?.addEventListener('click', () => submitRepayment(loan.id, loan.outstanding));
  $('loanBody').querySelectorAll('[data-status]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/admin/loans/${loan.id}/status`, { method: 'POST', body: { status: btn.dataset.status } });
        toast(`Loan #${loan.id} marked ${btn.dataset.status}.`);
        $('loanDialog').close();
        await loadLoans();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });

  $('loanDialog').showModal();
}

async function submitRepayment(loanId, amount) {
  if (!amount || amount < 1) return toast('Enter an amount', 'error');
  try {
    const res = await api(`/api/admin/loans/${loanId}/repayment`, {
      method: 'POST',
      body: { amount, note: $('repayNote')?.value.trim() || null },
    });
    toast(res.settled ? `Loan #${loanId} settled in full.` : `Recorded ${money(amount)}.`);
    $('loanDialog').close();
    await loadLoans();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ---------------------------------------------------------------- history */

$('historyFilter').addEventListener('change', loadHistory);

async function loadHistory() {
  const filter = $('historyFilter').value;
  const [{ applications }, { entries }] = await Promise.all([
    api(`/api/admin/applications?status=${encodeURIComponent(filter)}&limit=200`),
    api('/api/admin/audit?limit=150'),
  ]);

  const decided = applications.filter((a) => a.status !== 'pending');
  $('historyBody').innerHTML = decided.length
    ? decided.map((a) => `
      <tr>
        <td>${a.id}</td>
        <td>${esc(a.player_name)}<div class="small muted">#${a.user_id}</div></td>
        <td class="num">${money(a.amount)}</td>
        <td>${a.term_days}d</td>
        <td><span class="pill ${a.status}">${a.status}</span></td>
        <td class="small">${when(a.created_at)}</td>
        <td class="small">${when(a.decided_at)}</td>
        <td class="small">${esc(a.decision_note || '')}</td>
      </tr>`).join('')
    : '<tr><td colspan="8" class="empty">Nothing yet.</td></tr>';

  $('auditBody').innerHTML = entries.length
    ? entries.map((e) => `
      <tr>
        <td class="small">${when(e.created_at)}</td>
        <td class="small">${esc(e.actor)}</td>
        <td class="small">${esc(e.action)}</td>
        <td class="small">${esc(e.target || '')}</td>
        <td class="small muted">${esc(e.detail || '')}</td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="empty">No activity yet.</td></tr>';
}

/* --------------------------------------------------------------- settings */

async function loadSettings() {
  const { settings } = await api('/api/admin/settings');
  state.settings = settings;
  for (const [key, value] of Object.entries(settings)) {
    const field = $(`set_${key}`);
    if (field) field.value = value;
  }
}

$('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {};
  for (const field of $('settingsForm').querySelectorAll('[name]')) body[field.name] = field.value.trim();

  // The numeric fields accept "100 000 000" for readability; the API wants digits.
  for (const key of ['max_loan_amount', 'min_loan_amount', 'max_active_loans', 'max_pending_apps']) {
    body[key] = String(parseAmount(body[key]));
  }

  try {
    await api('/api/admin/settings', { method: 'PUT', body });
    toast('Settings saved.');
    await loadSettings();
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('diagBtn').addEventListener('click', async () => {
  $('diagnostics').innerHTML = '<div class="notice">Testing…</div>';
  try {
    const d = await api('/api/admin/diagnostics');
    const line = (label, r) =>
      `<dt>${label}</dt><dd>${r.ok ? `<span class="pill active">ok</span> ${r.ms}ms` : `<span class="pill rejected">failed</span> <span class="muted small">${esc(r.error || 'HTTP ' + r.status)}</span>`}</dd>`;
    const anyOk = d.proxy?.ok || d.direct?.ok;
    $('diagnostics').innerHTML = `
      <dl class="kv">${line('cfx.re proxy (HTTPS)', d.proxy)}${line('Direct TCP socket', d.direct)}
        <dt>Server</dt><dd>${esc(d.server)}</dd></dl>
      ${anyOk ? '' : '<div class="notice error" style="margin-top:10px">Neither route reached the game server. Identity checks and balance lookups will be unavailable.</div>'}`;
  } catch (err) {
    $('diagnostics').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
  }
});

/* ------------------------------------------------------------------- boot */

async function boot() {
  await loadQueue();
  showView('queue');
}

(async function start() {
  try {
    await api('/api/admin/session');
    showApp();
    await boot();
  } catch {
    showLogin();
  }
})();
