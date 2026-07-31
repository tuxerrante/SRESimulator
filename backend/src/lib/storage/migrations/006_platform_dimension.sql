IF COL_LENGTH('sessions', 'platform') IS NULL
BEGIN
  ALTER TABLE sessions
  ADD platform VARCHAR(16) NOT NULL
    CONSTRAINT df_sessions_platform DEFAULT 'aro-classic';
END;

IF COL_LENGTH('gameplay_metrics', 'platform') IS NULL
BEGIN
  ALTER TABLE gameplay_metrics
  ADD platform VARCHAR(16) NOT NULL
    CONSTRAINT df_gameplay_metrics_platform DEFAULT 'aro-classic';
END;

IF COL_LENGTH('leaderboard_entries', 'platform') IS NULL
BEGIN
  ALTER TABLE leaderboard_entries
  ADD platform VARCHAR(16) NOT NULL
    CONSTRAINT df_leaderboard_entries_platform DEFAULT 'aro-classic';
END;

EXEC('UPDATE sessions SET platform = ''aro-classic'' WHERE platform IS NULL;');
EXEC('UPDATE gameplay_metrics SET platform = ''aro-classic'' WHERE platform IS NULL;');
EXEC('UPDATE leaderboard_entries SET platform = ''aro-classic'' WHERE platform IS NULL;');

IF EXISTS (
  SELECT *
  FROM sys.key_constraints
  WHERE name = 'uq_nickname_difficulty'
    AND parent_object_id = OBJECT_ID('leaderboard_entries')
)
BEGIN
  ALTER TABLE leaderboard_entries
  DROP CONSTRAINT uq_nickname_difficulty;
END;

IF NOT EXISTS (
  SELECT *
  FROM sys.check_constraints
  WHERE name = 'ck_sessions_platform'
)
BEGIN
  EXEC('
    ALTER TABLE sessions
    ADD CONSTRAINT ck_sessions_platform
    CHECK (platform IN (''aro-classic'', ''aro-hcp'', ''aks''))
  ');
END;

IF NOT EXISTS (
  SELECT *
  FROM sys.check_constraints
  WHERE name = 'ck_gameplay_metrics_platform'
)
BEGIN
  EXEC('
    ALTER TABLE gameplay_metrics
    ADD CONSTRAINT ck_gameplay_metrics_platform
    CHECK (platform IN (''aro-classic'', ''aro-hcp'', ''aks''))
  ');
END;

IF NOT EXISTS (
  SELECT *
  FROM sys.check_constraints
  WHERE name = 'ck_leaderboard_entries_platform'
)
BEGIN
  EXEC('
    ALTER TABLE leaderboard_entries
    ADD CONSTRAINT ck_leaderboard_entries_platform
    CHECK (platform IN (''aro-classic'', ''aro-hcp'', ''aks''))
  ');
END;

IF EXISTS (
  SELECT *
  FROM sys.indexes
  WHERE name = 'ux_leaderboard_entries_github_difficulty_source'
    AND object_id = OBJECT_ID('leaderboard_entries')
)
BEGIN
  DROP INDEX ux_leaderboard_entries_github_difficulty_source
  ON leaderboard_entries;
END;

IF EXISTS (
  SELECT *
  FROM sys.indexes
  WHERE name = 'ux_leaderboard_entries_github_difficulty_traffic'
    AND object_id = OBJECT_ID('leaderboard_entries')
)
BEGIN
  DROP INDEX ux_leaderboard_entries_github_difficulty_traffic
  ON leaderboard_entries;
END;

IF NOT EXISTS (
  SELECT *
  FROM sys.indexes
  WHERE name = 'ux_leaderboard_entries_github_platform_difficulty_traffic'
    AND object_id = OBJECT_ID('leaderboard_entries')
)
BEGIN
  EXEC('
    CREATE UNIQUE INDEX ux_leaderboard_entries_github_platform_difficulty_traffic
      ON leaderboard_entries (github_user_id, platform, difficulty, traffic_source)
      WHERE github_user_id IS NOT NULL
  ');
END;

IF EXISTS (
  SELECT *
  FROM sys.indexes
  WHERE name = 'idx_metrics_traffic_source_session_created'
    AND object_id = OBJECT_ID('gameplay_metrics')
)
BEGIN
  DROP INDEX idx_metrics_traffic_source_session_created
  ON gameplay_metrics;
END;

EXEC('
  CREATE INDEX idx_metrics_traffic_source_platform_session_created
    ON gameplay_metrics (traffic_source, platform, session_token, lifecycle_state, created_at DESC, id DESC)
');

IF NOT EXISTS (
  SELECT *
  FROM sys.indexes
  WHERE name = 'idx_sessions_platform_start_time'
    AND object_id = OBJECT_ID('sessions')
)
BEGIN
  EXEC('
    CREATE INDEX idx_sessions_platform_start_time
      ON sessions (platform, start_time)
  ');
END;

IF NOT EXISTS (
  SELECT *
  FROM sys.indexes
  WHERE name = 'idx_leaderboard_entries_platform_difficulty_score'
    AND object_id = OBJECT_ID('leaderboard_entries')
)
BEGIN
  EXEC('
    CREATE INDEX idx_leaderboard_entries_platform_difficulty_score
      ON leaderboard_entries (platform, difficulty, traffic_source, score_total DESC, duration_ms ASC)
  ');
END;
