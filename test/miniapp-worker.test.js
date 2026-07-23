const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

async function loadWorker() {
  return (await import("../miniapp/worker.js")).default;
}

function signedInitData(botToken, user, overrides = {}) {
  const params = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "test-query",
    user: JSON.stringify(user),
    ...overrides,
  };
  const dataCheckString = Object.entries(params)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  return new URLSearchParams({ ...params, hash }).toString();
}

function createFakeDb(rows = []) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const call = { sql, bindings: [] };
      calls.push(call);
      return {
        bind(...bindings) {
          call.bindings = bindings;
          return this;
        },
        async run() {
          call.ran = true;
          return { success: true };
        },
        async all() {
          call.all = true;
          return { results: rows };
        },
      };
    },
  };
}

test("miniapp worker returns health response", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(new Request("https://example.test/health"), {});

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("miniapp worker rejects favorites API without telegram initData as JSON 401", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(new Request("https://example.test/api/favorites"), {
    TELEGRAM_BOT_TOKEN: "test-token",
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "telegram_auth_missing" });
});

test("miniapp worker rejects bot sync without shared secret as JSON 401", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(new Request("https://example.test/api/bot/favorites", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  }), {
    FAVORITES_API_SECRET: "expected-secret",
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "unauthorized" });
});

test("miniapp worker accepts valid telegram initData and reads favorites by telegram user id", async () => {
  const worker = await loadWorker();
  const db = createFakeDb([
    {
      short_id: "job_1",
      source: "test",
      source_url: "https://example.test/job",
      title: "Product Manager",
      company: "Acme",
      location: "Remote",
      format: "Remote",
      salary: "$3000",
      match_summary: "Хорошее совпадение",
      reasons_json: "[]",
      risks_json: "[]",
      status: "saved",
      saved_at: "2026-07-23T09:00:00.000Z",
      updated_at: "2026-07-23T09:00:00.000Z",
    },
  ]);
  const initData = signedInitData("test-token", { id: 1001, first_name: "Test" });

  const response = await worker.fetch(new Request("https://example.test/api/favorites", {
    headers: { "x-telegram-init-data": initData },
  }), {
    DB: db,
    TELEGRAM_BOT_TOKEN: "test-token",
    WEBAPP_AUTH_MAX_AGE_SECONDS: "86400",
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).jobs[0].shortId, "job_1");
  const selectCall = db.calls.find((call) => call.sql.includes("SELECT * FROM favorite_jobs"));
  assert.deepEqual(selectCall.bindings, ["1001", 1001]);
});

test("miniapp worker stores bot-synced favorites under telegram user id", async () => {
  const worker = await loadWorker();
  const db = createFakeDb();

  const response = await worker.fetch(new Request("https://example.test/api/bot/favorites", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer expected-secret",
    },
    body: JSON.stringify({
      user: {
        id: "chat-1",
        telegramChatId: "chat-1",
        telegramUserId: 1001,
      },
      job: {
        shortId: "job_1",
        sourceUrl: "https://example.test/job",
        title: "Product Manager",
      },
    }),
  }), {
    DB: db,
    FAVORITES_API_SECRET: "expected-secret",
  });

  assert.equal(response.status, 200);
  const insertCall = db.calls.find((call) => call.sql.includes("INSERT INTO favorite_jobs"));
  assert.equal(insertCall.bindings[0], "1001");
  assert.equal(insertCall.bindings[1], 1001);
});
