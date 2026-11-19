-- 迁移：用户注册/登录 + 数据按用户隔离（在已有库上执行一次）
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  username_lower TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
ALTER TABLE messages ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE todos ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE expenses ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
CREATE TABLE memories_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 0,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, key)
);
INSERT INTO memories_new (id, user_id, key, value, updated_at) SELECT id, 0, key, value, updated_at FROM memories;
DROP TABLE memories;
ALTER TABLE memories_new RENAME TO memories;
CREATE TABLE settings_new (
  user_id INTEGER NOT NULL DEFAULT 0,
  key TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, key)
);
INSERT INTO settings_new (user_id, key, value, updated_at) SELECT 0, key, value, updated_at FROM settings;
DROP TABLE settings;
ALTER TABLE settings_new RENAME TO settings;
