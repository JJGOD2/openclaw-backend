-- feature_flag_overrides table (not in Prisma schema, managed manually)
CREATE TABLE IF NOT EXISTS feature_flag_overrides (
  flag_key     TEXT        NOT NULL,
  workspace_id TEXT        NOT NULL,
  enabled      BOOLEAN     NOT NULL DEFAULT TRUE,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY  (flag_key, workspace_id)
);

-- Index for fast flag lookups
CREATE INDEX IF NOT EXISTS idx_ffo_workspace ON feature_flag_overrides (workspace_id);

-- Performance: partial index for PENDING reviews
CREATE INDEX IF NOT EXISTS idx_review_pending
  ON review_queue (workspace_id, created_at DESC)
  WHERE status = 'PENDING';

-- Performance: partial index for active sessions
CREATE INDEX IF NOT EXISTS idx_session_active
  ON conversation_sessions (workspace_id, last_active_at DESC)
  WHERE is_active = TRUE;

COMMENT ON TABLE feature_flag_overrides IS 'Per-workspace feature flag overrides (v2.0)';
