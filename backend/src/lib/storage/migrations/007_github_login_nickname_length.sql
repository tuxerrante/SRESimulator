ALTER TABLE leaderboard_entries
  ALTER COLUMN nickname NVARCHAR(39) NOT NULL;

IF EXISTS (
  SELECT *
  FROM sys.indexes
  WHERE name = 'idx_metrics_nickname'
    AND object_id = OBJECT_ID('gameplay_metrics')
)
BEGIN
  DROP INDEX idx_metrics_nickname ON gameplay_metrics;
END;

ALTER TABLE gameplay_metrics
  ALTER COLUMN nickname NVARCHAR(39) NULL;

CREATE INDEX idx_metrics_nickname ON gameplay_metrics (nickname);
