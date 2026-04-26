IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'players')
CREATE TABLE players (
  github_user_id   NVARCHAR(64) PRIMARY KEY,
  github_login     NVARCHAR(255) NOT NULL,
  display_name     NVARCHAR(255) NOT NULL,
  avatar_url       NVARCHAR(1024) NULL,
  created_at       DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  updated_at       DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET()
);

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'anonymous_trial_claims')
CREATE TABLE anonymous_trial_claims (
  claim_key        NVARCHAR(128) PRIMARY KEY,
  created_at_ts    BIGINT NOT NULL,
  expires_at_ts    BIGINT NOT NULL,
  created_at       DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  updated_at       DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET()
);

IF NOT EXISTS (
  SELECT * FROM sys.indexes
  WHERE name = 'idx_anonymous_trial_claims_expires_at'
    AND object_id = OBJECT_ID('anonymous_trial_claims')
)
  CREATE INDEX idx_anonymous_trial_claims_expires_at
  ON anonymous_trial_claims (expires_at_ts);

IF COL_LENGTH('sessions', 'identity_kind') IS NULL
  ALTER TABLE sessions
    ADD identity_kind VARCHAR(10) NOT NULL
      CONSTRAINT df_sessions_identity_kind DEFAULT 'anonymous';

IF COL_LENGTH('sessions', 'github_user_id') IS NULL
  ALTER TABLE sessions ADD github_user_id NVARCHAR(64) NULL;

IF COL_LENGTH('sessions', 'github_login') IS NULL
  ALTER TABLE sessions ADD github_login NVARCHAR(255) NULL;

IF COL_LENGTH('sessions', 'anonymous_claim_key') IS NULL
  ALTER TABLE sessions ADD anonymous_claim_key NVARCHAR(128) NULL;

IF COL_LENGTH('sessions', 'persistent_score_eligible') IS NULL
  ALTER TABLE sessions
    ADD persistent_score_eligible BIT NOT NULL
      CONSTRAINT df_sessions_persistent_score_eligible DEFAULT 0;

IF COL_LENGTH('leaderboard_entries', 'identity_kind') IS NULL
  ALTER TABLE leaderboard_entries
    ADD identity_kind VARCHAR(10) NULL;

IF COL_LENGTH('leaderboard_entries', 'github_user_id') IS NULL
  ALTER TABLE leaderboard_entries ADD github_user_id NVARCHAR(64) NULL;

IF COL_LENGTH('leaderboard_entries', 'github_login') IS NULL
  ALTER TABLE leaderboard_entries ADD github_login NVARCHAR(255) NULL;

IF EXISTS (
  SELECT * FROM sys.key_constraints
  WHERE [type] = 'UQ'
    AND [name] = 'uq_nickname_difficulty'
)
  ALTER TABLE leaderboard_entries DROP CONSTRAINT uq_nickname_difficulty;

IF NOT EXISTS (
  SELECT * FROM sys.indexes
  WHERE name = 'ux_leaderboard_entries_github_difficulty'
    AND object_id = OBJECT_ID('leaderboard_entries')
)
  CREATE UNIQUE INDEX ux_leaderboard_entries_github_difficulty
  ON leaderboard_entries (github_user_id, difficulty)
  WHERE github_user_id IS NOT NULL;
