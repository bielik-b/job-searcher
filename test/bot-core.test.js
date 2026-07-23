const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildJoobleQuery,
  dueDigestSlot,
  hasJobAlreadyBeenSent,
  jobMatchesHardPreferences,
  jobsAreLikelySame,
  normalizeJobCandidate,
  normalizeSearchProfile,
  rankCandidatesForUser,
  storeFoundJobs,
} = require("../src/jobMatching");

const {
  createSentJob,
  deleteFavoritesFromMiniApp,
  favoriteJobs,
  formatFavoriteMessage,
  formatSourceStatusMessage,
  formatVacancyMessage,
  guideText,
  parseRssItems,
  saveSourceReport,
  shouldSkipStaleUpdate,
  startKeyboard,
  syncFavoriteToMiniApp,
  telegramWebAppUrl,
  telegramText,
  updateFavoriteStatus,
} = require("../src/bot");

function activeUser(overrides = {}) {
  return {
    id: "user-1",
    telegramUserId: 1001,
    telegramChatId: 1001,
    searchProfile: {
      roles: ["Product Manager"],
      location: "remote",
      format: "Только remote",
      minSalary: { amount: 2500, currency: "USD", negotiable: false },
      languages: "English B2",
      mustHave: [],
      niceToHave: ["SaaS"],
      exclusions: [],
      hiddenCompanies: [],
      status: "active",
    },
    sentJobs: [],
    jobFeedback: [],
    foundJobs: [],
    learnedPreferences: {},
    digestSettings: {
      enabled: true,
      timezone: "Europe/Kiev",
      slots: ["09:00", "13:00", "21:00"],
      lastRunSlots: {},
    },
    ...overrides,
  };
}

test("normalizeSearchProfile marks empty profiles as draft and legacy filled profiles as active", () => {
  assert.equal(normalizeSearchProfile({}).status, "draft");

  const profile = normalizeSearchProfile({
    roles: ["Product Manager"],
    mustHave: "remote, SaaS",
    exclusions: "casino, MLM",
  });

  assert.equal(profile.status, "active");
  assert.deepEqual(profile.mustHave, ["remote", "SaaS"]);
  assert.deepEqual(profile.exclusions, ["casino", "MLM"]);
});

test("buildJoobleQuery keeps remote searches broad and only sends comparable UAH salary", () => {
  assert.equal(buildJoobleQuery({ roles: [] }), null);

  assert.deepEqual(
    buildJoobleQuery({
      roles: ["Product Manager", "AI Product Manager"],
      location: "global remote",
      minSalary: { amount: 3000, currency: "USD", negotiable: false },
    }),
    {
      keywords: "Product Manager, AI Product Manager",
      location: "Ukraine",
      radius: "80",
      page: "1",
      ResultOnPage: "20",
      companysearch: "false",
    }
  );

  assert.equal(
    buildJoobleQuery({
      roles: ["Sales Manager"],
      location: "Kyiv",
      minSalary: { amount: 80000, currency: "UAH", negotiable: false },
    }).salary,
    80000
  );
});

test("hard preferences exclude blocked terms, missing must-have terms, and hidden companies", () => {
  const profile = {
    mustHave: ["remote", "SaaS"],
    exclusions: ["casino"],
    hiddenCompanies: ["Bad Corp"],
  };

  assert.equal(
    jobMatchesHardPreferences(profile, {
      title: "Product Manager",
      company: "Good Corp",
      description: "Remote SaaS product role",
    }),
    true
  );

  assert.equal(
    jobMatchesHardPreferences(profile, {
      title: "Product Manager",
      company: "Good Corp",
      description: "Remote casino product role",
    }),
    false
  );

  assert.equal(
    jobMatchesHardPreferences(profile, {
      title: "Product Manager",
      company: "Bad Corp Ukraine",
      description: "Remote SaaS product role",
    }),
    false
  );

  assert.equal(
    jobMatchesHardPreferences(profile, {
      title: "Product Manager",
      company: "Good Corp",
      description: "Office marketplace product role",
    }),
    false
  );
});

test("rankCandidatesForUser prefers strong role, remote, salary, and nice-to-have matches", () => {
  const user = activeUser();
  const ranked = rankCandidatesForUser(user, [
    {
      source: "test",
      sourceUrl: "https://example.com/ops",
      title: "Operations Manager",
      company: "Ops Ltd",
      location: "Kyiv",
      format: "Office",
      salary: "$1800",
      description: "Office operations role",
    },
    {
      source: "test",
      sourceUrl: "https://example.com/product",
      title: "Product Manager",
      company: "SaaS Co",
      location: "Remote Ukraine",
      format: "Remote",
      salary: "$3000 - $4000",
      description: "Remote SaaS product role with English B2",
    },
  ]);

  assert.equal(ranked[0].sourceUrl, "https://example.com/product");
  assert.ok(ranked[0].score > ranked[1].score);
  assert.match(ranked[0].matchSummary, /совпадение/i);
  assert.ok(ranked[0].reasons.some((reason) => reason.includes("Название вакансии")));
});

test("storeFoundJobs normalizes, filters, deduplicates, and keeps source URLs", () => {
  const user = activeUser({
    searchProfile: {
      roles: ["Product Manager"],
      mustHave: ["remote"],
      exclusions: ["casino"],
      hiddenCompanies: [],
      status: "active",
    },
  });

  const stored = storeFoundJobs(user, [
    {
      source: "test",
      externalId: "1",
      sourceUrl: "https://example.com/1",
      title: "Product Manager",
      company: "SaaS Co",
      location: "Remote",
      description: "Remote B2B SaaS role",
      availability: "open",
      availabilityCheckedAt: "2026-07-23T09:00:00.000Z",
      availabilityReason: "detail_checked",
      enrichedAt: "2026-07-23T09:00:01.000Z",
      detailStatusCode: 200,
    },
    {
      source: "test",
      externalId: "2",
      sourceUrl: "https://example.com/2",
      title: "Product Manager",
      company: "Casino Co",
      location: "Remote",
      description: "Remote casino role",
    },
    {
      source: "test",
      externalId: "1",
      sourceUrl: "https://example.com/1",
      title: "Product Manager",
      company: "SaaS Co",
      location: "Remote",
      description: "Remote B2B SaaS role",
    },
  ]);

  assert.equal(stored.length, 1);
  assert.equal(user.foundJobs.length, 1);
  assert.equal(stored[0].sourceUrl, "https://example.com/1");
  assert.equal(stored[0].status, "found");
  assert.equal(stored[0].availability, "open");
  assert.equal(stored[0].availabilityCheckedAt, "2026-07-23T09:00:00.000Z");
  assert.equal(stored[0].availabilityReason, "detail_checked");
  assert.equal(stored[0].enrichedAt, "2026-07-23T09:00:01.000Z");
  assert.equal(stored[0].detailStatusCode, 200);
});

test("normalizeJobCandidate preserves availability metadata with safe defaults", () => {
  const normalized = normalizeJobCandidate({
    source: "happymonday",
    sourceUrl: "https://happymonday.ua/jobs/1",
    title: "Product Manager",
    company: "Happy Co",
    availability: "open",
    availabilityCheckedAt: "2026-07-23T09:00:00.000Z",
    availabilityReason: "detail_checked",
    enrichedAt: "2026-07-23T09:00:01.000Z",
    detailStatusCode: 200,
  });

  assert.equal(normalized.availability, "open");
  assert.equal(normalized.availabilityCheckedAt, "2026-07-23T09:00:00.000Z");
  assert.equal(normalized.availabilityReason, "detail_checked");
  assert.equal(normalized.enrichedAt, "2026-07-23T09:00:01.000Z");
  assert.equal(normalized.detailStatusCode, 200);

  const fallback = normalizeJobCandidate({
    sourceUrl: "https://example.com/job",
    title: "Product Manager",
    availability: "maybe",
    detailStatusCode: "200",
  });

  assert.equal(fallback.availability, "unknown");
  assert.equal(fallback.detailStatusCode, null);
});

test("createSentJob preserves availability metadata", () => {
  const user = activeUser();
  const sentJob = createSentJob(user, {
    source: "lobbyx",
    sourceUrl: "https://thelobbyx.com/tor/product-manager-to-active-co/",
    title: "Product Manager",
    company: "Active Co",
    availability: "open",
    availabilityCheckedAt: "2026-07-23T09:00:00.000Z",
    availabilityReason: "detail_checked",
    enrichedAt: "2026-07-23T09:00:01.000Z",
    detailStatusCode: 200,
  }, user.searchProfile);

  assert.equal(sentJob.availability, "open");
  assert.equal(sentJob.availabilityCheckedAt, "2026-07-23T09:00:00.000Z");
  assert.equal(sentJob.availabilityReason, "detail_checked");
  assert.equal(sentJob.enrichedAt, "2026-07-23T09:00:01.000Z");
  assert.equal(sentJob.detailStatusCode, 200);
  assert.equal(sentJob.status, "sent");
});

test("favorites helpers collect saved jobs and update local status", () => {
  const user = activeUser({
    foundJobs: [
      {
        shortId: "j_saved",
        sourceUrl: "https://jobs.test/1",
        title: "Product Manager",
        company: "SaaS Co",
        location: "Remote",
        format: "Remote",
        salary: "$3000",
        status: "saved",
        foundAt: "2026-07-23T08:00:00.000Z",
      },
    ],
    sentJobs: [
      {
        shortId: "j_saved",
        sourceUrl: "https://jobs.test/1",
        title: "Product Manager",
        company: "SaaS Co",
        location: "Remote",
        format: "Remote",
        salary: "$3000",
        status: "saved",
        feedbackUpdatedAt: "2026-07-23T09:00:00.000Z",
      },
      {
        shortId: "j_hidden",
        sourceUrl: "https://jobs.test/2",
        title: "Hidden Job",
        status: "hidden",
      },
    ],
  });

  const jobs = favoriteJobs(user);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].shortId, "j_saved");
  assert.match(formatFavoriteMessage(jobs[0]), /Источник: https:\/\/jobs\.test\/1/);

  const updated = updateFavoriteStatus(user, "j_saved", "applied");
  assert.equal(updated.status, "applied");
  assert.equal(user.sentJobs[0].status, "applied");
  assert.equal(user.foundJobs[0].status, "applied");
  assert.equal(Number.isNaN(Date.parse(updated.appliedAt)), false);
});

test("favorites web app button appears only when url is configured", () => {
  const previous = process.env.TELEGRAM_WEBAPP_URL;
  try {
    delete process.env.TELEGRAM_WEBAPP_URL;
    assert.equal(telegramWebAppUrl(), "");
    assert.equal(startKeyboard().flat().includes("Избранное"), true);
    assert.equal(startKeyboard().flat().includes("Инструкция"), true);

    process.env.TELEGRAM_WEBAPP_URL = "https://favorites.example/";
    const button = startKeyboard().flat().find((item) => typeof item === "object" && item.text === "Избранное");
    assert.deepEqual(button, {
      text: "Избранное",
      web_app: {
        url: "https://favorites.example/",
      },
    });
  } finally {
    if (previous === undefined) delete process.env.TELEGRAM_WEBAPP_URL;
    else process.env.TELEGRAM_WEBAPP_URL = previous;
  }
});

test("guide text explains onboarding without technical AI terms", () => {
  const text = guideText();

  assert.match(text, /Загрузи резюме/);
  assert.match(text, /черновик профиля поиска/);
  assert.match(text, /09:00, 13:00 и 21:00/);
  assert.match(text, /Избранное/);
  assert.doesNotMatch(text, /\b(?:LLM|Ollama|OpenAI|provider|model)\b/i);
});

test("stale telegram updates are skipped after bot restart", () => {
  const startedAt = 2000;

  assert.equal(shouldSkipStaleUpdate({ message: { date: 1999 } }, startedAt), true);
  assert.equal(shouldSkipStaleUpdate({ message: { date: 2000 } }, startedAt), false);
  assert.equal(shouldSkipStaleUpdate({ callback_query: { message: { date: 1998 } } }, startedAt), true);
  assert.equal(shouldSkipStaleUpdate({ update_id: 1 }, startedAt), false);
});

test("telegram text is capped below Telegram message limit", () => {
  const longText = "a".repeat(5000);
  const capped = telegramText(longText);

  assert.ok(capped.length <= 3900);
  assert.match(capped, /Текст сокращен/);
  assert.equal(telegramText("short"), "short");
});

test("favorites sync posts saved jobs to configured mini app api", async () => {
  const previousApiUrl = process.env.FAVORITES_API_URL;
  const previousSecret = process.env.FAVORITES_API_SECRET;
  const previousFetch = global.fetch;
  const calls = [];
  try {
    process.env.FAVORITES_API_URL = "https://favorites.example/";
    process.env.FAVORITES_API_SECRET = "secret";
    global.fetch = async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        async text() {
          return "";
        },
      };
    };

    const user = activeUser();
    const synced = await syncFavoriteToMiniApp(user, {
      shortId: "j_saved",
      sourceUrl: "https://jobs.test/1",
      title: "Product Manager",
      status: "saved",
    });

    assert.equal(synced, true);
    assert.equal(calls[0].url, "https://favorites.example/api/bot/favorites");
    assert.equal(calls[0].options.headers.authorization, "Bearer secret");
    const payload = JSON.parse(calls[0].options.body);
    assert.equal(payload.user.telegramUserId, 1001);
    assert.equal(payload.job.status, "saved");
  } finally {
    if (previousApiUrl === undefined) delete process.env.FAVORITES_API_URL;
    else process.env.FAVORITES_API_URL = previousApiUrl;
    if (previousSecret === undefined) delete process.env.FAVORITES_API_SECRET;
    else process.env.FAVORITES_API_SECRET = previousSecret;
    global.fetch = previousFetch;
  }
});

test("favorites delete requests mini app cleanup for a user", async () => {
  const previousApiUrl = process.env.FAVORITES_API_URL;
  const previousSecret = process.env.FAVORITES_API_SECRET;
  const previousFetch = global.fetch;
  const calls = [];
  try {
    process.env.FAVORITES_API_URL = "https://favorites.example";
    process.env.FAVORITES_API_SECRET = "secret";
    global.fetch = async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        async text() {
          return "";
        },
      };
    };

    const deleted = await deleteFavoritesFromMiniApp(activeUser({ id: "chat-1", telegramUserId: 1001 }));
    assert.equal(deleted, true);
    assert.equal(calls[0].url, "https://favorites.example/api/bot/users/1001/favorites");
    assert.equal(calls[0].options.method, "DELETE");
    assert.equal(calls[0].options.headers.authorization, "Bearer secret");
  } finally {
    if (previousApiUrl === undefined) delete process.env.FAVORITES_API_URL;
    else process.env.FAVORITES_API_URL = previousApiUrl;
    if (previousSecret === undefined) delete process.env.FAVORITES_API_SECRET;
    else process.env.FAVORITES_API_SECRET = previousSecret;
    global.fetch = previousFetch;
  }
});

test("storeFoundJobs deduplicates likely same jobs across different sources", () => {
  const user = activeUser({
    searchProfile: {
      roles: ["Product Manager"],
      mustHave: ["remote"],
      exclusions: [],
      hiddenCompanies: [],
      status: "active",
    },
  });

  const stored = storeFoundJobs(user, [
    {
      source: "workua",
      externalId: "work-1",
      sourceUrl: "https://www.work.ua/jobs/1/",
      title: "Product Manager",
      company: "SaaS Co Ukraine",
      location: "Remote",
      description: "Remote SaaS product role",
    },
    {
      source: "robotaua",
      externalId: "robota-1",
      sourceUrl: "https://robota.ua/company1/vacancy1",
      title: "Senior Product Manager",
      company: "SaaS Co",
      location: "Україна, віддалено",
      description: "Remote SaaS product role",
    },
    {
      source: "dou",
      externalId: "dou-1",
      sourceUrl: "https://jobs.dou.ua/1",
      title: "Product Owner",
      company: "SaaS Co",
      location: "Remote",
      description: "Remote SaaS product owner role",
    },
  ]);

  assert.equal(stored.length, 2);
  assert.deepEqual(stored.map((job) => job.title), ["Product Manager", "Product Owner"]);
  assert.equal(user.foundJobs.length, 2);
});

test("jobsAreLikelySame compares title and company without over-merging roles", () => {
  assert.equal(
    jobsAreLikelySame(
      {
        source: "workua",
        sourceUrl: "https://work.ua/jobs/1",
        title: "Product Manager",
        company: "SaaS Co Ukraine",
        location: "Remote",
      },
      {
        source: "robotaua",
        sourceUrl: "https://robota.ua/company1/vacancy1",
        title: "Senior Product Manager",
        company: "SaaS Co",
        location: "Україна, віддалено",
      }
    ),
    true
  );

  assert.equal(
    jobsAreLikelySame(
      {
        source: "workua",
        sourceUrl: "https://work.ua/jobs/2",
        title: "Product Manager",
        company: "SaaS Co",
        location: "Remote",
      },
      {
        source: "robotaua",
        sourceUrl: "https://robota.ua/company1/vacancy2",
        title: "Product Owner",
        company: "SaaS Co",
        location: "Remote",
      }
    ),
    false
  );
});

test("dedup avoids fuzzy matches when company is missing or different", () => {
  assert.equal(
    jobsAreLikelySame(
      {
        source: "workua",
        sourceUrl: "https://work.ua/jobs/3",
        title: "Product Manager",
        company: "не указано",
        location: "Remote",
      },
      {
        source: "robotaua",
        sourceUrl: "https://robota.ua/company2/vacancy3",
        title: "Senior Product Manager",
        company: "не указано",
        location: "Україна, віддалено",
      }
    ),
    false
  );

  assert.equal(
    jobsAreLikelySame(
      {
        source: "workua",
        sourceUrl: "https://work.ua/jobs/4",
        title: "Product Manager",
        company: "SaaS Co",
        location: "Remote",
      },
      {
        source: "robotaua",
        sourceUrl: "https://robota.ua/company3/vacancy4",
        title: "Product Manager",
        company: "Another Co",
        location: "Remote",
      }
    ),
    false
  );
});

test("hasJobAlreadyBeenSent skips likely same cross-source vacancy", () => {
  const user = activeUser({
    sentJobs: [
      {
        source: "workua",
        externalId: "work-5",
        sourceUrl: "https://www.work.ua/jobs/5/",
        title: "Product Manager",
        company: "SaaS Co Ukraine",
        location: "Remote",
      },
    ],
  });

  assert.equal(
    hasJobAlreadyBeenSent(user, {
      source: "robotaua",
      externalId: "robota-5",
      sourceUrl: "https://robota.ua/company5/vacancy5",
      title: "Senior Product Manager",
      company: "SaaS Co",
      location: "Україна, віддалено",
    }),
    true
  );
});

test("dueDigestSlot fires only once for each configured Kyiv slot", () => {
  const user = activeUser();
  const due = dueDigestSlot(user, new Date("2026-07-23T06:00:00.000Z"));

  assert.deepEqual(due, {
    slot: "09:00",
    slotKey: "2026-07-23 09:00",
    date: "2026-07-23",
  });

  user.digestSettings.lastRunSlots[due.slotKey] = "2026-07-23T06:00:00.000Z";
  assert.equal(dueDigestSlot(user, new Date("2026-07-23T06:00:00.000Z")), null);
  assert.equal(dueDigestSlot(activeUser(), new Date("2026-07-23T07:00:00.000Z")), null);
});

test("vacancy messages keep the original source link visible", () => {
  const user = activeUser();
  const candidate = normalizeJobCandidate({
    source: "test",
    sourceUrl: "https://example.com/vacancy",
    title: "Product Manager",
    company: "SaaS Co",
    location: "Remote",
    format: "Remote",
    salary: "$3000",
    description: "Remote SaaS role",
    matchSummary: "Сильное совпадение: роль похожа на product manager.",
  });

  const sentJob = createSentJob(user, candidate, user.searchProfile);
  const message = formatVacancyMessage(sentJob);

  assert.match(message, /Коротко: Сильное совпадение/);
  assert.match(message, /Источник: https:\/\/example\.com\/vacancy/);
  assert.doesNotMatch(message, /score|[0-9]+%/i);
});

test("vacancy messages handle old jobs without match summary cleanly", () => {
  const message = formatVacancyMessage({
    title: "Product Manager",
    company: "SaaS Co",
    location: "Remote",
    format: "Remote",
    salary: "$3000",
    reasons: ["Название вакансии хорошо совпадает с ролью из профиля."],
    risks: [],
    sourceUrl: "https://example.com/vacancy",
  });

  assert.doesNotMatch(message, /null|undefined|Коротко:/);
  assert.match(message, /Источник: https:\/\/example\.com\/vacancy/);
});

test("parseRssItems extracts RSS vacancy fields and strips html", () => {
  const items = parseRssItems(`
    <rss><channel><item>
      <title><![CDATA[Product Manager]]></title>
      <link>https://example.com/jobs/1</link>
      <description><![CDATA[Remote <b>SaaS</b> role &amp; team]]></description>
      <pubDate>Thu, 23 Jul 2026 09:00:00 +0300</pubDate>
      <guid>job-1</guid>
    </item></channel></rss>
  `);

  assert.deepEqual(items, [
    {
      title: "Product Manager",
      link: "https://example.com/jobs/1",
      description: "Remote SaaS role & team",
      pubDate: "Thu, 23 Jul 2026 09:00:00 +0300",
      guid: "job-1",
    },
  ]);
});

test("source status report is saved and formatted without technical errors", () => {
  const user = activeUser();
  saveSourceReport(user, {
    candidates: [{ title: "Product Manager" }],
    failures: ["djinni"],
    sourceReports: [
      {
        source: "jooble",
        status: "ok",
        count: 1,
        totalCount: 2,
        durationMs: 12,
        checkedAt: "2026-07-23T09:00:00.000Z",
      },
      {
        source: "djinni",
        status: "failed",
        count: 0,
        totalCount: 0,
        error: "Cloudflare challenge raw error that should not be shown",
        durationMs: 7,
        checkedAt: "2026-07-23T09:00:00.000Z",
      },
    ],
  });

  const message = formatSourceStatusMessage(user);

  assert.match(message, /Jooble: работает, найдено 1 из 2/);
  assert.match(message, /Djinni: временно недоступен/);
  assert.doesNotMatch(message, /Cloudflare challenge/);
  assert.equal(user.lastSourceReport.reports[1].error, undefined);
});
