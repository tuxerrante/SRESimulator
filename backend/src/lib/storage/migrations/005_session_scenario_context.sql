IF COL_LENGTH('sessions', 'scenario_id') IS NULL
BEGIN
  ALTER TABLE sessions
  ADD scenario_id NVARCHAR(255) NULL;
END;

IF COL_LENGTH('sessions', 'scenario_payload') IS NULL
BEGIN
  ALTER TABLE sessions
  ADD scenario_payload NVARCHAR(MAX) NULL;
END;
