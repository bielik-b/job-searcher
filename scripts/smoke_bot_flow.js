const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const storage = require("../src/storage");
const {
  handleCallbackQuery,
  handleMessage,
  setTelegramTransportForTests,
} = require("../src/bot");

const CHAT_ID = 424242;
const USER_ID = 101010;

function userMessage(text) {
  return {
    message_id: Math.floor(Math.random() * 100000),
    date: Math.floor(Date.now() / 1000),
    chat: { id: CHAT_ID, type: "private" },
    from: {
      id: USER_ID,
      username: "smoke_user",
      language_code: "ru",
    },
    text,
  };
}

function callbackQuery(data, messageId = 9001) {
  return {
    id: `callback_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    from: {
      id: USER_ID,
      username: "smoke_user",
      language_code: "ru",
    },
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT_ID, type: "private" },
    },
    data,
  };
}

function activeSmokeUser(user) {
  return {
    ...user,
    searchProfile: {
      roles: ["Product Manager"],
      location: "Remote",
      format: "Remote",
      minSalary: { raw: "$2500", amount: 2500, currency: "USD", negotiable: false },
      languages: "English B2",
      mustHave: [],
      niceToHave: ["SaaS"],
      exclusions: [],
      hiddenCompanies: [],
      status: "active",
    },
    foundJobs: [
      {
        shortId: "smoke_found_1",
        source: "smoke",
        sourceUrl: "https://example.test/jobs/product-manager",
        title: "Product Manager",
        company: "Acme",
        location: "Remote",
        format: "Remote",
        salary: "$3000",
        description: "Remote SaaS product role with English B2.",
        reasons: ["Название вакансии совпадает с ролью."],
        risks: ["Проверь детали в источнике."],
        score: 88,
        status: "found",
        foundAt: new Date().toISOString(),
      },
    ],
  };
}

function outgoingTexts(calls) {
  return calls
    .filter((call) => call.method === "sendMessage")
    .map((call) => String(call.payload.text || ""));
}

async function main() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "job-searcher-smoke-"));
  const previousSqlitePath = process.env.SQLITE_PATH;
  const previousFavoritesApiUrl = process.env.FAVORITES_API_URL;
  const previousFavoritesSecret = process.env.FAVORITES_API_SECRET;
  const previousTelegramWebAppUrl = process.env.TELEGRAM_WEBAPP_URL;

  const calls = [];
  let nextMessageId = 1;

  process.env.SQLITE_PATH = path.join(tmpDir, "job-searcher-smoke.sqlite");
  delete process.env.FAVORITES_API_URL;
  delete process.env.FAVORITES_API_SECRET;
  process.env.TELEGRAM_WEBAPP_URL = "https://favorites.example.test/";

  setTelegramTransportForTests(async (method, payload) => {
    calls.push({ method, payload });
    if (method === "sendMessage") return { message_id: nextMessageId++ };
    if (method === "answerCallbackQuery") return true;
    if (method === "deleteMessage") return true;
    if (method === "editMessageText") return true;
    return {};
  });

  await storage.initializeStorage({
    dataDir: tmpDir,
    usersJsonPath: path.join(tmpDir, "users.json"),
    stateJsonPath: path.join(tmpDir, "bot-state.json"),
  });

  try {
    await handleMessage(userMessage("/start"));
    let texts = outgoingTexts(calls);
    assert.ok(texts.some((text) => text.includes("С чего начать:")), "first /start should show onboarding guide");
    assert.ok(texts.some((text) => text.includes("Что делают кнопки:")), "first /start should explain menu buttons");
    assert.ok(texts.some((text) => text.includes("Главное меню")), "/start should show main menu");

    calls.length = 0;
    await handleMessage(userMessage("/guide"));
    texts = outgoingTexts(calls);
    assert.ok(texts.some((text) => text.includes("С чего начать:")), "/guide should show guide");

    const user = activeSmokeUser(await storage.getUser(String(CHAT_ID)));
    await storage.saveUser(user);

    calls.length = 0;
    await handleMessage(userMessage("Мои вакансии"));
    texts = outgoingTexts(calls);
    assert.equal(
      texts.filter((text) => text === "Вот вакансии, которые я уже нашел для тебя.").length,
      1,
      "found jobs header should be sent once"
    );
    assert.ok(texts.some((text) => text.includes("Product Manager")), "found jobs should include vacancy details");
    assert.ok(texts.some((text) => text.includes("Источник: https://example.test/jobs/product-manager")), "vacancy should include source link");

    const afterFoundJobs = await storage.getUser(String(CHAT_ID));
    const sentJob = afterFoundJobs.sentJobs.find((job) => job.title === "Product Manager");
    assert.ok(sentJob?.shortId, "show found jobs should store sent job");

    calls.length = 0;
    await handleCallbackQuery(callbackQuery(`j:s:${sentJob.shortId}`, sentJob.messageId));
    const savedUser = await storage.getUser(String(CHAT_ID));
    const savedJob = savedUser.sentJobs.find((job) => job.shortId === sentJob.shortId);
    assert.equal(savedJob.status, "saved", "save feedback should mark job as saved");
    assert.ok(calls.some((call) => call.method === "answerCallbackQuery"), "save feedback should answer callback");

    calls.length = 0;
    await handleMessage(userMessage("Избранное"));
    texts = outgoingTexts(calls);
    assert.ok(texts.some((text) => text.includes("Открой отдельное окно")), "favorites button should open Mini App prompt");

    calls.length = 0;
    await handleCallbackQuery(callbackQuery(`fav:a:${sentJob.shortId}`, sentJob.messageId));
    const appliedUser = await storage.getUser(String(CHAT_ID));
    assert.equal(
      appliedUser.sentJobs.find((job) => job.shortId === sentJob.shortId).status,
      "applied",
      "favorite applied callback should update status"
    );
    assert.ok(calls.some((call) => call.method === "editMessageText"), "applied callback should edit message");

    calls.length = 0;
    await handleCallbackQuery(callbackQuery(`fav:r:${sentJob.shortId}`, sentJob.messageId));
    const archivedUser = await storage.getUser(String(CHAT_ID));
    assert.equal(
      archivedUser.sentJobs.find((job) => job.shortId === sentJob.shortId).status,
      "archived",
      "favorite remove callback should archive job"
    );
    assert.ok(calls.some((call) => call.method === "deleteMessage"), "remove callback should hide message");

    console.log("Smoke bot flow passed");
  } finally {
    setTelegramTransportForTests(null);
    storage.closeStorage();
    if (previousSqlitePath === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = previousSqlitePath;
    if (previousFavoritesApiUrl === undefined) delete process.env.FAVORITES_API_URL;
    else process.env.FAVORITES_API_URL = previousFavoritesApiUrl;
    if (previousFavoritesSecret === undefined) delete process.env.FAVORITES_API_SECRET;
    else process.env.FAVORITES_API_SECRET = previousFavoritesSecret;
    if (previousTelegramWebAppUrl === undefined) delete process.env.TELEGRAM_WEBAPP_URL;
    else process.env.TELEGRAM_WEBAPP_URL = previousTelegramWebAppUrl;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
