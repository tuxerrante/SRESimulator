;WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY session_token, lifecycle_state
      ORDER BY created_at DESC, id DESC
    ) AS rn
  FROM gameplay_metrics
  WHERE session_token IS NOT NULL
    AND lifecycle_state IS NOT NULL
)
DELETE FROM gameplay_metrics
WHERE id IN (
  SELECT id
  FROM ranked
  WHERE rn > 1
);

IF NOT EXISTS (
  SELECT * FROM sys.indexes
  WHERE name = 'ux_gameplay_metrics_session_lifecycle'
    AND object_id = OBJECT_ID('gameplay_metrics')
)
BEGIN
  EXEC('
    CREATE UNIQUE INDEX ux_gameplay_metrics_session_lifecycle
      ON gameplay_metrics (session_token, lifecycle_state)
      WHERE session_token IS NOT NULL AND lifecycle_state IS NOT NULL
  ');
END;
