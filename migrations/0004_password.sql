-- Self-contained email+password login. One credential per user; email is the
-- natural login key (UNIQUE). Hash/salt/iterations come from src/auth/password.ts
-- (PBKDF2). No plaintext ever stored.
CREATE TABLE IF NOT EXISTS password_credentials (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email      TEXT NOT NULL UNIQUE,
  salt       TEXT NOT NULL,
  hash       TEXT NOT NULL,
  iterations INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_password_email ON password_credentials(email);
