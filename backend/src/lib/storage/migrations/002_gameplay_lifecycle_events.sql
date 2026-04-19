IF COL_LENGTH('gameplay_metrics', 'lifecycle_state') IS NULL
BEGIN
  ALTER TABLE gameplay_metrics
  ADD lifecycle_state VARCHAR(16) NOT NULL
    CONSTRAINT df_gameplay_metrics_lifecycle_state DEFAULT 'completed';
END;

IF COL_LENGTH('gameplay_metrics', 'command_count') IS NULL
BEGIN
  ALTER TABLE gameplay_metrics
  ADD command_count INT NOT NULL
    CONSTRAINT df_gameplay_metrics_command_count DEFAULT 0;
END;

IF COL_LENGTH('gameplay_metrics', 'score_total') IS NULL
BEGIN
  ALTER TABLE gameplay_metrics
  ADD score_total INT NULL;
END;

IF COL_LENGTH('gameplay_metrics', 'grade') IS NULL
BEGIN
  ALTER TABLE gameplay_metrics
  ADD grade VARCHAR(5) NULL;
END;

IF NOT EXISTS (
  SELECT *
  FROM sys.check_constraints
  WHERE name = 'ck_gameplay_metrics_lifecycle_state'
)
BEGIN
  EXEC('
    ALTER TABLE gameplay_metrics
    ADD CONSTRAINT ck_gameplay_metrics_lifecycle_state
    CHECK (lifecycle_state IN (''started'', ''completed'', ''abandoned''))
  ');
END;

IF NOT EXISTS (
  SELECT *
  FROM sys.indexes
  WHERE name = 'idx_metrics_session_created'
    AND object_id = OBJECT_ID('gameplay_metrics')
)
BEGIN
  EXEC('
    CREATE INDEX idx_metrics_session_created
      ON gameplay_metrics (session_token, created_at)
  ');
END;

IF NOT EXISTS (
  SELECT *
  FROM sys.indexes
  WHERE name = 'idx_metrics_lifecycle_state'
    AND object_id = OBJECT_ID('gameplay_metrics')
)
BEGIN
  EXEC('
    CREATE INDEX idx_metrics_lifecycle_state
      ON gameplay_metrics (lifecycle_state, created_at)
  ');
END;
