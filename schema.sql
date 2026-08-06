-- Transport Tycoon loan service schema (Cloudflare D1 / SQLite)
-- Apply with:  npm run db:init        (remote)
--              npm run db:init:local  (local dev)
-- Safe to re-run; everything is IF NOT EXISTS / OR IGNORE.

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- Every player who has ever opened the app.
CREATE TABLE IF NOT EXISTS players (
  user_id          INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,
  pkey             TEXT,
  first_seen       INTEGER NOT NULL,
  last_seen        INTEGER NOT NULL,
  blocked          INTEGER NOT NULL DEFAULT 0,
  blocked_reason   TEXT
);

-- A loan request awaiting your decision.
CREATE TABLE IF NOT EXISTS applications (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL,
  player_name       TEXT NOT NULL,
  amount            INTEGER NOT NULL,          -- principal requested
  term_days         INTEGER NOT NULL,
  interest_rate     REAL NOT NULL,             -- snapshot of the rate at apply time
  total_repayable   INTEGER NOT NULL,
  purpose           TEXT,
  collateral        TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected | cancelled
  identity_verified INTEGER NOT NULL DEFAULT 0,
  snapshot          TEXT,                      -- JSON of in-game data at apply time
  created_at        INTEGER NOT NULL,
  decided_at        INTEGER,
  decided_by        TEXT,
  decision_note     TEXT
);
CREATE INDEX IF NOT EXISTS idx_app_status  ON applications(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_user    ON applications(user_id, created_at DESC);

-- Created when you approve an application.
CREATE TABLE IF NOT EXISTS loans (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL UNIQUE REFERENCES applications(id),
  user_id        INTEGER NOT NULL,
  player_name    TEXT NOT NULL,
  principal      INTEGER NOT NULL,
  interest_rate  REAL NOT NULL,
  total_due      INTEGER NOT NULL,
  amount_repaid  INTEGER NOT NULL DEFAULT 0,
  term_days      INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'awaiting_payout', -- awaiting_payout | active | repaid | defaulted
  approved_at    INTEGER NOT NULL,
  paid_out_at    INTEGER,
  due_at         INTEGER,
  closed_at      INTEGER,
  notes          TEXT
);
CREATE INDEX IF NOT EXISTS idx_loan_status ON loans(status, due_at);
CREATE INDEX IF NOT EXISTS idx_loan_user   ON loans(user_id);

-- Each repayment you record after the player pays you in game.
CREATE TABLE IF NOT EXISTS repayments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id     INTEGER NOT NULL REFERENCES loans(id),
  amount      INTEGER NOT NULL,
  note        TEXT,
  recorded_by TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_repay_loan ON repayments(loan_id, created_at);

-- Append-only trail of every state change.
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at DESC);

-- Short-lived cache for Tycoon API responses, so we burn as few API charges as possible.
CREATE TABLE IF NOT EXISTS api_cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Defaults. Editable from the admin panel; INSERT OR IGNORE keeps your edits on re-run.
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('max_loan_amount',        '100000000', 0),  -- 100,000,000 per person per loan
  ('min_loan_amount',        '100000',    0),
  ('interest_rate',          '0.03',      0),  -- 3%
  ('interest_model',         'flat',      0),  -- flat = 3% once | weekly = 3% per 7 days of term
  ('allowed_terms',          '7,14,30',   0),  -- selectable repayment terms, in days
  ('max_active_loans',       '1',         0),  -- concurrent active loans per player
  ('max_pending_apps',       '1',         0),  -- concurrent pending applications per player
  ('applications_open',      '1',         0),  -- master switch: 0 closes the queue
  ('closed_message',         'Applications are temporarily closed. Check back soon.', 0),
  ('payout_instructions',    'Once approved, meet the lender in game to receive your payout.', 0),
  ('repay_instructions',     'Repay by transferring the amount to the lender in game, then wait for it to be recorded here.', 0);
