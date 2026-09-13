CREATE TABLE IF NOT EXISTS donations (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, donator TEXT NOT NULL DEFAULT 'Anonim', amount INTEGER NOT NULL DEFAULT 0, message TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'unknown', created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_donations_created ON donations (created_at);
CREATE INDEX IF NOT EXISTS idx_donations_source ON donations (source);
CREATE TABLE IF NOT EXISTS totals (donator_key TEXT PRIMARY KEY, donator TEXT NOT NULL, amount INTEGER NOT NULL DEFAULT 0, last_at TEXT);
CREATE INDEX IF NOT EXISTS idx_totals_amount ON totals (amount DESC);
CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, source TEXT, raw TEXT);
