const STATUS_LABELS = {
  saved: "Сохранено",
  applied: "Откликнулся",
  archived: "Архив",
};

const INDEX_HTML = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Избранные вакансии</title>
  <link rel="stylesheet" href="/styles.css" />
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
</head>
<body>
  <main class="app">
    <header class="topbar">
      <div>
        <h1>Избранные</h1>
        <p id="summary">Загружаю сохраненные вакансии...</p>
      </div>
      <button id="refreshButton" class="icon-button" type="button" aria-label="Обновить">↻</button>
    </header>

    <nav class="tabs" aria-label="Статус">
      <button class="tab active" type="button" data-status="saved">Сохранено</button>
      <button class="tab" type="button" data-status="applied">Откликнулся</button>
      <button class="tab" type="button" data-status="all">Все</button>
    </nav>

    <section id="content" class="list" aria-live="polite"></section>
  </main>
  <script src="/app.js"></script>
</body>
</html>`;

const STYLES_CSS = `:root {
  color-scheme: light dark;
  --bg: var(--tg-theme-bg-color, #f5f7f8);
  --text: var(--tg-theme-text-color, #162125);
  --hint: var(--tg-theme-hint-color, #65737a);
  --button: var(--tg-theme-button-color, #2f80ed);
  --button-text: var(--tg-theme-button-text-color, #ffffff);
  --surface: var(--tg-theme-secondary-bg-color, #ffffff);
  --border: rgba(101, 115, 122, 0.22);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
}

.app {
  max-width: 760px;
  margin: 0 auto;
  padding: 16px 14px 32px;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

h1 {
  margin: 0;
  font-size: 24px;
  line-height: 1.15;
}

p {
  margin: 0;
}

#summary {
  margin-top: 4px;
  color: var(--hint);
  font-size: 14px;
}

.icon-button,
.tab,
.action {
  border: 0;
  cursor: pointer;
  font: inherit;
}

.icon-button {
  width: 40px;
  height: 40px;
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
  font-size: 22px;
}

.tabs {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  margin-bottom: 14px;
}

.tab {
  min-height: 38px;
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
  font-size: 14px;
}

.tab.active {
  background: var(--button);
  color: var(--button-text);
  border-color: var(--button);
}

.list {
  display: grid;
  gap: 10px;
}

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px;
}

.card h2 {
  margin: 0 0 8px;
  font-size: 17px;
  line-height: 1.25;
}

.meta {
  display: grid;
  gap: 4px;
  color: var(--hint);
  font-size: 14px;
  line-height: 1.35;
  margin-bottom: 10px;
}

.summary {
  font-size: 14px;
  line-height: 1.45;
  margin-bottom: 12px;
}

.actions {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}

.action {
  min-height: 38px;
  border-radius: 8px;
  background: var(--button);
  color: var(--button-text);
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 0 8px;
  font-size: 13px;
}

.action.secondary {
  background: transparent;
  color: var(--text);
  border: 1px solid var(--border);
}

.empty,
.error {
  border: 1px dashed var(--border);
  border-radius: 8px;
  padding: 28px 16px;
  color: var(--hint);
  text-align: center;
  line-height: 1.45;
}

@media (max-width: 430px) {
  .actions {
    grid-template-columns: 1fr;
  }
}`;

const APP_JS = `const tg = window.Telegram?.WebApp;
const state = {
  status: "saved",
  jobs: [],
};

if (tg) {
  tg.ready();
  tg.expand();
}

const content = document.getElementById("content");
const summary = document.getElementById("summary");
const refreshButton = document.getElementById("refreshButton");

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function currentInitData() {
  return tg?.initData || new URLSearchParams(window.location.search).get("tgWebAppData") || "";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-telegram-init-data": currentInitData(),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "request_failed");
  return data;
}

function visibleJobs() {
  if (state.status === "all") return state.jobs.filter((job) => job.status !== "archived");
  return state.jobs.filter((job) => job.status === state.status);
}

function render() {
  const jobs = visibleJobs();
  summary.textContent = state.jobs.length
    ? \`Всего: \${state.jobs.filter((job) => job.status !== "archived").length}\`
    : "Пока нет сохраненных вакансий";

  if (!jobs.length) {
    content.innerHTML = '<div class="empty">Здесь появятся вакансии после нажатия «Сохранить» в боте.</div>';
    return;
  }

  content.innerHTML = jobs.map((job) => {
    const summaryText = job.matchSummary || (job.reasons || []).slice(0, 2).join(" ");
    return \`<article class="card">
      <h2>\${escapeHtml(job.title)}</h2>
      <div class="meta">
        <span>\${escapeHtml(job.company || "Компания не указана")}</span>
        <span>\${escapeHtml(job.location || "Локация не указана")} · \${escapeHtml(job.format || "Формат не указан")}</span>
        <span>\${escapeHtml(job.salary || "Зарплата не указана")}</span>
      </div>
      \${summaryText ? \`<p class="summary">\${escapeHtml(summaryText)}</p>\` : ""}
      <div class="actions">
        <a class="action" href="\${escapeHtml(job.sourceUrl)}" target="_blank" rel="noopener">Источник</a>
        <button class="action secondary" type="button" data-action="applied" data-id="\${escapeHtml(job.shortId)}">Откликнулся</button>
        <button class="action secondary" type="button" data-action="archived" data-id="\${escapeHtml(job.shortId)}">Убрать</button>
      </div>
    </article>\`;
  }).join("");
}

async function loadFavorites() {
  content.innerHTML = '<div class="empty">Загружаю...</div>';
  try {
    const data = await api("/api/favorites");
    state.jobs = data.jobs || [];
    render();
  } catch (error) {
    content.innerHTML = '<div class="error">Не получилось открыть избранные. Открой Mini App из кнопки Telegram-бота.</div>';
    summary.textContent = "Ошибка загрузки";
  }
}

async function setStatus(shortId, status) {
  await api(\`/api/favorites/\${encodeURIComponent(shortId)}/status\`, {
    method: "POST",
    body: JSON.stringify({ status }),
  });
  const job = state.jobs.find((item) => item.shortId === shortId);
  if (job) job.status = status;
  render();
  tg?.HapticFeedback?.notificationOccurred?.("success");
}

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => {
    state.status = button.dataset.status;
    document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item === button));
    render();
  });
});

content.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  setStatus(button.dataset.id, button.dataset.action).catch(() => {
    tg?.HapticFeedback?.notificationOccurred?.("error");
  });
});

refreshButton.addEventListener("click", loadFavorites);
loadFavorites();`;

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers || {}),
    },
  });
}

function text(body, contentType) {
  return new Response(body, {
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=300",
    },
  });
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmac(key, value) {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value));
}

async function verifyTelegramInitData(initData, botToken, maxAgeSeconds) {
  if (!initData || !botToken) throw new Error("telegram_auth_missing");
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash) throw new Error("telegram_hash_missing");

  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = await hmac(new TextEncoder().encode("WebAppData"), botToken);
  const expectedHash = bytesToHex(await hmac(secretKey, dataCheckString));
  if (expectedHash !== receivedHash) throw new Error("telegram_hash_invalid");

  const authDate = Number(params.get("auth_date") || 0);
  if (maxAgeSeconds && authDate && Math.floor(Date.now() / 1000) - authDate > maxAgeSeconds) {
    throw new Error("telegram_auth_expired");
  }

  const user = JSON.parse(params.get("user") || "{}");
  if (!user.id) throw new Error("telegram_user_missing");
  return user;
}

async function ensureSchema(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS favorite_jobs (
      user_id TEXT NOT NULL,
      telegram_user_id INTEGER,
      short_id TEXT NOT NULL,
      source TEXT,
      source_url TEXT NOT NULL,
      title TEXT NOT NULL,
      company TEXT,
      location TEXT,
      format TEXT,
      salary TEXT,
      match_summary TEXT,
      reasons_json TEXT,
      risks_json TEXT,
      status TEXT NOT NULL DEFAULT 'saved',
      saved_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY (user_id, short_id)
    );
  `).run();
  await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_favorite_jobs_user_url ON favorite_jobs(user_id, source_url);").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_favorite_jobs_user_status ON favorite_jobs(user_id, status, updated_at);").run();
}

function normalizeSyncedJob(payload) {
  const job = payload.job || {};
  const user = payload.user || {};
  const now = new Date().toISOString();
  const userId = String(user.telegramUserId || user.id || user.telegramChatId || "");
  const shortId = String(job.shortId || "");
  if (!userId || !shortId || !job.title || !job.sourceUrl) return null;

  return {
    userId,
    telegramUserId: Number(user.telegramUserId || user.id || user.telegramChatId || 0) || null,
    shortId,
    source: job.source || null,
    sourceUrl: job.sourceUrl,
    title: job.title,
    company: job.company || "не указано",
    location: job.location || "не указано",
    format: job.format || "не указано",
    salary: job.salary || "Не указана",
    matchSummary: job.matchSummary || "",
    reasons: Array.isArray(job.reasons) ? job.reasons : [],
    risks: Array.isArray(job.risks) ? job.risks : [],
    status: ["saved", "applied", "archived"].includes(job.status) ? job.status : "saved",
    savedAt: job.savedAt || job.feedbackUpdatedAt || now,
    updatedAt: job.feedbackUpdatedAt || now,
    json: job,
  };
}

async function upsertFavorite(env, favorite) {
  await env.DB.prepare(`
    INSERT INTO favorite_jobs (
      user_id, telegram_user_id, short_id, source, source_url, title,
      company, location, format, salary, match_summary, reasons_json,
      risks_json, status, saved_at, updated_at, json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, short_id) DO UPDATE SET
      telegram_user_id=excluded.telegram_user_id,
      source=excluded.source,
      source_url=excluded.source_url,
      title=excluded.title,
      company=excluded.company,
      location=excluded.location,
      format=excluded.format,
      salary=excluded.salary,
      match_summary=excluded.match_summary,
      reasons_json=excluded.reasons_json,
      risks_json=excluded.risks_json,
      status=excluded.status,
      updated_at=excluded.updated_at,
      json=excluded.json
  `).bind(
    favorite.userId,
    favorite.telegramUserId,
    favorite.shortId,
    favorite.source,
    favorite.sourceUrl,
    favorite.title,
    favorite.company,
    favorite.location,
    favorite.format,
    favorite.salary,
    favorite.matchSummary,
    JSON.stringify(favorite.reasons),
    JSON.stringify(favorite.risks),
    favorite.status,
    favorite.savedAt,
    favorite.updatedAt,
    JSON.stringify(favorite.json)
  ).run();
}

async function handleBotSync(request, env) {
  if (!(await verifyBotSecret(request, env))) return json({ error: "unauthorized" }, { status: 401 });
  const payload = await request.json().catch(() => null);
  const favorite = normalizeSyncedJob(payload || {});
  if (!favorite) return json({ error: "invalid_payload" }, { status: 400 });
  await ensureSchema(env);
  await upsertFavorite(env, favorite);
  return json({ ok: true });
}

async function verifyBotSecret(request, env) {
  const expected = env.FAVORITES_API_SECRET;
  const received = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return Boolean(expected && received === expected);
}

async function handleDeleteUserFavorites(request, env, userId) {
  if (!(await verifyBotSecret(request, env))) return json({ error: "unauthorized" }, { status: 401 });
  await ensureSchema(env);
  await env.DB.prepare("DELETE FROM favorite_jobs WHERE user_id = ? OR telegram_user_id = ?").bind(String(userId), Number(userId) || 0).run();
  return json({ ok: true });
}

async function telegramUserFromRequest(request, env) {
  const initData = request.headers.get("x-telegram-init-data") || "";
  const maxAge = Number(env.WEBAPP_AUTH_MAX_AGE_SECONDS || 86400);
  return verifyTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN, maxAge);
}

function rowToJob(row) {
  return {
    shortId: row.short_id,
    source: row.source,
    sourceUrl: row.source_url,
    title: row.title,
    company: row.company,
    location: row.location,
    format: row.format,
    salary: row.salary,
    matchSummary: row.match_summary,
    reasons: JSON.parse(row.reasons_json || "[]"),
    risks: JSON.parse(row.risks_json || "[]"),
    status: row.status,
    savedAt: row.saved_at,
    updatedAt: row.updated_at,
    statusLabel: STATUS_LABELS[row.status] || row.status,
  };
}

async function handleGetFavorites(request, env) {
  const telegramUser = await telegramUserFromRequest(request, env);
  await ensureSchema(env);
  const userId = String(telegramUser.id);
  const rows = await env.DB.prepare(`
    SELECT * FROM favorite_jobs
    WHERE (user_id = ? OR telegram_user_id = ?) AND status != 'archived'
    ORDER BY updated_at DESC
    LIMIT 100
  `).bind(userId, telegramUser.id).all();
  return json({ jobs: (rows.results || []).map(rowToJob) });
}

async function handleUpdateStatus(request, env, shortId) {
  const telegramUser = await telegramUserFromRequest(request, env);
  const body = await request.json().catch(() => ({}));
  const status = body.status;
  if (!["saved", "applied", "archived"].includes(status)) return json({ error: "invalid_status" }, { status: 400 });
  await ensureSchema(env);
  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE favorite_jobs
    SET status = ?, updated_at = ?
    WHERE (user_id = ? OR telegram_user_id = ?) AND short_id = ?
  `).bind(status, now, String(telegramUser.id), telegramUser.id, shortId).run();
  return json({ ok: true, status });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/") return text(INDEX_HTML, "text/html; charset=utf-8");
      if (url.pathname === "/styles.css") return text(STYLES_CSS, "text/css; charset=utf-8");
      if (url.pathname === "/app.js") return text(APP_JS, "application/javascript; charset=utf-8");
      if (url.pathname === "/health") return json({ ok: true });
      if (url.pathname === "/api/bot/favorites" && request.method === "POST") return await handleBotSync(request, env);
      const deleteUserMatch = url.pathname.match(/^\/api\/bot\/users\/([^/]+)\/favorites$/);
      if (deleteUserMatch && request.method === "DELETE") {
        return await handleDeleteUserFavorites(request, env, decodeURIComponent(deleteUserMatch[1]));
      }
      if (url.pathname === "/api/favorites" && request.method === "GET") return await handleGetFavorites(request, env);
      const statusMatch = url.pathname.match(/^\/api\/favorites\/([^/]+)\/status$/);
      if (statusMatch && request.method === "POST") return await handleUpdateStatus(request, env, decodeURIComponent(statusMatch[1]));
      return json({ error: "not_found" }, { status: 404 });
    } catch (error) {
      const message = error.message || "server_error";
      return json({ error: message }, { status: message.startsWith("telegram_") ? 401 : 500 });
    }
  },
};
