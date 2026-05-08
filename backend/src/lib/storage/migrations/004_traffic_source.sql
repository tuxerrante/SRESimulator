IF COL_LENGTH('sessions', 'traffic_source') IS NULL
BEGIN
  ALTER TABLE sessions
  ADD traffic_source VARCHAR(16) NOT NULL
    CONSTRAINT df_sessions_traffic_source DEFAULT 'player';
END;

IF COL_LENGTH('gameplay_metrics', 'traffic_source') IS NULL
BEGIN
  ALTER TABLE gameplay_metrics
  ADD traffic_source VARCHAR(16) NOT NULL
    CONSTRAINT df_gameplay_metrics_traffic_source DEFAULT 'player';
END;

IF COL_LENGTH('leaderboard_entries', 'traffic_source') IS NULL
BEGIN
  ALTER TABLE leaderboard_entries
  ADD traffic_source VARCHAR(16) NOT NULL
    CONSTRAINT df_leaderboard_entries_traffic_source DEFAULT 'player';
END;

UPDATE sessions
SET traffic_source = 'player'
WHERE traffic_source IS NULL;

UPDATE gameplay_metrics
SET traffic_source = 'player'
WHERE traffic_source IS NULL;

UPDATE leaderboard_entries
SET traffic_source = 'player'
WHERE traffic_source IS NULL;

IF NOT EXISTS (
  SELECT * FROM sys.check_constraints
  WHERE name = 'ck_sessions_traffic_source'
)
BEGIN
  EXEC('
    ALTER TABLE sessions
    ADD CONSTRAINT ck_sessions_traffic_source
    CHECK (traffic_source IN (''player'', ''automated''))
  ');
END;

IF NOT EXISTS (
  SELECT * FROM sys.check_constraints
  WHERE name = 'ck_gameplay_metrics_traffic_source'
)
BEGIN
  EXEC('
    ALTER TABLE gameplay_metrics
    ADD CONSTRAINT ck_gameplay_metrics_traffic_source
    CHECK (traffic_source IN (''player'', ''automated''))
  ');
END;

IF NOT EXISTS (
  SELECT * FROM sys.check_constraints
  WHERE name = 'ck_leaderboard_entries_traffic_source'
)
BEGIN
  EXEC('
    ALTER TABLE leaderboard_entries
    ADD CONSTRAINT ck_leaderboard_entries_traffic_source
    CHECK (traffic_source IN (''player'', ''automated''))
  ');
END;

IF EXISTS (
  SELECT * FROM sys.indexes
  WHERE name = 'ux_leaderboard_entries_github_difficulty'
    AND object_id = OBJECT_ID('leaderboard_entries')
)
BEGIN
  DROP INDEX ux_leaderboard_entries_github_difficulty
  ON leaderboard_entries;
END;

IF NOT EXISTS (
  SELECT * FROM sys.indexes
  WHERE name = 'ux_leaderboard_entries_github_difficulty_source'
    AND object_id = OBJECT_ID('leaderboard_entries')
)
BEGIN
  EXEC('
    CREATE UNIQUE INDEX ux_leaderboard_entries_github_difficulty_source
      ON leaderboard_entries (github_user_id, difficulty, traffic_source)
      WHERE github_user_id IS NOT NULL
  ');
END;

IF NOT EXISTS (
  SELECT * FROM sys.indexes
  WHERE name = 'idx_metrics_traffic_source_created'
    AND object_id = OBJECT_ID('gameplay_metrics')
)
BEGIN
  EXEC('
    CREATE INDEX idx_metrics_traffic_source_created
      ON gameplay_metrics (traffic_source, created_at)
  ');
END;
