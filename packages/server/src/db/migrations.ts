import type { Db } from './client.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  github_id BIGINT UNIQUE NOT NULL,
  handle TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id BIGINT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  repo_full_name TEXT,
  deploy_url TEXT,
  UNIQUE (owner_id, name)
);
CREATE TABLE IF NOT EXISTS clans (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  invite_code TEXT UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS clan_members (
  clan_id BIGINT NOT NULL REFERENCES clans(id),
  user_id BIGINT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'active',
  PRIMARY KEY (clan_id, user_id)
);
CREATE TABLE IF NOT EXISTS milestone_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id),
  vertical TEXT NOT NULL CHECK (vertical IN ('build','ship','revenue')),
  rung INT NOT NULL,
  evidence_ref TEXT NOT NULL,
  dedupe_key TEXT UNIQUE NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, vertical, rung)
);
CREATE TABLE IF NOT EXISTS checkins (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clan_id BIGINT NOT NULL REFERENCES clans(id),
  user_id BIGINT NOT NULL REFERENCES users(id),
  week_start DATE NOT NULL,
  shipped TEXT NOT NULL,
  blocked TEXT NOT NULL,
  next_target TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (clan_id, user_id, week_start)
);
`

const TRIGGER_STATEMENTS = [
  `CREATE OR REPLACE FUNCTION enforce_clan_cap() RETURNS trigger AS $fn$
BEGIN
  PERFORM 1 FROM clans WHERE id = NEW.clan_id FOR UPDATE;
  IF (SELECT count(*) FROM clan_members WHERE clan_id = NEW.clan_id) >= 6 THEN
    RAISE EXCEPTION 'clan % is full', NEW.clan_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS clan_cap ON clan_members`,
  `CREATE TRIGGER clan_cap BEFORE INSERT ON clan_members
FOR EACH ROW EXECUTE FUNCTION enforce_clan_cap()`,
]

export async function migrate(db: Db): Promise<void> {
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
    await db.query(stmt)
  }
  for (const stmt of TRIGGER_STATEMENTS) {
    await db.query(stmt)
  }
}
