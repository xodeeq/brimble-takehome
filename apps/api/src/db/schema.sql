CREATE TABLE IF NOT EXISTS deployments (
  id          TEXT    PRIMARY KEY,
  source_type TEXT    NOT NULL CHECK (source_type IN ('git', 'upload')),
  source_url  TEXT,
  source_ref  TEXT,
  image_tag   TEXT,
  status      TEXT    NOT NULL CHECK (status IN ('pending', 'building', 'deploying', 'running', 'failed')),
  error       TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  deployment_id TEXT    NOT NULL REFERENCES deployments(id),
  ts            INTEGER NOT NULL,
  stream        TEXT    NOT NULL CHECK (stream IN ('stdout', 'stderr', 'system')),
  line          TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS logs_dep_ts ON logs(deployment_id, ts);
