IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'sessions')
CREATE TABLE sessions (
  token            UNIQUEIDENTIFIER PRIMARY KEY,
  difficulty       VARCHAR(10) NOT NULL CHECK (difficulty IN ('easy','medium','hard')),
  scenario_title   NVARCHAR(255) NOT NULL,
  start_time       BIGINT NOT NULL,
  used             BIT NOT NULL DEFAULT 0,
  created_at       DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET()
);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_sessions_created')
  CREATE INDEX idx_sessions_created ON sessions (created_at);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_sessions_start_time')
  CREATE INDEX idx_sessions_start_time ON sessions (start_time);

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'leaderboard_entries')
CREATE TABLE leaderboard_entries (
  id                   UNIQUEIDENTIFIER PRIMARY KEY,
  nickname             NVARCHAR(20) NOT NULL CHECK (LEN(LTRIM(RTRIM(nickname))) > 0),
  difficulty           VARCHAR(10) NOT NULL CHECK (difficulty IN ('easy','medium','hard')),
  score_efficiency     INT NOT NULL DEFAULT 0,
  score_safety         INT NOT NULL DEFAULT 0,
  score_documentation  INT NOT NULL DEFAULT 0,
  score_accuracy       INT NOT NULL DEFAULT 0,
  score_total          INT NOT NULL DEFAULT 0,
  grade                VARCHAR(5) NOT NULL,
  command_count        INT NOT NULL DEFAULT 0,
  duration_ms          BIGINT NOT NULL,
  scenario_title       NVARCHAR(255) NOT NULL,
  created_at           DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  CONSTRAINT uq_nickname_difficulty UNIQUE (nickname, difficulty)
);

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'gameplay_metrics')
CREATE TABLE gameplay_metrics (
  id                     UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
  session_token          UNIQUEIDENTIFIER NULL REFERENCES sessions(token) ON DELETE SET NULL,
  nickname               NVARCHAR(20),
  difficulty             VARCHAR(10),
  scenario_title         NVARCHAR(255),
  commands_executed      NVARCHAR(MAX) DEFAULT '[]',
  scoring_events         NVARCHAR(MAX) DEFAULT '[]',
  chat_message_count     INT DEFAULT 0,
  ai_prompt_tokens       INT DEFAULT 0,
  ai_completion_tokens   INT DEFAULT 0,
  duration_ms            BIGINT,
  completed              BIT DEFAULT 0,
  metadata               NVARCHAR(MAX) DEFAULT '{}',
  created_at             DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET()
);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_metrics_nickname')
  CREATE INDEX idx_metrics_nickname ON gameplay_metrics (nickname);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_metrics_created')
  CREATE INDEX idx_metrics_created ON gameplay_metrics (created_at);
