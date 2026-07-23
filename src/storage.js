const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

let db = null;
let dbFilePath = null;
let initialized = false;
let writeQueue = Promise.resolve();

function sqlitePath(dataDir) {
  return process.env.SQLITE_PATH || path.join(dataDir, "job-searcher.sqlite");
}

async function chmodSqliteFiles(databasePath) {
  for (const filePath of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    await fs.chmod(filePath, 0o600).catch(() => {});
  }
}

function ensureDb() {
  if (!db || !initialized) {
    throw new Error("Storage is not initialized");
  }
  return db;
}

function readJsonFileSync(filePath, fallback) {
  try {
    return JSON.parse(require("node:fs").readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function backupFileIfExists(filePath) {
  if (!(await fileExists(filePath))) return null;
  const backupPath = `${filePath}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await fs.copyFile(filePath, backupPath);
  await fs.chmod(backupPath, 0o600).catch(() => {});
  return backupPath;
}

function runTransaction(database, operation) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function userIndexFields(user) {
  const profile = normalizeLegacySearchProfile(user.searchProfile || {});
  return {
    telegramChatId: user.telegramChatId || user.telegram_chat_id || null,
    telegramUserId: user.telegramUserId || user.telegram_user_id || null,
    status: user.status || "active",
    profileStatus: profile.status || null,
    createdAt: user.createdAt || user.created_at || new Date().toISOString(),
    updatedAt: user.updatedAt || user.updated_at || new Date().toISOString(),
  };
}

function valueHasData(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.values(value).some(valueHasData);
  return value !== undefined && value !== null && value !== "";
}

function normalizeLegacySearchProfile(profile) {
  if (!profile || typeof profile !== "object") return {};
  const normalized = { ...profile };
  if (!normalized.status) {
    const hasData = Object.entries(normalized).some(([key, value]) => {
      if (["status", "updatedAt", "source", "resumeId"].includes(key)) return false;
      return valueHasData(value);
    });
    normalized.status = hasData ? "active" : "draft";
  }
  return normalized;
}

function normalizeLegacyUser(user) {
  if (!user || typeof user !== "object") return user;
  return {
    ...user,
    searchProfile: normalizeLegacySearchProfile(user.searchProfile || {}),
  };
}

function hashId(prefix, value) {
  return `${prefix}_${crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 24)}`;
}

function canonicalJobKey(job) {
  return [
    job.title,
    job.company,
    job.location,
  ]
    .map((part) => String(part || "").toLowerCase().replace(/\s+/g, " ").trim())
    .join("|");
}

function deleteStructuredUserData(database, userId) {
  for (const table of [
    "search_profiles",
    "resume_files",
    "found_jobs",
    "sent_jobs",
    "job_feedback",
    "learned_preferences",
    "digest_state",
  ]) {
    database.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId);
  }
}

function mirrorUserStructuredData(database, userId, user) {
  const fields = userIndexFields(user);
  deleteStructuredUserData(database, userId);

  if (user.searchProfile && Object.keys(user.searchProfile).length) {
    database.prepare(
      `INSERT INTO search_profiles (user_id, telegram_user_id, status, json, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      userId,
      fields.telegramUserId,
      user.searchProfile.status || null,
      JSON.stringify(user.searchProfile),
      user.searchProfile.updatedAt || fields.updatedAt
    );
  }

  const resumeId = user.searchProfile?.resumeId;
  if (resumeId) {
    const resumeRecord = {
      id: resumeId,
      resumeFacts: user.resumeFacts || null,
      source: user.searchProfile?.source || null,
    };
    database.prepare(
      `INSERT INTO resume_files (id, user_id, telegram_user_id, file_name, stored_at, text_path, json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         json=excluded.json`
    ).run(
      resumeId,
      userId,
      fields.telegramUserId,
      null,
      null,
      null,
      JSON.stringify(resumeRecord),
      fields.updatedAt
    );
  }

  for (const job of user.foundJobs || []) {
    if (!job.sourceUrl) continue;
    const id = job.shortId || hashId("found", `${userId}:${job.sourceUrl}`);
    database.prepare(
      `INSERT OR IGNORE INTO found_jobs (
        id, user_id, telegram_user_id, source, external_id, source_url,
        canonical_key, status, json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      userId,
      fields.telegramUserId,
      job.source || null,
      job.externalId || null,
      job.sourceUrl,
      canonicalJobKey(job),
      job.status || "found",
      JSON.stringify(job),
      job.foundAt || fields.updatedAt,
      job.feedbackUpdatedAt || job.sentAt || job.foundAt || fields.updatedAt
    );
  }

  for (const job of user.sentJobs || []) {
    if (!job.sourceUrl) continue;
    const id = job.shortId || hashId("sent", `${userId}:${job.sourceUrl}`);
    database.prepare(
      `INSERT OR IGNORE INTO sent_jobs (
        id, user_id, telegram_user_id, source, external_id, source_url,
        message_id, status, json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      userId,
      fields.telegramUserId,
      job.source || null,
      job.externalId || null,
      job.sourceUrl,
      job.messageId || null,
      job.status || "sent",
      JSON.stringify(job),
      job.sentAt || fields.updatedAt,
      job.feedbackUpdatedAt || job.sentAt || fields.updatedAt
    );
  }

  for (const feedback of user.jobFeedback || []) {
    if (!feedback.jobShortId) continue;
    database.prepare(
      `INSERT INTO job_feedback (
        user_id, telegram_user_id, job_short_id, signal, source, source_url,
        json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, job_short_id) DO UPDATE SET
        signal=excluded.signal,
        json=excluded.json,
        updated_at=excluded.updated_at`
    ).run(
      userId,
      feedback.telegramUserId || fields.telegramUserId,
      feedback.jobShortId,
      feedback.signal,
      feedback.source || null,
      feedback.sourceUrl || null,
      JSON.stringify(feedback),
      feedback.createdAt || fields.updatedAt,
      feedback.updatedAt || feedback.createdAt || fields.updatedAt
    );
  }

  if (user.learnedPreferences) {
    database.prepare(
      `INSERT INTO learned_preferences (user_id, telegram_user_id, json, updated_at)
       VALUES (?, ?, ?, ?)`
    ).run(
      userId,
      fields.telegramUserId,
      JSON.stringify(user.learnedPreferences),
      user.learnedPreferences.updatedAt || fields.updatedAt
    );
  }

  if (user.digestSettings) {
    database.prepare(
      `INSERT INTO digest_state (user_id, telegram_user_id, json, updated_at)
       VALUES (?, ?, ?, ?)`
    ).run(
      userId,
      fields.telegramUserId,
      JSON.stringify(user.digestSettings),
      fields.updatedAt
    );
  }
}

function upsertUser(database, userId, user) {
  const fields = userIndexFields(user);
  database.prepare(
    `INSERT INTO users (
      id,
      telegram_chat_id,
      telegram_user_id,
      status,
      profile_status,
      json,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      telegram_chat_id=excluded.telegram_chat_id,
      telegram_user_id=excluded.telegram_user_id,
      status=excluded.status,
      profile_status=excluded.profile_status,
      json=excluded.json,
      updated_at=excluded.updated_at`
  ).run(
    userId,
    fields.telegramChatId,
    fields.telegramUserId,
    fields.status,
    fields.profileStatus,
    JSON.stringify(user),
    fields.createdAt,
    fields.updatedAt
  );
  mirrorUserStructuredData(database, userId, user);
}

function setupSchema(database) {
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      telegram_chat_id INTEGER,
      telegram_user_id INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      profile_status TEXT,
      json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_users_telegram_user_id ON users(telegram_user_id);
    CREATE INDEX IF NOT EXISTS idx_users_profile_status ON users(profile_status);

    CREATE TABLE IF NOT EXISTS bot_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS search_profiles (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      telegram_user_id INTEGER,
      status TEXT,
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS resume_files (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      telegram_user_id INTEGER,
      file_name TEXT,
      stored_at TEXT,
      text_path TEXT,
      json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS found_jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      telegram_user_id INTEGER,
      source TEXT,
      external_id TEXT,
      source_url TEXT NOT NULL,
      canonical_key TEXT,
      status TEXT,
      json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_found_jobs_user_url ON found_jobs(user_id, source_url);
    CREATE INDEX IF NOT EXISTS idx_found_jobs_user_source_external ON found_jobs(user_id, source, external_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_found_jobs_user_source_external_unique
      ON found_jobs(user_id, source, external_id)
      WHERE external_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_found_jobs_user_canonical ON found_jobs(user_id, canonical_key);

    CREATE TABLE IF NOT EXISTS sent_jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      telegram_user_id INTEGER,
      source TEXT,
      external_id TEXT,
      source_url TEXT NOT NULL,
      message_id INTEGER,
      status TEXT,
      json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sent_jobs_user_url ON sent_jobs(user_id, source_url);

    CREATE TABLE IF NOT EXISTS job_feedback (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      telegram_user_id INTEGER,
      job_short_id TEXT NOT NULL,
      signal TEXT NOT NULL,
      source TEXT,
      source_url TEXT,
      json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, job_short_id)
    );

    CREATE TABLE IF NOT EXISTS learned_preferences (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      telegram_user_id INTEGER,
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS digest_state (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      telegram_user_id INTEGER,
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function parseUserRow(row) {
  return row ? normalizeLegacyUser(JSON.parse(row.json)) : null;
}

function migrateUsersJson(database, usersJsonPath) {
  const count = database.prepare("SELECT COUNT(*) AS count FROM users").get().count;
  if (count > 0) return false;

  const legacy = readJsonFileSync(usersJsonPath, { users: {} });
  const users = legacy.users || {};
  const userIds = Object.keys(users);
  if (!userIds.length) return false;

  runTransaction(database, () => {
    for (const userId of userIds) {
      upsertUser(database, userId, users[userId]);
    }
  });
  return true;
}

function migrateBotStateJson(database, stateJsonPath) {
  const existing = database.prepare("SELECT value FROM bot_state WHERE key = ?").get("polling");
  if (existing) return false;

  const legacy = readJsonFileSync(stateJsonPath, { offset: 0 });
  database.prepare(
    `INSERT INTO bot_state (key, value, updated_at)
     VALUES (?, ?, ?)`
  ).run("polling", JSON.stringify(legacy), new Date().toISOString());
  return true;
}

async function initializeStorage({ dataDir, usersJsonPath, stateJsonPath }) {
  if (initialized) return;

  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  await fs.chmod(dataDir, 0o700);

  const databasePath = sqlitePath(dataDir);
  dbFilePath = databasePath;
  db = new DatabaseSync(databasePath);
  setupSchema(db);
  await chmodSqliteFiles(databasePath);

  const shouldMigrateUsers =
    db.prepare("SELECT COUNT(*) AS count FROM users").get().count === 0 &&
    Object.keys(readJsonFileSync(usersJsonPath, { users: {} }).users || {}).length > 0;
  const shouldMigrateState =
    !db.prepare("SELECT value FROM bot_state WHERE key = ?").get("polling") &&
    (await fileExists(stateJsonPath));

  const backups = [];
  if (shouldMigrateUsers) backups.push(await backupFileIfExists(usersJsonPath));
  if (shouldMigrateState) backups.push(await backupFileIfExists(stateJsonPath));

  const migratedUsers = shouldMigrateUsers ? migrateUsersJson(db, usersJsonPath) : false;
  const migratedState = shouldMigrateState ? migrateBotStateJson(db, stateJsonPath) : false;
  if (migratedUsers || migratedState) {
    console.log(
      `[storage] migration completed: users=${migratedUsers ? "yes" : "no"}, state=${migratedState ? "yes" : "no"}, backups=${backups.filter(Boolean).length}`
    );
  }
  await chmodSqliteFiles(databasePath);
  initialized = true;
}

async function loadUsers() {
  const users = await listUsers();
  return { users: Object.fromEntries(users.map((user) => [user.id, user])) };
}

async function getUser(userId) {
  const database = ensureDb();
  const row = database.prepare("SELECT json FROM users WHERE id = ?").get(String(userId));
  return parseUserRow(row);
}

async function listUsers() {
  const database = ensureDb();
  const rows = database.prepare("SELECT id, json FROM users ORDER BY created_at ASC").all();
  return rows.map(parseUserRow).filter(Boolean);
}

async function listDigestUsers() {
  const users = await listUsers();
  return users.filter((user) => {
    if (user.status && user.status !== "active") return false;
    if (user.searchProfile?.status !== "active") return false;
    if (user.digestSettings?.enabled === false) return false;
    return true;
  });
}

async function saveUser(user) {
  if (!user?.id) {
    throw new Error("Cannot save user without id");
  }

  const database = ensureDb();
  const operation = async () => {
    runTransaction(database, () => {
      upsertUser(database, String(user.id), {
        ...user,
        updatedAt: user.updatedAt || new Date().toISOString(),
      });
    });
    await chmodSqliteFiles(dbFilePath);
  };

  writeQueue = writeQueue.then(operation, operation);
  return writeQueue;
}

async function deleteUser(userId) {
  const database = ensureDb();
  const operation = async () => {
    runTransaction(database, () => {
      database.prepare("DELETE FROM users WHERE id = ?").run(String(userId));
    });
    await chmodSqliteFiles(dbFilePath);
  };

  writeQueue = writeQueue.then(operation, operation);
  return writeQueue;
}

async function saveUsers(store) {
  const database = ensureDb();
  const operation = async () => {
    runTransaction(database, () => {
      const now = new Date().toISOString();

      for (const [userId, user] of Object.entries(store.users || {})) {
        upsertUser(database, userId, {
          ...user,
          updatedAt: user.updatedAt || now,
        });
      }
    });
    await chmodSqliteFiles(dbFilePath);
  };

  writeQueue = writeQueue.then(operation, operation);
  return writeQueue;
}

async function loadBotState() {
  const database = ensureDb();
  const row = database.prepare("SELECT value FROM bot_state WHERE key = ?").get("polling");
  return row ? JSON.parse(row.value) : { offset: 0 };
}

async function saveBotState(state) {
  const database = ensureDb();
  const operation = async () => {
    database.prepare(
      `INSERT INTO bot_state (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value=excluded.value,
         updated_at=excluded.updated_at`
    ).run("polling", JSON.stringify(state), new Date().toISOString());
    await chmodSqliteFiles(dbFilePath);
  };

  writeQueue = writeQueue.then(operation, operation);
  return writeQueue;
}

function closeStorage() {
  if (db) db.close();
  db = null;
  dbFilePath = null;
  initialized = false;
}

module.exports = {
  closeStorage,
  deleteUser,
  getUser,
  initializeStorage,
  listDigestUsers,
  listUsers,
  loadBotState,
  loadUsers,
  saveBotState,
  saveUser,
  saveUsers,
};
