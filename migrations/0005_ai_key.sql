-- Per-user AI provider key (bring-your-own OpenRouter). Stored server-side and
-- NEVER returned to the client (the API exposes only a `hasAiKey` boolean).
ALTER TABLE agent_settings ADD COLUMN ai_key TEXT;
ALTER TABLE agent_settings ADD COLUMN ai_model TEXT;
