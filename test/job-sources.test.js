const assert = require("node:assert/strict");
const test = require("node:test");

const { parseRssItems } = require("../src/bot");
const { createJobSources } = require("../src/jobSources");

function response(ok, status, body) {
  return {
    ok,
    status,
    async text() {
      return body;
    },
  };
}

function createTestSources(fetchImpl, logger = { error() {} }) {
  return createJobSources({
    buildJoobleQuery(profile = {}) {
      return profile.roles?.length ? { keywords: profile.roles.join(", "), location: "Ukraine" } : null;
    },
    inferWorkFormat(job = {}) {
      const text = `${job.title || ""} ${job.location || ""} ${job.snippet || ""} ${job.description || ""}`;
      return /remote|віддал|удален/i.test(text) ? "Remote" : "не указано";
    },
    jobContainsExcludedTerm(job, exclusions) {
      const text = `${job.title || ""} ${job.company || ""} ${job.description || ""}`.toLowerCase();
      return exclusions.some((term) => text.includes(String(term).toLowerCase()));
    },
    joobleJobToCandidate(job) {
      if (!job.title || !job.link) return null;
      return {
        source: "jooble",
        externalId: String(job.id || job.link),
        sourceUrl: job.link,
        title: job.title,
        company: job.company || "не указано",
        location: job.location || "не указано",
        format: "Remote",
        salary: job.salary || "Не указана",
        description: job.snippet || "",
        reasons: [],
        risks: [],
      };
    },
    parseRssItems,
    profileBlockedTerms(profile = {}) {
      return [...(profile.exclusions || []), ...(profile.hiddenCompanies || [])];
    },
    profileMatchesCandidate(profile = {}, candidate = {}) {
      const text = `${candidate.title || ""} ${candidate.description || ""}`.toLowerCase();
      return profile.roles.some((role) => text.includes(role.toLowerCase()));
    },
    fetchImpl,
    env: {
      JOOBLE_API_KEY: "test-key",
      JOOBLE_BASE_URL: "https://jooble.test/api",
      DOU_FEED_URL: "https://dou.test/rss",
      DJINNI_FEED_URL: "https://djinni.test/rss",
      WORK_UA_BASE_URL: "https://www.work.ua",
      ROBOTA_UA_BASE_URL: "https://robota.ua",
      JOBS_UA_BASE_URL: "https://jobs.ua",
      OLX_UA_BASE_URL: "https://www.olx.ua",
      HAPPY_MONDAY_BASE_URL: "https://happymonday.ua",
      LOBBYX_BASE_URL: "https://thelobbyx.com",
      JOOBLE_TIMEOUT_MS: "1000",
      DOU_TIMEOUT_MS: "1000",
      DJINNI_TIMEOUT_MS: "1000",
      WORK_UA_TIMEOUT_MS: "1000",
      ROBOTA_UA_TIMEOUT_MS: "1000",
      JOBS_UA_TIMEOUT_MS: "1000",
      OLX_UA_TIMEOUT_MS: "1000",
      HAPPY_MONDAY_TIMEOUT_MS: "1000",
      LOBBYX_TIMEOUT_MS: "1000",
    },
    logger,
  });
}

test("job sources merge successful adapters and isolate a failing source", async () => {
  const seenUrls = [];
  const loggerMessages = [];
  const sources = createTestSources(async (url) => {
    seenUrls.push(String(url));

    if (String(url).startsWith("https://jooble.test/api/")) {
      return response(true, 200, JSON.stringify({
        totalCount: 2,
        jobs: [
          {
            id: 1,
            title: "Product Manager",
            company: "SaaS Co",
            link: "https://jooble.test/jobs/1",
            location: "Remote",
            snippet: "Remote SaaS product role",
          },
          {
            id: 2,
            title: "Product Manager",
            company: "Casino Co",
            link: "https://jooble.test/jobs/2",
            location: "Remote",
            snippet: "Remote casino role",
          },
        ],
      }));
    }

    if (url === "https://dou.test/rss") {
      return response(true, 200, `
        <rss><channel><item>
          <title>Product Manager at DOU Co, Remote</title>
          <link>https://dou.test/jobs/1</link>
          <description>Remote SaaS product manager role</description>
          <guid>dou-1</guid>
        </item></channel></rss>
      `);
    }

    if (url === "https://www.work.ua/jobs-product-manager/") {
      return response(true, 200, `
        <main>
          <div id="job-111" class="card">
            <h2><a href="/jobs/111/">Product Manager</a></h2>
            <div><a href="/jobs/by-company/123/">Work Co</a></div>
            <span class="text-muted">Remote</span>
            <span class="salary">80 000 грн</span>
            <p>Remote SaaS product manager role</p>
          </div>
        </main>
      `);
    }

    if (url === "https://robota.ua/zapros/product-manager/ukraine") {
      return response(true, 200, `
        <main>
          <article>
            <a href="/company1590638/vacancy11023459">
              <h2>Product Manager</h2>
              <span class="company">Robota Co</span>
              <span class="city">Remote</span>
              <p>Remote SaaS product manager role</p>
            </a>
          </article>
        </main>
      `);
    }

    if (url === "https://jobs.ua/vacancy/rabota-product-manager") {
      return response(true, 200, `
        <ul class="b-vacancy__list js-items_block">
          <li class="b-vacancy__item js-item_list" id="3851891">
            <h3><a class="b-vacancy__top__title js-item_title" href="https://jobs.ua/job-online-product-listing-manager-3851891">Online Product Listing Manager</a></h3>
            <div class="b-vacancy__tech">
              <span class="b-vacancy__tech__item"><span class="link__hidden" title="Sundico Inc">Sundico Inc</span></span>
              <span class="b-vacancy__tech__item">&nbsp;<i class="fa fa-map-marker"></i>&nbsp;<a class="link__hidden" href="https://jobs.ua/city/kiev_jobs">Київ</a></span>
            </div>
            <span class="b-vacancy__tech__item"><span class="caption">Графік роботи:</span>&nbsp;<span class="black-text">віддалена робота</span></span>
            <div class="grey-light b-text"><p>Remote product manager role for online catalog operations.</p></div>
          </li>
        </ul>
      `);
    }

    if (url === "https://www.olx.ua/uk/rabota/q-product-manager/") {
      return response(true, 200, `
        <main data-testid="listing-grid">
          <div data-testid="l-card" data-cy="l-card">
            <a data-testid="card-title-link" href="/uk/obyavlenie/rabota/product-manager-IDSaaS1.html?search_reason=search%7Corganic">
              <h4 data-testid="ad-card-title">Product Manager</h4>
            </a>
            <p data-testid="ad-price">60 000 грн.</p>
            <p data-testid="location-date">Київ - Сьогодні о 09:00</p>
            <p>Remote SaaS product manager role.</p>
          </div>
          <div data-testid="l-card" data-cy="l-card">
            <a data-testid="card-title-link" href="/d/uk/obyavlenie/kniga-manager-IDNoise.html?reason=extended_search_extended_category&amp;search_reason=search%7Corganic">
              <h4 data-testid="ad-card-title">The Manager Path book</h4>
            </a>
            <p data-testid="ad-price">450 грн.</p>
            <p data-testid="location-date">Київ - Сьогодні о 10:00</p>
          </div>
        </main>
      `);
    }

    if (url === "https://happymonday.ua/wp-json/wp/v2/search?search=Product%20Manager&subtype=job&per_page=10") {
      return response(true, 200, JSON.stringify([
        {
          id: 1913552,
          title: "Product Manager до Happy Co",
          url: "https://happymonday.ua/jobs/1913552",
          subtype: "job",
        },
        {
          id: 1913553,
          title: "Video Producer до Media Co",
          url: "https://happymonday.ua/jobs/1913553",
          subtype: "job",
        },
      ]));
    }

    if (url === "https://happymonday.ua/wp-json/wp/v2/job/1913552") {
      return response(true, 200, JSON.stringify({
        id: 1913552,
        title: { rendered: "Product Manager до Happy Co" },
        content: { rendered: "<p>Remote SaaS product manager role.</p><p>Location: Kyiv, Ukraine</p><p>$3000</p>" },
      }));
    }

    if (url === "https://thelobbyx.com/wp-json/wp/v2/search?search=Product%20Manager&subtype=tors&per_page=10") {
      return response(true, 200, JSON.stringify([
        {
          id: 84032,
          title: "Product Manager [Product Office]",
          url: "https://thelobbyx.com/tor/product-manager-product-office-to-vyriy/",
          subtype: "tors",
        },
      ]));
    }

    if (url === "https://thelobbyx.com/wp-json/wp/v2/tors/84032") {
      return response(true, 200, JSON.stringify({
        id: 84032,
        title: { rendered: "Product Manager [Product Office]" },
        content: { rendered: "<p>Remote product platform role for UAV software.</p>" },
        yoast_head_json: {
          og_description: "Remote product manager role in Ukraine.",
        },
      }));
    }

    return response(false, 500, "boom");
  }, {
    error(message) {
      loggerMessages.push(message);
    },
  });

  const result = await sources.fetchCandidatesFromSources({
    roles: ["Product Manager"],
    exclusions: ["casino"],
    hiddenCompanies: [],
  });

  assert.deepEqual(seenUrls, [
    "https://jooble.test/api/test-key",
    "https://dou.test/rss",
    "https://djinni.test/rss",
    "https://www.work.ua/jobs-product-manager/",
    "https://robota.ua/zapros/product-manager/ukraine",
    "https://jobs.ua/vacancy/rabota-product-manager",
    "https://www.olx.ua/uk/rabota/q-product-manager/",
    "https://happymonday.ua/wp-json/wp/v2/search?search=Product%20Manager&subtype=job&per_page=10",
    "https://happymonday.ua/wp-json/wp/v2/job/1913552",
    "https://thelobbyx.com/wp-json/wp/v2/search?search=Product%20Manager&subtype=tors&per_page=10",
    "https://thelobbyx.com/wp-json/wp/v2/tors/84032",
  ]);
  assert.deepEqual(result.failures, ["djinni"]);
  assert.equal(result.needsProfile, false);
  assert.deepEqual(result.candidates.map((job) => job.source), ["jooble", "dou", "workua", "robotaua", "jobsua", "olxua", "happymonday", "lobbyx"]);
  assert.equal(result.candidates.every((job) => job.sourceUrl), true);
  assert.equal(result.candidates.find((job) => job.source === "jobsua").format, "Remote");
  const olxUaCandidate = result.candidates.find((job) => job.source === "olxua");
  assert.equal(olxUaCandidate.sourceUrl, "https://www.olx.ua/uk/obyavlenie/rabota/product-manager-IDSaaS1.html");
  assert.equal(olxUaCandidate.location, "Київ");
  assert.equal(olxUaCandidate.salary, "60 000 грн.");
  const happyMondayCandidate = result.candidates.find((job) => job.source === "happymonday");
  const lobbyXCandidate = result.candidates.find((job) => job.source === "lobbyx");
  assert.equal(happyMondayCandidate.salary, "$3000");
  assert.equal(happyMondayCandidate.availability, "open");
  assert.equal(happyMondayCandidate.availabilityReason, "detail_checked");
  assert.equal(happyMondayCandidate.detailStatusCode, 200);
  assert.equal(Number.isNaN(Date.parse(happyMondayCandidate.availabilityCheckedAt)), false);
  assert.match(lobbyXCandidate.description, /UAV software/i);
  assert.equal(lobbyXCandidate.availability, "open");
  assert.equal(lobbyXCandidate.availabilityReason, "detail_checked");
  assert.equal(lobbyXCandidate.detailStatusCode, 200);
  assert.equal(loggerMessages.length, 1);
  assert.deepEqual(
    result.sourceReports.map((report) => [report.source, report.status, report.count]),
    [
      ["jooble", "ok", 1],
      ["dou", "ok", 1],
      ["djinni", "failed", 0],
      ["workua", "ok", 1],
      ["robotaua", "ok", 1],
      ["jobsua", "ok", 1],
      ["olxua", "ok", 1],
      ["happymonday", "ok", 1],
      ["lobbyx", "ok", 1],
    ]
  );
  assert.equal(result.sourceReports.every((report) => Number.isFinite(report.durationMs)), true);
  assert.equal(result.sourceReports.find((report) => report.source === "djinni").errorCode, "http_error");
  assert.deepEqual(result.summary, {
    checkedAt: result.summary.checkedAt,
    okSources: 8,
    failedSources: 1,
    totalCandidates: 8,
  });
});

test("workua parser extracts candidates from public search html", () => {
  const sources = createTestSources(async () => response(true, 200, ""));
  const jobs = sources.parseWorkUaHtml(`
    <main>
      <div id="job-42">
        <h2><a href="/jobs/42/">AI Product Manager</a></h2>
        <p><a href="/jobs/by-company/55/">Product Lab</a></p>
        <span class="text-muted">Kyiv, Remote</span>
        <p>Build AI SaaS products for B2B teams.</p>
      </div>
    </main>
  `);

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, "42");
  assert.equal(jobs[0].title, "AI Product Manager");
  assert.equal(jobs[0].company, "Product Lab");
  assert.equal(jobs[0].sourceUrl, "https://www.work.ua/jobs/42/");
});

test("robotaua parser extracts candidates from public search html", () => {
  const sources = createTestSources(async () => response(true, 200, ""));
  const jobs = sources.parseRobotaUaHtml(`
    <main>
      <article>
        <a href="/company1590638/vacancy11023459">
          <h2>Віддалена робота AI Product Manager</h2>
          <span class="company">Robota Lab</span>
          <span class="city">Київ (віддалено)</span>
          <p>Build AI SaaS products for B2B teams.</p>
        </a>
      </article>
    </main>
  `);

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, "11023459");
  assert.equal(jobs[0].title, "AI Product Manager");
  assert.equal(jobs[0].company, "Robota Lab");
  assert.equal(jobs[0].sourceUrl, "https://robota.ua/company1590638/vacancy11023459");
});

test("robotaua parser skips promo links and duplicate vacancies", () => {
  const sources = createTestSources(async () => response(true, 200, ""));
  const jobs = sources.parseRobotaUaHtml(`
    <main>
      <a href="https://t.me/example">Вакансії України</a>
      <a href="/company1/vacancy77"><h2>Product Manager</h2><p>Remote product role</p></a>
      <a href="/company1/vacancy77"><h2>Product Manager Duplicate</h2></a>
    </main>
  `);

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, "77");
  assert.equal(jobs[0].title, "Product Manager");
});

test("jobsua parser extracts candidates from public search html", () => {
  const sources = createTestSources(async () => response(true, 200, ""));
  const jobs = sources.parseJobsUaHtml(`
    <ul class="b-vacancy__list js-items_block">
      <li class="b-vacancy__item js-item_list" id="3852247">
        <h3>
          <a class="b-vacancy__top__title js-item_title" href="/job-digital-product-marketing-manager-3852247">
            Digital, Product Marketing Manager
          </a>
          <span class="b-vacancy__top__pay">50 000&nbsp;<i title="гривен">грн.</i>&nbsp;+&nbsp;%</span>
        </h3>
        <div class="b-vacancy__tech">
          <span class="b-vacancy__tech__item"><span class="link__hidden" title="Gerchik Trading Ecosystem">Gerchik Trading Ecosystem</span></span>
          <span class="b-vacancy__tech__item"><i class="fa fa-map-marker"></i><a class="link__hidden" href="/city/kiev_jobs">Київ</a></span>
        </div>
        <span class="b-vacancy__tech__item"><span class="caption">Графік роботи:</span>&nbsp;<span class="black-text">повний робочий день</span></span>
        <div class="grey-light b-text"><p>Product marketing role for fintech products.</p></div>
      </li>
    </ul>
  `);

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, "3852247");
  assert.equal(jobs[0].title, "Digital, Product Marketing Manager");
  assert.equal(jobs[0].company, "Gerchik Trading Ecosystem");
  assert.equal(jobs[0].location, "Київ");
  assert.equal(jobs[0].salary, "50 000 грн. + %");
  assert.equal(jobs[0].sourceUrl, "https://jobs.ua/job-digital-product-marketing-manager-3852247");
});

test("olxua parser extracts job cards and skips extended search ads", () => {
  const sources = createTestSources(async () => response(true, 200, ""));
  const jobs = sources.parseOlxUaHtml(`
    <main data-testid="listing-grid">
      <div data-testid="l-card" data-cy="l-card">
        <a data-testid="card-title-link" href="/uk/obyavlenie/rabota/ai-product-manager-IDabc123.html?search_reason=search%7Corganic">
          <h4 data-testid="ad-card-title">AI Product Manager</h4>
        </a>
        <p data-testid="ad-price">80 000 грн.</p>
        <p data-testid="location-date">Львів - Вчора о 18:00</p>
        <p>Remote AI product role for B2B teams.</p>
      </div>
      <div data-testid="l-card" data-cy="l-card">
        <a data-testid="card-title-link" href="/d/uk/obyavlenie/product-book-IDnoise.html?reason=extended_search_extended_category&amp;search_reason=search%7Corganic">
          <h4 data-testid="ad-card-title">Product management book</h4>
        </a>
      </div>
      <div data-testid="l-card" data-cy="l-card">
        <a href="/uk/list/user/2fUlqG/">OLX shop</a>
      </div>
    </main>
  `);

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, "abc123");
  assert.equal(jobs[0].title, "AI Product Manager");
  assert.equal(jobs[0].location, "Львів");
  assert.equal(jobs[0].salary, "80 000 грн.");
  assert.equal(jobs[0].sourceUrl, "https://www.olx.ua/uk/obyavlenie/rabota/ai-product-manager-IDabc123.html");
});

test("happy monday mapper converts WordPress search results to candidates", () => {
  const sources = createTestSources(async () => response(true, 200, ""));
  const job = sources.happyMondayItemToCandidate({
    id: 1913552,
    title: "Product Marketing Lead до Futurra Group",
    url: "https://happymonday.ua/jobs/1913552",
    subtype: "job",
  });

  assert.equal(job.source, "happymonday");
  assert.equal(job.externalId, "1913552");
  assert.equal(job.title, "Product Marketing Lead");
  assert.equal(job.company, "Futurra Group");
  assert.equal(job.sourceUrl, "https://happymonday.ua/jobs/1913552");
  assert.equal(job.availability, "unknown");
  assert.equal(job.availabilityReason, "search_result_only");
});

test("lobby x mapper converts WordPress search results to candidates", () => {
  const sources = createTestSources(async () => response(true, 200, ""));
  const job = sources.lobbyXItemToCandidate({
    id: 84032,
    title: "Product Manager [Product Office]",
    url: "https://thelobbyx.com/tor/product-manager-product-office-to-vyriy/",
    subtype: "tors",
  });

  assert.equal(job.source, "lobbyx");
  assert.equal(job.externalId, "84032");
  assert.equal(job.title, "Product Manager [Product Office]");
  assert.equal(job.company, "Vyriy");
  assert.equal(job.sourceUrl, "https://thelobbyx.com/tor/product-manager-product-office-to-vyriy/");
  assert.equal(job.availability, "unknown");
  assert.equal(job.availabilityReason, "search_result_only");
});

test("wordpress source adapters ignore wrong subtypes and incomplete items", async () => {
  const sources = createTestSources(async (url) => {
    if (url === "https://happymonday.ua/wp-json/wp/v2/search?search=Product%20Manager&subtype=job&per_page=10") {
      return response(true, 200, JSON.stringify([
        {
          id: 1,
          title: "Product Manager до Wrong Type",
          url: "https://happymonday.ua/not-a-job/1",
          subtype: "post",
        },
        {
          id: 2,
          title: "Product Manager до Missing Url",
          subtype: "job",
        },
        {
          id: 3,
          title: "Product Manager до Happy Co",
          url: "https://happymonday.ua/jobs/3",
          subtype: "job",
        },
      ]));
    }

    if (url === "https://thelobbyx.com/wp-json/wp/v2/search?search=Product%20Manager&subtype=tors&per_page=10") {
      return response(true, 200, JSON.stringify([
        {
          id: 4,
          title: "Product Manager",
          url: "https://thelobbyx.com/tor/product-manager-to-wrong-type/",
          subtype: "job",
        },
        {
          id: 5,
          url: "https://thelobbyx.com/tor/product-manager-to-missing-title/",
          subtype: "tors",
        },
        {
          id: 6,
          title: "Product Manager",
          url: "https://thelobbyx.com/tor/product-manager-to-vyriy/",
          subtype: "tors",
        },
      ]));
    }

    return response(false, 500, "unexpected");
  });

  const profile = {
    roles: ["Product Manager"],
    exclusions: [],
    hiddenCompanies: [],
  };

  const happyMondayResult = await sources.fetchHappyMondayCandidates(profile);
  const lobbyXResult = await sources.fetchLobbyXCandidates(profile);

  assert.deepEqual(happyMondayResult.candidates.map((job) => job.sourceUrl), ["https://happymonday.ua/jobs/3"]);
  assert.deepEqual(lobbyXResult.candidates.map((job) => job.sourceUrl), ["https://thelobbyx.com/tor/product-manager-to-vyriy/"]);
});

test("happy monday detail validation skips closed vacancies", async () => {
  const sources = createTestSources(async (url) => {
    if (url === "https://happymonday.ua/wp-json/wp/v2/search?search=Product%20Manager&subtype=job&per_page=10") {
      return response(true, 200, JSON.stringify([
        {
          id: 10,
          title: "Product Manager до Closed Co",
          url: "https://happymonday.ua/jobs/10",
          subtype: "job",
        },
        {
          id: 11,
          title: "Product Manager до Active Co",
          url: "https://happymonday.ua/jobs/11",
          subtype: "job",
        },
      ]));
    }

    if (url === "https://happymonday.ua/wp-json/wp/v2/job/10") {
      return response(true, 200, JSON.stringify({
        id: 10,
        title: { rendered: "Product Manager до Closed Co" },
        content: { rendered: "<h2>Вакансія закрита</h2><p>Product role.</p>" },
      }));
    }

    if (url === "https://happymonday.ua/wp-json/wp/v2/job/11") {
      return response(true, 200, JSON.stringify({
        id: 11,
        title: { rendered: "Product Manager до Active Co" },
        content: { rendered: "<p>Remote product manager role. Location: Ukraine.</p>" },
      }));
    }

    return response(false, 500, "unexpected");
  });

  const result = await sources.fetchHappyMondayCandidates({
    roles: ["Product Manager"],
    exclusions: [],
    hiddenCompanies: [],
  });

  assert.deepEqual(result.candidates.map((job) => job.company), ["Active Co"]);
  assert.equal(result.candidates[0].format, "Remote");
});

test("lobby x detail validation skips closed or removed vacancies", async () => {
  const sources = createTestSources(async (url) => {
    if (url === "https://thelobbyx.com/wp-json/wp/v2/search?search=Product%20Manager&subtype=tors&per_page=10") {
      return response(true, 200, JSON.stringify([
        {
          id: 20,
          title: "Product Manager",
          url: "https://thelobbyx.com/tor/product-manager-to-closed-co/",
          subtype: "tors",
        },
        {
          id: 21,
          title: "Product Manager",
          url: "https://thelobbyx.com/tor/product-manager-to-removed-co/",
          subtype: "tors",
        },
        {
          id: 22,
          title: "Product Manager",
          url: "https://thelobbyx.com/tor/product-manager-to-active-co/",
          subtype: "tors",
        },
      ]));
    }

    if (url === "https://thelobbyx.com/wp-json/wp/v2/tors/20") {
      return response(true, 200, JSON.stringify({
        id: 20,
        title: { rendered: "Product Manager" },
        content: { rendered: "<p>UPD: vacancy is closed.</p>" },
      }));
    }

    if (url === "https://thelobbyx.com/wp-json/wp/v2/tors/21") {
      return response(false, 404, "not found");
    }

    if (url === "https://thelobbyx.com/wp-json/wp/v2/tors/22") {
      return response(true, 200, JSON.stringify({
        id: 22,
        title: { rendered: "Product Manager" },
        content: { rendered: "<p>Remote product manager role.</p>" },
      }));
    }

    return response(false, 500, "unexpected");
  });

  const result = await sources.fetchLobbyXCandidates({
    roles: ["Product Manager"],
    exclusions: [],
    hiddenCompanies: [],
  });

  assert.deepEqual(result.candidates.map((job) => job.company), ["Active Co"]);
  assert.equal(result.candidates[0].format, "Remote");
});

test("wordpress detail fetch failure keeps candidate with unknown availability", async () => {
  const loggerMessages = [];
  const sources = createTestSources(async (url) => {
    if (url === "https://happymonday.ua/wp-json/wp/v2/search?search=Product%20Manager&subtype=job&per_page=10") {
      return response(true, 200, JSON.stringify([
        {
          id: 30,
          title: "Product Manager до Retry Co",
          url: "https://happymonday.ua/jobs/30",
          subtype: "job",
        },
      ]));
    }

    if (url === "https://happymonday.ua/wp-json/wp/v2/job/30") {
      return response(false, 503, "temporary source issue");
    }

    return response(false, 500, "unexpected");
  }, {
    warn(message) {
      loggerMessages.push(message);
    },
    error() {},
  });

  const result = await sources.fetchHappyMondayCandidates({
    roles: ["Product Manager"],
    exclusions: [],
    hiddenCompanies: [],
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].company, "Retry Co");
  assert.equal(result.candidates[0].availability, "unknown");
  assert.equal(result.candidates[0].availabilityReason, "detail_fetch_failed");
  assert.equal(Number.isNaN(Date.parse(result.candidates[0].availabilityCheckedAt)), false);
  assert.equal(loggerMessages.length, 1);
});

test("job sources return needsProfile without network calls when roles are missing", async () => {
  let calls = 0;
  const sources = createTestSources(async () => {
    calls += 1;
    return response(true, 200, "{}");
  });

  const result = await sources.fetchCandidatesFromSources({
    roles: [],
  });

  assert.equal(calls, 0);
  assert.equal(result.needsProfile, true);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.sourceReports.map((report) => report.status), [
    "needs_profile",
    "needs_profile",
    "needs_profile",
    "needs_profile",
    "needs_profile",
    "needs_profile",
    "needs_profile",
    "needs_profile",
    "needs_profile",
  ]);
});
