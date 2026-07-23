function createJobSources({
  buildJoobleQuery,
  inferWorkFormat,
  jobContainsExcludedTerm,
  joobleJobToCandidate,
  parseRssItems,
  profileBlockedTerms,
  profileMatchesCandidate,
  fetchImpl = globalThis.fetch,
  env = process.env,
  logger = console,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch implementation is required for job sources");
  }

  function nowIso() {
    return new Date().toISOString();
  }

  async function joobleRequest(payload) {
    const apiKey = env.JOOBLE_API_KEY;
    if (!apiKey) {
      throw new Error("JOOBLE_API_KEY is missing in .env");
    }

    const baseUrl = (env.JOOBLE_BASE_URL || "https://ua.jooble.org/api").replace(/\/+$/, "");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(env.JOOBLE_TIMEOUT_MS || 15000));
    let response;
    let bodyText = "";

    try {
      response = await fetchImpl(`${baseUrl}/${encodeURIComponent(apiKey)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      bodyText = await response.text();
    } finally {
      clearTimeout(timeout);
    }

    let data;
    try {
      data = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      throw new Error(`Jooble returned non-JSON response: ${bodyText.slice(0, 500)}`);
    }

    if (!response.ok) {
      throw new Error(`Jooble request failed: ${response.status} ${bodyText.slice(0, 500)}`);
    }

    if (!Array.isArray(data.jobs)) {
      throw new Error("Jooble response did not include jobs array");
    }

    return data;
  }

  async function fetchJoobleCandidates(searchProfile = {}) {
    const query = buildJoobleQuery(searchProfile);
    if (!query) {
      return {
        needsProfile: true,
        candidates: [],
      };
    }

    const data = await joobleRequest(query);
    const exclusions = profileBlockedTerms(searchProfile);
    const candidates = data.jobs
      .map((job) => joobleJobToCandidate(job, searchProfile))
      .filter(Boolean)
      .filter((job) => !jobContainsExcludedTerm(job, exclusions));

    return {
      totalCount: data.totalCount || candidates.length,
      candidates,
    };
  }

  async function rssFeedRequest(feedUrl, timeoutMs, sourceName) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let bodyText = "";

    try {
      response = await fetchImpl(feedUrl, {
        headers: {
          "user-agent": "JobSearcherBot/0.1 (+Telegram job search assistant)",
          accept: "application/json, text/html, application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
        },
        signal: controller.signal,
      });
      bodyText = await response.text();
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`${sourceName} feed request failed: ${response.status}`);
    }

    return bodyText;
  }

  async function douRequest() {
    const feedUrl = env.DOU_FEED_URL || "https://jobs.dou.ua/vacancies/feeds/";
    return rssFeedRequest(feedUrl, Number(env.DOU_TIMEOUT_MS || 15000), "DOU");
  }

  function splitDouTitle(rawTitle) {
    const title = String(rawTitle || "").trim();
    const match = title.match(/^(.*?)\s+(?:в|at)\s+(.+?)(?:,\s*(.+))?$/i);
    if (!match) return { title, company: "не указано", location: "не указано" };

    return {
      title: match[1].trim(),
      company: match[2].trim(),
      location: (match[3] || "").trim() || "не указано",
    };
  }

  function douItemToCandidate(item, searchProfile = {}) {
    const sourceUrl = item.link;
    if (!item.title || !sourceUrl) return null;

    const titleParts = splitDouTitle(item.title);
    const job = {
      title: titleParts.title,
      company: titleParts.company,
      location: titleParts.location,
      snippet: item.description,
    };
    const format = inferWorkFormat(job);
    const risks = [];
    if (format === "не указано") risks.push("Формат работы нужно проверить в источнике.");

    return {
      source: "dou",
      externalId: item.guid || sourceUrl,
      sourceUrl,
      title: titleParts.title,
      company: titleParts.company,
      location: titleParts.location,
      format,
      salary: "Не указана",
      description: item.description || "",
      reasons: ["Вакансия найдена на профильной украинской IT-платформе."],
      risks,
    };
  }

  async function fetchDouCandidates(searchProfile = {}) {
    if (!buildJoobleQuery(searchProfile)) {
      return {
        needsProfile: true,
        candidates: [],
      };
    }

    const xml = await douRequest();
    const exclusions = profileBlockedTerms(searchProfile);
    const candidates = parseRssItems(xml)
      .map((item) => douItemToCandidate(item, searchProfile))
      .filter(Boolean)
      .filter((job) => profileMatchesCandidate(searchProfile, job))
      .filter((job) => !jobContainsExcludedTerm(job, exclusions));

    return {
      totalCount: candidates.length,
      candidates,
    };
  }

  function extractSalaryFromText(value) {
    const text = String(value || "");
    const match = text.match(/(?:\$|€|₴)\s?\d[\d\s,.]*(?:\s?[–-]\s?(?:\$|€|₴)?\s?\d[\d\s,.]*)?|\d[\d\s,.]*(?:\s?[–-]\s?\d[\d\s,.]*)?\s?(?:USD|EUR|UAH|грн)/i);
    return match ? match[0].replace(/\s+/g, " ").trim() : "Не указана";
  }

  function decodeHtmlEntities(value) {
    return String(value || "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
      .trim();
  }

  function stripHtml(value) {
    return decodeHtmlEntities(String(value || "")
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
      .replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
  }

  function absoluteWorkUaUrl(value) {
    const baseUrl = (env.WORK_UA_BASE_URL || env.WORKUA_BASE_URL || "https://www.work.ua").replace(/\/+$/, "");
    if (/^https?:\/\//i.test(value)) return value;
    return `${baseUrl}${String(value || "").startsWith("/") ? "" : "/"}${value || ""}`;
  }

  function slugifyWorkUaKeyword(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/['"`’]/g, "")
      .replace(/[^\p{L}\p{N}+#.]+/gu, "-")
      .replace(/^-+|-+$/g, "");
  }

  function buildWorkUaSearchUrl(searchProfile = {}) {
    const query = buildJoobleQuery(searchProfile);
    if (!query) return null;

    const roles = Array.isArray(searchProfile.roles)
      ? searchProfile.roles.filter(Boolean)
      : String(searchProfile.roles || "").split(",").map((item) => item.trim()).filter(Boolean);
    const keywords = roles.slice(0, 3).join(" ");
    const keywordSlug = slugifyWorkUaKeyword(keywords);
    if (!keywordSlug) return null;

    const baseUrl = (env.WORK_UA_BASE_URL || env.WORKUA_BASE_URL || "https://www.work.ua").replace(/\/+$/, "");
    return `${baseUrl}/jobs-${encodeURIComponent(keywordSlug)}/`;
  }

  function absoluteRobotaUaUrl(value) {
    const baseUrl = (env.ROBOTA_UA_BASE_URL || env.ROBOTAUA_BASE_URL || "https://robota.ua").replace(/\/+$/, "");
    if (/^https?:\/\//i.test(value)) return value;
    return `${baseUrl}${String(value || "").startsWith("/") ? "" : "/"}${value || ""}`;
  }

  function slugifyRobotaUaKeyword(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/['"`’]/g, "")
      .replace(/[^\p{L}\p{N}+#.]+/gu, "-")
      .replace(/^-+|-+$/g, "");
  }

  function buildRobotaUaSearchUrl(searchProfile = {}) {
    const query = buildJoobleQuery(searchProfile);
    if (!query) return null;

    const roles = Array.isArray(searchProfile.roles)
      ? searchProfile.roles.filter(Boolean)
      : String(searchProfile.roles || "").split(",").map((item) => item.trim()).filter(Boolean);
    const keywordSlug = slugifyRobotaUaKeyword(roles.slice(0, 3).join(" "));
    if (!keywordSlug) return null;

    const baseUrl = (env.ROBOTA_UA_BASE_URL || env.ROBOTAUA_BASE_URL || "https://robota.ua").replace(/\/+$/, "");
    return `${baseUrl}/zapros/${encodeURIComponent(keywordSlug)}/ukraine`;
  }

  function absoluteJobsUaUrl(value) {
    const baseUrl = (env.JOBS_UA_BASE_URL || env.JOBSUA_BASE_URL || "https://jobs.ua").replace(/\/+$/, "");
    if (/^https?:\/\//i.test(value)) return value;
    return `${baseUrl}${String(value || "").startsWith("/") ? "" : "/"}${value || ""}`;
  }

  function slugifyJobsUaKeyword(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/['"`’]/g, "")
      .replace(/[^\p{L}\p{N}+#.]+/gu, "-")
      .replace(/^-+|-+$/g, "");
  }

  function buildJobsUaSearchUrl(searchProfile = {}) {
    if (!buildJoobleQuery(searchProfile)) return null;
    const keywordSlug = slugifyJobsUaKeyword(profileRoleKeywords(searchProfile));
    if (!keywordSlug) return null;

    const baseUrl = (env.JOBS_UA_BASE_URL || env.JOBSUA_BASE_URL || "https://jobs.ua").replace(/\/+$/, "");
    return `${baseUrl}/vacancy/rabota-${encodeURIComponent(keywordSlug)}`;
  }

  function absoluteOlxUaUrl(value) {
    const baseUrl = (env.OLX_UA_BASE_URL || env.OLXUA_BASE_URL || "https://www.olx.ua").replace(/\/+$/, "");
    const rawValue = decodeHtmlEntities(value);
    try {
      const url = new URL(rawValue, baseUrl);
      url.searchParams.delete("reason");
      url.searchParams.delete("search_reason");
      return url.toString();
    } catch {
      if (/^https?:\/\//i.test(rawValue)) return rawValue;
      return `${baseUrl}${String(rawValue || "").startsWith("/") ? "" : "/"}${rawValue || ""}`;
    }
  }

  function slugifyOlxUaKeyword(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/['"`’]/g, "")
      .replace(/[^\p{L}\p{N}+#.]+/gu, "-")
      .replace(/^-+|-+$/g, "");
  }

  function buildOlxUaSearchUrl(searchProfile = {}) {
    if (!buildJoobleQuery(searchProfile)) return null;
    const keywordSlug = slugifyOlxUaKeyword(profileRoleKeywords(searchProfile));
    if (!keywordSlug) return null;

    const baseUrl = (env.OLX_UA_BASE_URL || env.OLXUA_BASE_URL || "https://www.olx.ua").replace(/\/+$/, "");
    return `${baseUrl}/uk/rabota/q-${encodeURIComponent(keywordSlug)}/`;
  }

  function profileRoleKeywords(searchProfile = {}) {
    const roles = Array.isArray(searchProfile.roles)
      ? searchProfile.roles.filter(Boolean)
      : String(searchProfile.roles || "").split(",").map((item) => item.trim()).filter(Boolean);
    return roles.slice(0, 3).join(" ").trim();
  }

  function buildWordPressSearchUrl(baseUrl, subtype, searchProfile = {}) {
    if (!buildJoobleQuery(searchProfile)) return null;
    const keywords = profileRoleKeywords(searchProfile);
    if (!keywords) return null;
    const normalizedBaseUrl = String(baseUrl || "").replace(/\/+$/, "");
    return `${normalizedBaseUrl}/wp-json/wp/v2/search?search=${encodeURIComponent(keywords)}&subtype=${encodeURIComponent(subtype)}&per_page=10`;
  }

  function buildWordPressDetailUrl(baseUrl, postType, item) {
    if (!item?.id) return null;
    const normalizedBaseUrl = String(baseUrl || "").replace(/\/+$/, "");
    return `${normalizedBaseUrl}/wp-json/wp/v2/${encodeURIComponent(postType)}/${encodeURIComponent(item.id)}`;
  }

  function numberFromEnv(names, fallback) {
    for (const name of names) {
      const value = Number(env[name]);
      if (Number.isFinite(value)) return value;
    }
    return fallback;
  }

  function detailLimitFromEnv(names, fallback = 5) {
    return Math.max(0, Math.min(10, Math.floor(numberFromEnv(names, fallback))));
  }

  async function wordpressJsonRequest(feedUrl, timeoutMs, sourceName) {
    const bodyText = await rssFeedRequest(feedUrl, timeoutMs, sourceName);
    try {
      return bodyText ? JSON.parse(bodyText) : null;
    } catch {
      throw new Error(`${sourceName} returned non-JSON response: ${bodyText.slice(0, 500)}`);
    }
  }

  async function wordpressSearchRequest(feedUrl, timeoutMs, sourceName) {
    const data = await wordpressJsonRequest(feedUrl, timeoutMs, sourceName);

    if (!Array.isArray(data)) {
      throw new Error(`${sourceName} response did not include array`);
    }

    return data;
  }

  function wpSearchTitle(item) {
    return stripHtml(item?.title?.rendered || item?.title || "");
  }

  function wpSearchUrl(item) {
    return item?.url || item?.link || item?._links?.self?.[0]?.href || "";
  }

  function wpRenderedText(value) {
    if (!value) return "";
    if (typeof value === "string") return stripHtml(value);
    if (typeof value.rendered === "string") return stripHtml(value.rendered);
    return "";
  }

  function wordpressDetailText(detail = {}) {
    return [
      wpRenderedText(detail.title),
      wpRenderedText(detail.content),
      wpRenderedText(detail.excerpt),
      detail?.yoast_head_json?.description,
      detail?.yoast_head_json?.og_description,
    ]
      .filter(Boolean)
      .map(stripHtml)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isClosedJobText(value) {
    const text = String(value || "").toLowerCase();
    return /вакансія.{0,50}закрита|вакансия.{0,50}закрыта|vacancy.{0,50}closed|job.{0,50}closed|no\s+longer\s+accepting|трохи\s+запізнились|немає\s+відкритих\s+вакансій|нет\s+открытых\s+вакансий/i.test(text);
  }

  function detailIsClosed(detail = {}) {
    if (detail.__closed) return true;
    return isClosedJobText(wordpressDetailText(detail));
  }

  function extractLocationFromText(value) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    const labeled = text.match(/(?:Location|Локація|Локация|Місто|Город):\s*([^.;|]{2,80})/i);
    if (labeled) return labeled[1].trim();

    const locations = [
      "Remote",
      "Віддалений",
      "Віддалено",
      "Удаленно",
      "Ukraine",
      "Україна",
      "Київ",
      "Kyiv",
      "Львів",
      "Lviv",
      "Одеса",
      "Odesa",
      "Дніпро",
      "Dnipro",
      "Харків",
      "Kharkiv",
    ];
    return locations.find((location) => new RegExp(`\\b${location}\\b`, "i").test(text)) || null;
  }

  function removeRisk(risks, pattern) {
    return (risks || []).filter((risk) => !pattern.test(risk));
  }

  async function fetchWordPressDetail(item, { baseUrl, postType, sourceName, timeoutMs }) {
    const detailUrl = buildWordPressDetailUrl(baseUrl, postType, item);
    if (!detailUrl) return null;

    try {
      return await wordpressJsonRequest(detailUrl, timeoutMs, sourceName);
    } catch (error) {
      if (/\b(?:404|410)\b/.test(String(error?.message || ""))) {
        return {
          __closed: true,
          __closedReason: "detail_not_found",
        };
      }
      logger.warn?.(`[bot] ${sourceName} detail failed for ${item.id}: ${error.message}`);
      return {
        __detailFailed: true,
      };
    }
  }

  function markDetailFetchFailed(entry) {
    return {
      ...entry,
      candidate: {
        ...entry.candidate,
        availability: "unknown",
        availabilityCheckedAt: nowIso(),
        availabilityReason: "detail_fetch_failed",
        detailStatusCode: null,
      },
    };
  }

  async function enrichWordPressEntries(entries, options) {
    const limit = detailLimitFromEnv(options.limitEnvNames, options.defaultLimit);
    if (!limit) return entries;

    const enriched = [];
    for (const entry of entries) {
      if (enriched.length >= limit) {
        enriched.push(entry);
        continue;
      }

      const detail = await fetchWordPressDetail(entry.item, options);
      enriched.push(options.enrich(entry, detail));
    }

    return enriched;
  }

  function splitHappyMondayTitle(rawTitle) {
    const title = stripHtml(rawTitle);
    const match = title.match(/^(.*?)\s+(?:до|at|to)\s+(.+)$/i);
    if (!match) return { title, company: "не указано" };
    return {
      title: match[1].trim(),
      company: match[2].trim(),
    };
  }

  function companyFromLobbyXUrl(url) {
    const slug = String(url || "").match(/\/tor\/([^/]+)\//i)?.[1] || "";
    const companySlug = slug.match(/-to-(.+)$/i)?.[1] || "";
    if (!companySlug) return "не указано";
    return companySlug
      .split("-")
      .filter(Boolean)
      .map((part) => part.toUpperCase() === "nda" ? "NDA" : `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
      .join(" ");
  }

  function happyMondayItemToCandidate(item, searchProfile = {}) {
    const sourceUrl = wpSearchUrl(item);
    const rawTitle = wpSearchTitle(item);
    if (!rawTitle || !sourceUrl) return null;
    const titleParts = splitHappyMondayTitle(rawTitle);
    const job = {
      title: titleParts.title,
      location: "Ukraine",
      description: rawTitle,
    };
    const format = inferWorkFormat(job);
    const risks = ["Детали вакансии нужно проверить в источнике."];
    if (format === "не указано") risks.push("Формат работы нужно проверить в источнике.");

    return {
      source: "happymonday",
      externalId: item.id ? String(item.id) : sourceUrl,
      sourceUrl,
      title: titleParts.title,
      company: titleParts.company,
      location: "Ukraine",
      format,
      salary: "Не указана",
      description: rawTitle,
      reasons: ["Вакансия найдена на Happy Monday, украинской платформе карьерных возможностей."],
      risks,
      availability: "unknown",
      availabilityCheckedAt: null,
      availabilityReason: "search_result_only",
      enrichedAt: null,
      detailStatusCode: null,
    };
  }

  function enrichHappyMondayEntry(entry, detail) {
    if (!detail) return entry;
    if (detail.__detailFailed) return markDetailFetchFailed(entry);
    if (detailIsClosed(detail)) return null;

    const detailTitle = wpRenderedText(detail.title);
    const description = wordpressDetailText(detail);
    const titleParts = detailTitle ? splitHappyMondayTitle(detailTitle) : null;
    const location = extractLocationFromText(description) || entry.candidate.location;
    const format = inferWorkFormat({
      title: titleParts?.title || entry.candidate.title,
      location,
      description,
    });
    const salary = extractSalaryFromText(description);
    let risks = removeRisk(entry.candidate.risks, /Детали вакансии/i);
    if (salary === "Не указана") risks.push("Зарплата не указана в источнике.");
    if (format === "не указано" && !risks.some((risk) => /Формат работы/i.test(risk))) {
      risks.push("Формат работы нужно проверить в источнике.");
    }

    return {
      ...entry,
      candidate: {
        ...entry.candidate,
        title: titleParts?.title || entry.candidate.title,
        company: titleParts?.company && titleParts.company !== "не указано" ? titleParts.company : entry.candidate.company,
        location,
        format,
        salary,
        description: description || entry.candidate.description,
        risks,
        availability: "open",
        availabilityCheckedAt: nowIso(),
        availabilityReason: "detail_checked",
        enrichedAt: nowIso(),
        detailStatusCode: 200,
      },
    };
  }

  function lobbyXItemToCandidate(item, searchProfile = {}) {
    const sourceUrl = wpSearchUrl(item);
    const title = wpSearchTitle(item);
    if (!title || !sourceUrl) return null;
    const company = companyFromLobbyXUrl(sourceUrl);
    const description = `${title} ${company === "не указано" ? "" : company}`.trim();
    const format = inferWorkFormat({
      title,
      location: "Ukraine",
      description,
    });
    const risks = ["Детали вакансии нужно проверить в источнике."];
    if (format === "не указано") risks.push("Формат работы нужно проверить в источнике.");

    return {
      source: "lobbyx",
      externalId: item.id ? String(item.id) : sourceUrl,
      sourceUrl,
      title,
      company,
      location: "Ukraine",
      format,
      salary: "Не указана",
      description,
      reasons: ["Вакансия найдена на Lobby X, платформе для прогрессивного бизнеса, NGO, govtech и miltech ролей."],
      risks,
      availability: "unknown",
      availabilityCheckedAt: null,
      availabilityReason: "search_result_only",
      enrichedAt: null,
      detailStatusCode: null,
    };
  }

  function enrichLobbyXEntry(entry, detail) {
    if (!detail) return entry;
    if (detail.__detailFailed) return markDetailFetchFailed(entry);
    if (detailIsClosed(detail)) return null;

    const title = wpRenderedText(detail.title) || entry.candidate.title;
    const description = wordpressDetailText(detail);
    const location = extractLocationFromText(description) || entry.candidate.location;
    const format = inferWorkFormat({
      title,
      location,
      description,
    });
    const salary = extractSalaryFromText(description);
    let risks = removeRisk(entry.candidate.risks, /Детали вакансии/i);
    if (salary === "Не указана") risks.push("Зарплата не указана в источнике.");
    if (format === "не указано" && !risks.some((risk) => /Формат работы/i.test(risk))) {
      risks.push("Формат работы нужно проверить в источнике.");
    }

    return {
      ...entry,
      candidate: {
        ...entry.candidate,
        title,
        location,
        format,
        salary,
        description: description || entry.candidate.description,
        risks,
        availability: "open",
        availabilityCheckedAt: nowIso(),
        availabilityReason: "detail_checked",
        enrichedAt: nowIso(),
        detailStatusCode: 200,
      },
    };
  }

  function extractWorkUaCards(html) {
    const text = String(html || "");
    const cards = [];
    const cardPattern = /<div\b[^>]*\bid=["']job-(\d+)["'][^>]*>[\s\S]*?(?=<div\b[^>]*\bid=["']job-\d+["']|<nav\b|<footer\b|<\/main>|$)/gi;
    for (const match of text.matchAll(cardPattern)) {
      cards.push({ id: match[1], html: match[0] });
    }
    return cards;
  }

  function parseWorkUaHtml(html) {
    return extractWorkUaCards(html).map(({ id, html: cardHtml }) => {
      const titleMatch = cardHtml.match(/<h2[^>]*>[\s\S]*?<a[^>]+href=["']([^"']*\/jobs\/\d+[^"']*)["'][^>]*>([\s\S]*?)<\/a>/i) ||
        cardHtml.match(/<a[^>]+href=["']([^"']*\/jobs\/\d+[^"']*)["'][^>]*>([\s\S]*?)<\/a>/i);
      if (!titleMatch) return null;

      const title = stripHtml(titleMatch[2]);
      const sourceUrl = absoluteWorkUaUrl(titleMatch[1]);
      const afterTitle = cardHtml.slice(cardHtml.indexOf(titleMatch[0]) + titleMatch[0].length);
      const companyMatch = afterTitle.match(/<a[^>]+href=["'][^"']*(?:\/jobs\/by-company\/|\/en\/jobs\/by-company\/|\/ru\/jobs\/by-company\/)[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
      const salaryMatch = cardHtml.match(/<span[^>]*class=["'][^"']*(?:salary|strong)[^"']*["'][^>]*>([\s\S]*?(?:грн|uah|\$|€)[\s\S]*?)<\/span>/i) ||
        cardHtml.match(/(?:^|>|\s)((?:\$|€|₴)\s?\d[\d\s,.]*(?:\s?[–-]\s?(?:\$|€|₴)?\s?\d[\d\s,.]*)?|\d[\d\s,.]*(?:\s?[–-]\s?\d[\d\s,.]*)?\s?(?:грн|UAH|USD|EUR))(?:<|\s|$)/i);
      const locationMatch = cardHtml.match(/<span[^>]*class=["'][^"']*(?:location|city|text-muted)[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
      const paragraphMatch = afterTitle.match(/<p[^>]*>([\s\S]*?)<\/p>/i);

      return {
        id,
        title,
        sourceUrl,
        company: companyMatch ? stripHtml(companyMatch[1]) : "не указано",
        location: locationMatch ? stripHtml(locationMatch[1]) : "не указано",
        salary: salaryMatch ? stripHtml(salaryMatch[1]) : "Не указана",
        description: paragraphMatch ? stripHtml(paragraphMatch[1]) : stripHtml(afterTitle).slice(0, 700),
      };
    }).filter(Boolean);
  }

  function workUaJobToCandidate(job, searchProfile = {}) {
    if (!job.title || !job.sourceUrl) return null;
    const format = inferWorkFormat({
      title: job.title,
      location: job.location,
      description: job.description,
    });
    const risks = [];
    if (!job.salary || job.salary === "Не указана") risks.push("Зарплата не указана в источнике.");
    if (format === "не указано") risks.push("Формат работы нужно проверить в источнике.");

    return {
      source: "workua",
      externalId: job.id ? String(job.id) : job.sourceUrl,
      sourceUrl: job.sourceUrl,
      title: job.title,
      company: job.company || "не указано",
      location: job.location || "не указано",
      format,
      salary: job.salary || "Не указана",
      description: job.description || "",
      reasons: ["Вакансия найдена на Work.ua, одной из крупнейших украинских платформ работы."],
      risks,
    };
  }

  function extractRobotaUaCards(html) {
    const text = String(html || "");
    const matches = [...text.matchAll(/<a\b[^>]+href=["']([^"']*(?:\/company\d+\/vacancy\d+|\/vacancy\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)];
    return matches.map((match, index) => {
      const nextIndex = matches[index + 1]?.index ?? text.length;
      const previousArticle = text.lastIndexOf("<article", match.index);
      const previousCard = text.lastIndexOf("<div", match.index);
      const start = Math.max(previousArticle, previousCard, match.index);
      const end = Math.min(nextIndex, match.index + 5000);
      return {
        href: match[1],
        anchorHtml: match[2],
        html: text.slice(start, end),
      };
    });
  }

  function cleanRobotaUaTitle(value) {
    return stripHtml(value)
      .replace(/^(?:Гаряча|Горячая)\s+/i, "")
      .replace(/^(?:Віддалена робота|Удаленная работа|Віддалено|Удаленно)\s+/i, "")
      .trim();
  }

  function parseRobotaUaHtml(html) {
    const seen = new Set();
    return extractRobotaUaCards(html).map(({ href, anchorHtml, html: cardHtml }) => {
      const sourceUrl = absoluteRobotaUaUrl(href);
      const vacancyId = href.match(/vacancy(\d+)/i)?.[1] || sourceUrl;
      if (seen.has(vacancyId)) return null;
      seen.add(vacancyId);

      const titleMatch = anchorHtml.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i) ||
        cardHtml.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
      const rawTitle = titleMatch ? titleMatch[1] : anchorHtml;
      const title = cleanRobotaUaTitle(rawTitle);
      if (!title) return null;

      const companyMatch = cardHtml.match(/<[^>]+class=["'][^"']*(?:company|santa-typo-secondary|employer)[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i);
      const locationMatch = cardHtml.match(/<[^>]+class=["'][^"']*(?:location|city|region)[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i);
      const paragraphMatch = cardHtml.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      const cardText = stripHtml(cardHtml);

      return {
        id: vacancyId,
        title,
        sourceUrl,
        company: companyMatch ? stripHtml(companyMatch[1]) : "не указано",
        location: locationMatch ? stripHtml(locationMatch[1]) : "не указано",
        salary: extractSalaryFromText(cardText),
        description: paragraphMatch ? stripHtml(paragraphMatch[1]) : cardText.slice(0, 700),
      };
    }).filter(Boolean);
  }

  function robotaUaJobToCandidate(job, searchProfile = {}) {
    if (!job.title || !job.sourceUrl) return null;
    const format = inferWorkFormat({
      title: job.title,
      location: job.location,
      description: job.description,
    });
    const risks = [];
    if (!job.salary || job.salary === "Не указана") risks.push("Зарплата не указана в источнике.");
    if (format === "не указано") risks.push("Формат работы нужно проверить в источнике.");

    return {
      source: "robotaua",
      externalId: job.id ? String(job.id) : job.sourceUrl,
      sourceUrl: job.sourceUrl,
      title: job.title,
      company: job.company || "не указано",
      location: job.location || "не указано",
      format,
      salary: job.salary || "Не указана",
      description: job.description || "",
      reasons: ["Вакансия найдена на robota.ua, крупной украинской платформе работы."],
      risks,
    };
  }

  function extractJobsUaCards(html) {
    const text = String(html || "");
    const cards = [];
    const cardPattern = /<li\b[^>]*class=["'][^"']*\bb-vacancy__item\b[^"']*\bjs-item_list\b[^"']*["'][^>]*\bid=["']?(\d+)["']?[^>]*>[\s\S]*?(?=<li\b[^>]*class=["'][^"']*\bb-vacancy__item\b[^"']*\bjs-item_list\b|<\/ul>)/gi;
    for (const match of text.matchAll(cardPattern)) {
      cards.push({ id: match[1], html: match[0] });
    }
    return cards;
  }

  function parseJobsUaHtml(html) {
    return extractJobsUaCards(html).map(({ id, html: cardHtml }) => {
      const titleMatch = cardHtml.match(/<a[^>]+class=["'][^"']*\bjs-item_title\b[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
      if (!titleMatch) return null;

      const title = stripHtml(titleMatch[2]);
      const sourceUrl = absoluteJobsUaUrl(titleMatch[1]);
      const companyMatch = cardHtml.match(/<span[^>]+class=["'][^"']*\blink__hidden\b[^"']*["'][^>]*title=["']([^"']+)["'][^>]*>/i);
      const locationMatch = cardHtml.match(/fa-map-marker[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
      const scheduleMatch = cardHtml.match(/<span[^>]*class=["'][^"']*\bcaption\b[^"']*["'][^>]*>\s*Графік роботи:\s*<\/span>[\s\S]*?<span[^>]*class=["'][^"']*\bblack-text\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
      const salaryMatch = cardHtml.match(/<span[^>]*class=["'][^"']*\bb-vacancy__top__pay\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
      const descriptionMatch = cardHtml.match(/<div[^>]+class=["'][^"']*\bb-text\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
      const cardText = stripHtml(cardHtml);

      return {
        id,
        title,
        sourceUrl,
        company: companyMatch ? stripHtml(companyMatch[1]) : "не указано",
        location: locationMatch ? stripHtml(locationMatch[1]) : "не указано",
        schedule: scheduleMatch ? stripHtml(scheduleMatch[1]) : "",
        salary: salaryMatch ? stripHtml(salaryMatch[1]) : extractSalaryFromText(cardText),
        description: descriptionMatch ? stripHtml(descriptionMatch[1]) : cardText.slice(0, 700),
      };
    }).filter(Boolean);
  }

  function jobsUaJobToCandidate(job, searchProfile = {}) {
    if (!job.title || !job.sourceUrl) return null;
    const description = [job.schedule, job.description].filter(Boolean).join(" ");
    const format = inferWorkFormat({
      title: job.title,
      location: job.location,
      description,
    });
    const risks = [];
    if (!job.salary || job.salary === "Не указана") risks.push("Зарплата не указана в источнике.");
    if (format === "не указано") risks.push("Формат работы нужно проверить в источнике.");

    return {
      source: "jobsua",
      externalId: job.id ? String(job.id) : job.sourceUrl,
      sourceUrl: job.sourceUrl,
      title: job.title,
      company: job.company || "не указано",
      location: job.location || "не указано",
      format,
      salary: job.salary || "Не указана",
      description,
      reasons: ["Вакансия найдена на Jobs.ua, украинской платформе поиска работы."],
      risks,
      availability: "unknown",
      availabilityCheckedAt: null,
      availabilityReason: "search_result_only",
      enrichedAt: null,
      detailStatusCode: null,
    };
  }

  function extractOlxUaCards(html) {
    const text = String(html || "");
    const starts = [...text.matchAll(/<(?:div|li)\b[^>]*(?:data-cy|data-testid)=["']l-card["'][^>]*>/gi)];
    return starts.map((match, index) => {
      const nextIndex = starts[index + 1]?.index ?? text.length;
      const endMarkers = [
        text.indexOf('data-testid="pagination-wrapper"', match.index + match[0].length),
        text.indexOf('data-cy="pagination"', match.index + match[0].length),
        text.indexOf("<footer", match.index + match[0].length),
      ].filter((position) => position > match.index);
      const naturalEnd = endMarkers.length ? Math.min(nextIndex, ...endMarkers) : nextIndex;
      return text.slice(match.index, naturalEnd);
    });
  }

  function olxUaFieldText(cardHtml, testId) {
    const pattern = new RegExp(`<[^>]+data-testid=["']${testId}["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, "i");
    const match = String(cardHtml || "").match(pattern);
    return match ? stripHtml(match[1]) : "";
  }

  function olxUaLocationFromDate(value) {
    const text = stripHtml(value);
    if (!text) return "не указано";
    return text.split(/\s+-\s+/)[0]?.trim() || "не указано";
  }

  function olxUaLocationFromCardText(cardText, salary) {
    const text = stripHtml(cardText);
    const salaryText = stripHtml(salary);
    const afterSalary = salaryText && text.includes(salaryText)
      ? text.slice(text.indexOf(salaryText) + salaryText.length)
      : text;
    const normalizedTail = afterSalary
      .replace(/^[\s.,;:]+/, "")
      .replace(/^за\s+(?:місяць|месяц|годину|час|день)\s+/i, "");
    const match = normalizedTail.match(/^(.{2,80}?)(?=\s+(?:Повна зайнятість|Полная занятость|Неповна зайнятість|Неполная занятость|Часткова зайнятість|Повний робочий день|Полный рабочий день|Неповний робочий день|Позмінний графік|Сьогодні|Сегодня|Вчора|Вчера|\d{1,2}\s+\p{L}))/iu);
    return match ? stripHtml(match[1]).replace(/[.,;:]+$/g, "").trim() || "не указано" : "не указано";
  }

  function olxUaHrefLooksLikeSearchNoise(value) {
    const href = decodeHtmlEntities(value).toLowerCase();
    return href.includes("extended_search") || href.includes("/list/user/");
  }

  function parseOlxUaHtml(html) {
    const seen = new Set();
    return extractOlxUaCards(html).map((cardHtml) => {
      const linkMatch = cardHtml.match(/<a[^>]+data-testid=["']card-title-link["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i) ||
        cardHtml.match(/<a[^>]+href=["']([^"']*(?:\/d)?\/(?:uk|ru)\/obyavlenie\/rabota\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
      if (!linkMatch) return null;

      const href = linkMatch[1];
      if (!/(?:\/d)?\/(?:uk|ru)\/obyavlenie\/rabota\//i.test(decodeHtmlEntities(href))) return null;
      if (olxUaHrefLooksLikeSearchNoise(href)) return null;

      const sourceUrl = absoluteOlxUaUrl(href);
      const id = sourceUrl.match(/ID([a-z0-9]+)\.html/i)?.[1] || sourceUrl;
      if (seen.has(id)) return null;
      seen.add(id);

      const title = olxUaFieldText(cardHtml, "ad-card-title") || stripHtml(linkMatch[2]);
      if (!title) return null;

      const cardText = stripHtml(cardHtml);
      const salary = olxUaFieldText(cardHtml, "ad-price") || extractSalaryFromText(cardText);
      const locationDate = olxUaFieldText(cardHtml, "location-date");
      const location = olxUaLocationFromDate(locationDate);

      return {
        id,
        title,
        sourceUrl,
        company: "не указано",
        location: location === "не указано" ? olxUaLocationFromCardText(cardText, salary) : location,
        salary,
        description: cardText.slice(0, 700),
      };
    }).filter(Boolean);
  }

  function olxUaJobToCandidate(job, searchProfile = {}) {
    if (!job.title || !job.sourceUrl) return null;
    const format = inferWorkFormat({
      title: job.title,
      location: job.location,
      description: job.description,
    });
    const risks = ["Детали вакансии нужно проверить в источнике."];
    if (!job.salary || job.salary === "Не указана") risks.push("Зарплата не указана в источнике.");
    if (format === "не указано") risks.push("Формат работы нужно проверить в источнике.");

    return {
      source: "olxua",
      externalId: job.id ? String(job.id) : job.sourceUrl,
      sourceUrl: job.sourceUrl,
      title: job.title,
      company: job.company || "не указано",
      location: job.location || "не указано",
      format,
      salary: job.salary || "Не указана",
      description: job.description || "",
      reasons: ["Вакансия найдена на OLX Robota, публичном украинском разделе вакансий."],
      risks,
      availability: "unknown",
      availabilityCheckedAt: null,
      availabilityReason: "search_result_only",
      enrichedAt: null,
      detailStatusCode: null,
    };
  }

  function splitDjinniTitle(rawTitle) {
    const title = String(rawTitle || "").trim();
    const knownSuffixes = ["Responds Quickly", "Relocate", "Remote"];
    let cleaned = title;
    for (const suffix of knownSuffixes) {
      cleaned = cleaned.replace(new RegExp(`\\s+${suffix}\\b`, "i"), "");
    }
    cleaned = cleaned.replace(/\s+\${1,5}\s*$/, "").trim();

    const separators = [" at ", " в "];
    for (const separator of separators) {
      const index = cleaned.toLowerCase().lastIndexOf(separator);
      if (index > 0) {
        return {
          title: cleaned.slice(0, index).trim(),
          company: cleaned.slice(index + separator.length).trim() || "не указано",
        };
      }
    }

    return {
      title: cleaned,
      company: "не указано",
    };
  }

  function djinniItemToCandidate(item, searchProfile = {}) {
    const sourceUrl = item.link;
    if (!item.title || !sourceUrl) return null;

    const titleParts = splitDjinniTitle(item.title);
    const job = {
      title: titleParts.title,
      company: titleParts.company,
      location: item.description,
      snippet: item.description,
    };
    const format = inferWorkFormat(job);
    const risks = [];
    if (format === "не указано") risks.push("Формат работы нужно проверить в источнике.");

    return {
      source: "djinni",
      externalId: item.guid || sourceUrl,
      sourceUrl,
      title: titleParts.title,
      company: titleParts.company,
      location: item.description.match(/(?:Full Remote|Remote|Ukraine|Worldwide|EU|Europe|Kyiv|Lviv|Dnipro|Odesa)[^·\n]*/i)?.[0]?.trim() || "не указано",
      format,
      salary: extractSalaryFromText(`${item.title} ${item.description}`),
      description: item.description || "",
      reasons: ["Вакансия найдена на украинской tech-платформе."],
      risks,
    };
  }

  async function fetchDjinniCandidates(searchProfile = {}) {
    if (!buildJoobleQuery(searchProfile)) {
      return {
        needsProfile: true,
        candidates: [],
      };
    }

    const feedUrl = env.DJINNI_FEED_URL || "https://djinni.co/jobs/rss/";
    const xml = await rssFeedRequest(feedUrl, Number(env.DJINNI_TIMEOUT_MS || 15000), "Djinni");
    const exclusions = profileBlockedTerms(searchProfile);
    const candidates = parseRssItems(xml)
      .map((item) => djinniItemToCandidate(item, searchProfile))
      .filter(Boolean)
      .filter((job) => profileMatchesCandidate(searchProfile, job))
      .filter((job) => !jobContainsExcludedTerm(job, exclusions));

    return {
      totalCount: candidates.length,
      candidates,
    };
  }

  async function fetchWorkUaCandidates(searchProfile = {}) {
    const searchUrl = env.WORK_UA_FEED_URL || env.WORKUA_FEED_URL || buildWorkUaSearchUrl(searchProfile);
    if (!searchUrl) {
      return {
        needsProfile: true,
        candidates: [],
      };
    }

    const html = await rssFeedRequest(searchUrl, Number(env.WORK_UA_TIMEOUT_MS || env.WORKUA_TIMEOUT_MS || 15000), "Work.ua");
    const exclusions = profileBlockedTerms(searchProfile);
    const candidates = parseWorkUaHtml(html)
      .map((item) => workUaJobToCandidate(item, searchProfile))
      .filter(Boolean)
      .filter((job) => profileMatchesCandidate(searchProfile, job))
      .filter((job) => !jobContainsExcludedTerm(job, exclusions));

    return {
      totalCount: candidates.length,
      candidates,
    };
  }

  async function fetchRobotaUaCandidates(searchProfile = {}) {
    const searchUrl = env.ROBOTA_UA_FEED_URL || env.ROBOTAUA_FEED_URL || buildRobotaUaSearchUrl(searchProfile);
    if (!searchUrl) {
      return {
        needsProfile: true,
        candidates: [],
      };
    }

    const html = await rssFeedRequest(searchUrl, Number(env.ROBOTA_UA_TIMEOUT_MS || env.ROBOTAUA_TIMEOUT_MS || 15000), "robota.ua");
    const exclusions = profileBlockedTerms(searchProfile);
    const candidates = parseRobotaUaHtml(html)
      .map((item) => robotaUaJobToCandidate(item, searchProfile))
      .filter(Boolean)
      .filter((job) => profileMatchesCandidate(searchProfile, job))
      .filter((job) => !jobContainsExcludedTerm(job, exclusions));

    return {
      totalCount: candidates.length,
      candidates,
    };
  }

  async function fetchJobsUaCandidates(searchProfile = {}) {
    const searchUrl = env.JOBS_UA_FEED_URL || env.JOBSUA_FEED_URL || buildJobsUaSearchUrl(searchProfile);
    if (!searchUrl) {
      return {
        needsProfile: true,
        candidates: [],
      };
    }

    const html = await rssFeedRequest(searchUrl, Number(env.JOBS_UA_TIMEOUT_MS || env.JOBSUA_TIMEOUT_MS || 15000), "Jobs.ua");
    const exclusions = profileBlockedTerms(searchProfile);
    const candidates = parseJobsUaHtml(html)
      .map((item) => jobsUaJobToCandidate(item, searchProfile))
      .filter(Boolean)
      .filter((job) => profileMatchesCandidate(searchProfile, job))
      .filter((job) => !jobContainsExcludedTerm(job, exclusions));

    return {
      totalCount: candidates.length,
      candidates,
    };
  }

  async function fetchOlxUaCandidates(searchProfile = {}) {
    const searchUrl = env.OLX_UA_FEED_URL || env.OLXUA_FEED_URL || buildOlxUaSearchUrl(searchProfile);
    if (!searchUrl) {
      return {
        needsProfile: true,
        candidates: [],
      };
    }

    const html = await rssFeedRequest(searchUrl, Number(env.OLX_UA_TIMEOUT_MS || env.OLXUA_TIMEOUT_MS || 15000), "OLX Robota");
    const exclusions = profileBlockedTerms(searchProfile);
    const candidates = parseOlxUaHtml(html)
      .map((item) => olxUaJobToCandidate(item, searchProfile))
      .filter(Boolean)
      .filter((job) => profileMatchesCandidate(searchProfile, job))
      .filter((job) => !jobContainsExcludedTerm(job, exclusions));

    return {
      totalCount: candidates.length,
      candidates,
    };
  }

  async function fetchHappyMondayCandidates(searchProfile = {}) {
    const baseUrl = env.HAPPY_MONDAY_BASE_URL || env.HAPPYMONDAY_BASE_URL || "https://happymonday.ua";
    const searchUrl = env.HAPPY_MONDAY_FEED_URL ||
      env.HAPPYMONDAY_FEED_URL ||
      buildWordPressSearchUrl(baseUrl, "job", searchProfile);
    if (!searchUrl) {
      return {
        needsProfile: true,
        candidates: [],
      };
    }

    const data = await wordpressSearchRequest(searchUrl, Number(env.HAPPY_MONDAY_TIMEOUT_MS || env.HAPPYMONDAY_TIMEOUT_MS || 15000), "Happy Monday");
    const exclusions = profileBlockedTerms(searchProfile);
    const entries = data
      .filter((item) => !item.subtype || item.subtype === "job")
      .map((item) => ({
        item,
        candidate: happyMondayItemToCandidate(item, searchProfile),
      }))
      .filter((entry) => entry.candidate)
      .filter((entry) => profileMatchesCandidate(searchProfile, entry.candidate))
      .filter((entry) => !jobContainsExcludedTerm(entry.candidate, exclusions));
    const enrichedEntries = await enrichWordPressEntries(entries, {
      baseUrl,
      postType: "job",
      sourceName: "Happy Monday",
      timeoutMs: Number(env.HAPPY_MONDAY_TIMEOUT_MS || env.HAPPYMONDAY_TIMEOUT_MS || 15000),
      limitEnvNames: ["HAPPY_MONDAY_DETAIL_LIMIT", "HAPPYMONDAY_DETAIL_LIMIT"],
      defaultLimit: 5,
      enrich: enrichHappyMondayEntry,
    });
    const candidates = enrichedEntries
      .filter(Boolean)
      .map((entry) => entry.candidate)
      .filter((job) => profileMatchesCandidate(searchProfile, job))
      .filter((job) => !jobContainsExcludedTerm(job, exclusions));

    return {
      totalCount: candidates.length,
      candidates,
    };
  }

  async function fetchLobbyXCandidates(searchProfile = {}) {
    const baseUrl = env.LOBBYX_BASE_URL || env.LOBBY_X_BASE_URL || "https://thelobbyx.com";
    const searchUrl = env.LOBBYX_FEED_URL ||
      env.LOBBY_X_FEED_URL ||
      buildWordPressSearchUrl(baseUrl, "tors", searchProfile);
    if (!searchUrl) {
      return {
        needsProfile: true,
        candidates: [],
      };
    }

    const data = await wordpressSearchRequest(searchUrl, Number(env.LOBBYX_TIMEOUT_MS || env.LOBBY_X_TIMEOUT_MS || 15000), "Lobby X");
    const exclusions = profileBlockedTerms(searchProfile);
    const entries = data
      .filter((item) => !item.subtype || item.subtype === "tors")
      .map((item) => ({
        item,
        candidate: lobbyXItemToCandidate(item, searchProfile),
      }))
      .filter((entry) => entry.candidate)
      .filter((entry) => profileMatchesCandidate(searchProfile, entry.candidate))
      .filter((entry) => !jobContainsExcludedTerm(entry.candidate, exclusions));
    const enrichedEntries = await enrichWordPressEntries(entries, {
      baseUrl,
      postType: "tors",
      sourceName: "Lobby X",
      timeoutMs: Number(env.LOBBYX_TIMEOUT_MS || env.LOBBY_X_TIMEOUT_MS || 15000),
      limitEnvNames: ["LOBBYX_DETAIL_LIMIT", "LOBBY_X_DETAIL_LIMIT"],
      defaultLimit: 5,
      enrich: enrichLobbyXEntry,
    });
    const candidates = enrichedEntries
      .filter(Boolean)
      .map((entry) => entry.candidate)
      .filter((job) => profileMatchesCandidate(searchProfile, job))
      .filter((job) => !jobContainsExcludedTerm(job, exclusions));

    return {
      totalCount: candidates.length,
      candidates,
    };
  }

  function sourceErrorCode(error) {
    const message = String(error?.message || "").toLowerCase();
    if (error?.name === "AbortError" || message.includes("abort") || message.includes("timeout")) return "timeout";
    if (message.includes("api_key") || message.includes("missing") || message.includes("config")) return "missing_config";
    if (message.includes("non-json") || message.includes("did not include") || message.includes("invalid")) return "invalid_response";
    if (message.includes("request failed") || message.includes("feed request failed")) return "http_error";
    return "source_error";
  }

  async function fetchCandidatesFromSources(searchProfile = {}) {
    const sourceFetchers = [
      ["jooble", fetchJoobleCandidates],
      ["dou", fetchDouCandidates],
      ["djinni", fetchDjinniCandidates],
      ["workua", fetchWorkUaCandidates],
      ["robotaua", fetchRobotaUaCandidates],
      ["jobsua", fetchJobsUaCandidates],
      ["olxua", fetchOlxUaCandidates],
      ["happymonday", fetchHappyMondayCandidates],
      ["lobbyx", fetchLobbyXCandidates],
    ];
    const candidates = [];
    const failures = [];
    const sourceReports = [];
    let needsProfile = false;
    const checkedAt = new Date().toISOString();

    for (const [source, fetcher] of sourceFetchers) {
      const startedAt = Date.now();
      try {
        const result = await fetcher(searchProfile);
        if (result.needsProfile) needsProfile = true;
        const sourceCandidates = result.candidates || [];
        candidates.push(...sourceCandidates);
        sourceReports.push({
          source,
          status: result.needsProfile ? "needs_profile" : "ok",
          count: sourceCandidates.length,
          totalCount: Number.isFinite(result.totalCount) ? result.totalCount : sourceCandidates.length,
          durationMs: Date.now() - startedAt,
          checkedAt,
        });
      } catch (error) {
        logger.error?.(`[bot] ${source} source failed: ${error.message}`);
        failures.push(source);
        sourceReports.push({
          source,
          status: "failed",
          count: 0,
          totalCount: 0,
          errorCode: sourceErrorCode(error),
          durationMs: Date.now() - startedAt,
          checkedAt,
        });
      }
    }

    return {
      needsProfile,
      candidates,
      failures,
      sourceReports,
      summary: {
        checkedAt,
        okSources: sourceReports.filter((report) => report.status === "ok").length,
        failedSources: sourceReports.filter((report) => report.status === "failed").length,
        totalCandidates: candidates.length,
      },
    };
  }

  return {
    djinniItemToCandidate,
    douItemToCandidate,
    fetchCandidatesFromSources,
    fetchDjinniCandidates,
    fetchDouCandidates,
    fetchHappyMondayCandidates,
    fetchJoobleCandidates,
    fetchJobsUaCandidates,
    fetchLobbyXCandidates,
    fetchOlxUaCandidates,
    fetchRobotaUaCandidates,
    fetchWorkUaCandidates,
    happyMondayItemToCandidate,
    joobleRequest,
    jobsUaJobToCandidate,
    lobbyXItemToCandidate,
    olxUaJobToCandidate,
    parseJobsUaHtml,
    parseOlxUaHtml,
    parseRobotaUaHtml,
    parseWorkUaHtml,
    robotaUaJobToCandidate,
    rssFeedRequest,
    splitDjinniTitle,
    splitDouTitle,
    workUaJobToCandidate,
  };
}

module.exports = {
  createJobSources,
};
