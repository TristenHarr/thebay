-- Web push subscriptions (PWA + native). One row per device/browser endpoint.
-- Payload delivery is VAPID-signed by the Worker; see src/push/webpush.ts.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         TEXT PRIMARY KEY,               -- ULID
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,           -- the push service URL (dedup key)
  p256dh     TEXT NOT NULL,                  -- client public key (base64url)
  auth       TEXT NOT NULL,                  -- client auth secret (base64url)
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
