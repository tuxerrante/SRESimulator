IF COL_LENGTH('sessions', 'traffic_source') IS NULL
BEGIN
  ALTER TABLE sessions
    ADD traffic_source VARCHAR(16) NOT NULL
      CONSTRAINT df_sessions_traffic_source DEFAULT 'player' WITH VALUES;
END;

IF NOT EXISTS (
  SELECT * FROM sys.check_constraints
  WHERE name = 'ck_sessions_traffic_source'
    AND parent_object_id = OBJECT_ID('sessions')
)
  EXEC('ALTER TABLE sessions
    ADD CONSTRAINT ck_sessions_traffic_source
      CHECK (traffic_source IN (''player'', ''automated''))');

IF COL_LENGTH('leaderboard_entries', 'traffic_source') IS NULL
BEGIN
  ALTER TABLE leaderboard_entries
    ADD traffic_source VARCHAR(16) NOT NULL
      CONSTRAINT df_leaderboard_traffic_source DEFAULT 'player' WITH VALUES;
END;

IF NOT EXISTS (
  SELECT * FROM sys.check_constraints
  WHERE name = 'ck_leaderboard_traffic_source'
    AND parent_object_id = OBJECT_ID('leaderboard_entries')
)
  EXEC('ALTER TABLE leaderboard_entries
    ADD CONSTRAINT ck_leaderboard_traffic_source
      CHECK (traffic_source IN (''player'', ''automated''))');

IF EXISTS (
  SELECT * FROM sys.key_constraints
  WHERE name = 'uq_nickname_difficulty'
    AND parent_object_id = OBJECT_ID('leaderboard_entries')
)
  ALTER TABLE leaderboard_entries
    DROP CONSTRAINT uq_nickname_difficulty;

IF NOT EXISTS (
  SELECT * FROM sys.key_constraints
  WHERE name = 'uq_nickname_difficulty_traffic_source'
    AND parent_object_id = OBJECT_ID('leaderboard_entries')
)
  ALTER TABLE leaderboard_entries
    ADD CONSTRAINT uq_nickname_difficulty_traffic_source
      UNIQUE (nickname, difficulty, traffic_source);

IF COL_LENGTH('gameplay_metrics', 'traffic_source') IS NULL
BEGIN
  ALTER TABLE gameplay_metrics
    ADD traffic_source VARCHAR(16) NOT NULL
      CONSTRAINT df_gameplay_metrics_traffic_source DEFAULT 'player' WITH VALUES;
END;

IF NOT EXISTS (
  SELECT * FROM sys.check_constraints
  WHERE name = 'ck_gameplay_metrics_traffic_source'
    AND parent_object_id = OBJECT_ID('gameplay_metrics')
)
  EXEC('ALTER TABLE gameplay_metrics
    ADD CONSTRAINT ck_gameplay_metrics_traffic_source
      CHECK (traffic_source IN (''player'', ''automated''))');
