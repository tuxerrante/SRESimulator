CREATE TABLE IF NOT EXISTS sessions (
  token            UUID PRIMARY KEY,
  difficulty       VARCHAR(10) NOT NULL CHECK (difficulty IN ('easy','medium','hard')),
  scenario_title   VARCHAR(255) NOT NULL,
  start_time       BIGINT NOT NULL,
  used             BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions (created_at);

CREATE TABLE IF NOT EXISTS leaderboard_entries (
  id                   UUID PRIMARY KEY,
  nickname             VARCHAR(20) NOT NULL CHECK (char_length(trim(nickname)) > 0),
  difficulty           VARCHAR(10) NOT NULL CHECK (difficulty IN ('easy','medium','hard')),
  score_efficiency     INT NOT NULL DEFAULT 0,
  score_safety         INT NOT NULL DEFAULT 0,
  score_documentation  INT NOT NULL DEFAULT 0,
  score_accuracy       INT NOT NULL DEFAULT 0,
  score_total          INT NOT NULL DEFAULT 0,
  grade                VARCHAR(5) NOT NULL,
  command_count        INT NOT NULL DEFAULT 0,
  duration_ms          BIGINT NOT NULL,
  scenario_title       VARCHAR(255) NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (nickname, difficulty)
);

CREATE TABLE IF NOT EXISTS gameplay_metrics (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_token          UUID REFERENCES sessions(token) ON DELETE SET NULL,
  nickname               VARCHAR(20),
  difficulty             VARCHAR(10),
  scenario_title         VARCHAR(255),
  commands_executed      JSONB DEFAULT '[]',
  scoring_events         JSONB DEFAULT '[]',
  chat_message_count     INT DEFAULT 0,
  ai_prompt_tokens       INT DEFAULT 0,
  ai_completion_tokens   INT DEFAULT 0,
  duration_ms            BIGINT,
  completed              BOOLEAN DEFAULT FALSE,
  metadata               JSONB DEFAULT '{}',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_metrics_nickname ON gameplay_metrics (nickname);
CREATE INDEX IF NOT EXISTS idx_metrics_created ON gameplay_metrics (created_at);
