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
