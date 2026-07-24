const DIGEST_SLOTS = ["09:00", "13:00", "21:00"];
const DEFAULT_TIMEZONE = "Europe/Kiev";
const PROFILE_STATUSES = new Set(["draft", "active", "needs_review"]);

const TOKEN_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "про",
  "для",
  "или",
  "та",
  "менеджер",
  "manager",
  "спеціаліст",
  "специалист",
]);

const DEDUP_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "a",
  "an",
  "job",
  "jobs",
  "vacancy",
  "вакансія",
  "вакансия",
  "робота",
  "работа",
  "гаряча",
  "горячая",
  "remote",
  "remotely",
  "віддалено",
  "віддалена",
  "удаленно",
  "удаленная",
]);

const UNKNOWN_VALUES = new Set([
  "",
  "не указано",
  "не вказано",
  "not specified",
  "unknown",
  "n/a",
]);

function nowIso() {
  return new Date().toISOString();
}

function makeShortId(prefix = "j") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function splitList(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .match(/[\p{L}\p{N}+#.]{3,}/gu)?.filter((token) => !TOKEN_STOPWORDS.has(token)) || [];
}

function uniqueTokens(value) {
  return [...new Set(tokenize(value))];
}

function tokenOverlapScore(leftTokens, rightTokens, pointsPerToken, maxPoints) {
  if (!leftTokens.length || !rightTokens.length) return 0;
  const right = new Set(rightTokens);
  const overlap = leftTokens.filter((token) => right.has(token)).length;
  return Math.min(maxPoints, overlap * pointsPerToken);
}

function isEmptyValue(value) {
  return value === undefined || value === null || value === "";
}

function normalizeSalary(value) {
  const raw = value.trim();
  const lowered = raw.toLowerCase();

  if (["не важно", "неважно", "любая", "любой", "skip", "-"].includes(lowered)) {
    return {
      raw,
      amount: null,
      currency: null,
      negotiable: true,
    };
  }

  const amountMatch = raw.match(/\d[\d\s,.]*/);
  const amount = amountMatch
    ? Number(amountMatch[0].replace(/\s/g, "").replace(",", "."))
    : null;

  let currency = null;
  if (/\$|usd|дол/i.test(raw)) currency = "USD";
  if (/€|eur|евр/i.test(raw)) currency = "EUR";
  if (/грн|uah|₴/i.test(raw)) currency = "UAH";

  return {
    raw,
    amount,
    currency,
    negotiable: false,
  };
}

function salaryAmountForSearch(value) {
  if (!value || typeof value !== "object" || value.negotiable || !value.amount) return null;
  if (value.currency && value.currency !== "UAH") return null;
  return Math.round(value.amount);
}

function parseSalaryText(value) {
  const raw = String(value || "");
  const numbers = raw.match(/\d[\d\s,.]*/g)?.map((item) => Number(item.replace(/\s/g, "").replace(",", "."))).filter(Number.isFinite) || [];
  let currency = null;
  if (/\$|usd|дол/i.test(raw)) currency = "USD";
  if (/€|eur|евр/i.test(raw)) currency = "EUR";
  if (/грн|uah|₴/i.test(raw)) currency = "UAH";

  return {
    raw,
    min: numbers.length ? Math.min(...numbers) : null,
    max: numbers.length ? Math.max(...numbers) : null,
    currency,
  };
}

function profileHasSearchData(profile = {}) {
  return Object.keys(profile).some((key) => {
    if (["status", "updatedAt", "source", "resumeId"].includes(key)) return false;
    const value = profile[key];
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "object" && value) return Object.values(value).some((item) => !isEmptyValue(item));
    return !isEmptyValue(value);
  });
}

function normalizeSearchProfile(profile = {}) {
  if (!profile || typeof profile !== "object") return {};
  const normalized = {
    ...profile,
    mustHave: Array.isArray(profile.mustHave) ? profile.mustHave : splitList(profile.mustHave || ""),
    niceToHave: Array.isArray(profile.niceToHave) ? profile.niceToHave : splitList(profile.niceToHave || ""),
    exclusions: Array.isArray(profile.exclusions) ? profile.exclusions : splitList(profile.exclusions || ""),
    hiddenCompanies: Array.isArray(profile.hiddenCompanies) ? profile.hiddenCompanies : splitList(profile.hiddenCompanies || ""),
  };

  if (!PROFILE_STATUSES.has(normalized.status)) {
    normalized.status = profileHasSearchData(normalized) ? "active" : "draft";
  }

  return normalized;
}

function defaultLearnedPreferences() {
  return {
    preferredKeywords: [],
    avoidedKeywords: [],
    preferredCompanies: [],
    avoidedCompanies: [],
    pendingSuggestions: [],
    confirmedSuggestions: [],
    dismissedSuggestions: [],
    formatWeight: 1,
    salaryWeight: 1,
    domainWeight: 1,
    seniorityWeight: 1,
    feedbackSignalsCount: 0,
    updatedAt: null,
  };
}

function defaultDigestSettings() {
  return {
    enabled: true,
    timezone: DEFAULT_TIMEZONE,
    slots: [...DIGEST_SLOTS],
    lastRunSlots: {},
  };
}

function ensureUserCollections(user) {
  user.searchProfile = normalizeSearchProfile(user.searchProfile || {});
  user.sentJobs = Array.isArray(user.sentJobs) ? user.sentJobs : [];
  user.jobFeedback = Array.isArray(user.jobFeedback) ? user.jobFeedback : [];
  user.foundJobs = Array.isArray(user.foundJobs) ? user.foundJobs : [];
  user.learnedPreferences = {
    ...defaultLearnedPreferences(),
    ...(user.learnedPreferences || {}),
  };
  user.learnedPreferences.pendingSuggestions = Array.isArray(user.learnedPreferences.pendingSuggestions)
    ? user.learnedPreferences.pendingSuggestions
    : [];
  user.learnedPreferences.confirmedSuggestions = Array.isArray(user.learnedPreferences.confirmedSuggestions)
    ? user.learnedPreferences.confirmedSuggestions
    : [];
  user.learnedPreferences.dismissedSuggestions = Array.isArray(user.learnedPreferences.dismissedSuggestions)
    ? user.learnedPreferences.dismissedSuggestions
    : [];
  user.digestSettings = {
    ...defaultDigestSettings(),
    ...(user.digestSettings || {}),
    slots: Array.isArray(user.digestSettings?.slots) && user.digestSettings.slots.length
      ? user.digestSettings.slots
      : [...DIGEST_SLOTS],
    lastRunSlots: user.digestSettings?.lastRunSlots || {},
  };
  return user;
}

function localDateTimeParts(date = new Date(), timezone = DEFAULT_TIMEZONE) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || DEFAULT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

function dueDigestSlot(user, date = new Date()) {
  ensureUserCollections(user);
  const settings = user.digestSettings;
  if (!settings.enabled) return null;

  const current = localDateTimeParts(date, settings.timezone);
  if (!settings.slots.includes(current.time)) return null;

  const slotKey = `${current.date} ${current.time}`;
  if (settings.lastRunSlots[slotKey]) return null;

  return {
    slot: current.time,
    slotKey,
    date: current.date,
  };
}

function normalizeSourceUrl(value) {
  const rawValue = String(value || "").trim();
  if (!rawValue || rawValue.length > 2048) return null;

  try {
    const parsed = new URL(rawValue);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    if (!parsed.hostname || /\/wp-json(?:\/|$)/i.test(parsed.pathname)) return null;
    if (parsed.pathname === "/" && !parsed.search) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeJobLocation(value) {
  const location = String(value || "").replace(/\s+/g, " ").trim();
  if (!location) return "не указано";

  const firstPart = location.split(/(?<=[.!?])\s+|[·|•]\s*/u)[0]?.trim();
  if (
    firstPart &&
    firstPart !== location &&
    /(?:remote|віддал|удален|hybrid|гібрид|office|офіс|ukraine|україна|kyiv|київ|lviv|львів|dnipro|дніпро|odesa|одеса)/i.test(firstPart)
  ) {
    return firstPart;
  }

  if (location.length <= 120) return location;
  if (firstPart && firstPart.length <= 120) return firstPart;
  return `${location.slice(0, 117).trimEnd()}...`;
}

function normalizeJobCandidate(candidate) {
  const sourceUrl = normalizeSourceUrl(candidate.sourceUrl || candidate.url || candidate.source_url);
  if (!candidate.title || !sourceUrl) return null;

  return {
    shortId: candidate.shortId || makeShortId("j"),
    externalId: candidate.externalId || candidate.external_id || null,
    source: candidate.source || "unknown",
    sourceUrl,
    title: candidate.title,
    company: candidate.company || "не указано",
    location: normalizeJobLocation(candidate.location),
    format: candidate.format || "не указано",
    salary: candidate.salary || "не указано",
    description: candidate.description || "",
    matchSummary: candidate.matchSummary || "",
    reasons: Array.isArray(candidate.reasons) ? candidate.reasons.filter(Boolean) : [],
    risks: Array.isArray(candidate.risks) ? candidate.risks.filter(Boolean) : [],
    score: Number.isFinite(candidate.score) ? candidate.score : null,
    availability: ["open", "closed", "unknown"].includes(candidate.availability) ? candidate.availability : "unknown",
    availabilityCheckedAt: candidate.availabilityCheckedAt || null,
    availabilityReason: candidate.availabilityReason || null,
    enrichedAt: candidate.enrichedAt || null,
    detailStatusCode: Number.isFinite(candidate.detailStatusCode) ? candidate.detailStatusCode : null,
  };
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

function comparableTokens(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}+#.]+/gu, " ");

  return normalized
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !DEDUP_STOPWORDS.has(token));
}

function normalizedComparableValue(value) {
  return comparableTokens(value).join(" ");
}

function isInformativeValue(value) {
  return !UNKNOWN_VALUES.has(String(value || "").toLowerCase().replace(/\s+/g, " ").trim());
}

function tokenSimilarity(leftValue, rightValue) {
  const left = new Set(comparableTokens(leftValue));
  const right = new Set(comparableTokens(rightValue));
  if (!left.size || !right.size) return 0;

  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }

  return overlap / Math.max(left.size, right.size);
}

function valuesAreSimilar(leftValue, rightValue, threshold = 0.75) {
  if (!isInformativeValue(leftValue) || !isInformativeValue(rightValue)) return false;
  const left = normalizedComparableValue(leftValue);
  const right = normalizedComparableValue(rightValue);
  if (!left || !right) return false;
  const shorterLength = Math.min(left.length, right.length);
  if (left === right || (shorterLength >= 4 && (left.includes(right) || right.includes(left)))) return true;
  return tokenSimilarity(left, right) >= threshold;
}

function jobsAreLikelySame(leftJob, rightJob) {
  if (!leftJob || !rightJob) return false;
  if (leftJob.sourceUrl && rightJob.sourceUrl && leftJob.sourceUrl === rightJob.sourceUrl) return true;
  if (
    leftJob.externalId &&
    rightJob.externalId &&
    leftJob.externalId === rightJob.externalId &&
    leftJob.source === rightJob.source
  ) {
    return true;
  }
  if (canonicalJobKey(leftJob) === canonicalJobKey(rightJob)) return true;

  const titleSimilarity = tokenSimilarity(leftJob.title, rightJob.title);
  if (titleSimilarity < 0.66) return false;

  const leftCompany = leftJob.company;
  const rightCompany = rightJob.company;
  const bothCompaniesKnown = isInformativeValue(leftCompany) && isInformativeValue(rightCompany);
  if (bothCompaniesKnown && valuesAreSimilar(leftCompany, rightCompany, 0.75)) {
    return titleSimilarity >= 0.66;
  }

  return false;
}

function inferWorkFormat(job) {
  const text = [
    job.type,
    job.title,
    job.location,
    job.snippet,
    job.description,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (/remote|віддал|удален|remotely|work from home/.test(text)) return "Remote";
  if (/hybrid|гібрид|гибрид/.test(text)) return "Hybrid";
  if (/office|офіс|офис/.test(text)) return "Office";
  return job.type || "не указано";
}

function lowerList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).toLowerCase()).filter(Boolean);
  return splitList(String(value || "")).map((item) => item.toLowerCase());
}

function profileBlockedTerms(searchProfile = {}) {
  return [
    ...lowerList(searchProfile.exclusions),
    ...lowerList(searchProfile.hiddenCompanies),
  ];
}

function jobContainsExcludedTerm(job, exclusions) {
  if (!exclusions.length) return false;
  const text = jobSearchText(job);
  return exclusions.some((term) => term && text.includes(term));
}

function hiddenCompanyMatches(candidate, searchProfile = {}) {
  const hiddenCompanies = lowerList(searchProfile.hiddenCompanies);
  const company = String(candidate.company || "").toLowerCase();
  return hiddenCompanies.some((companyName) => companyName && company.includes(companyName));
}

function scorePreferenceTerms(candidate, profile) {
  const candidateTokens = uniqueTokens(`${candidate.title} ${candidate.company} ${candidate.description}`);
  const mustHaveTokens = uniqueTokens(lowerList(profile.mustHave).join(" "));
  const niceToHaveTokens = uniqueTokens(lowerList(profile.niceToHave).join(" "));
  const mustHaveScore = tokenOverlapScore(mustHaveTokens, candidateTokens, 5, 15);
  const niceToHaveScore = tokenOverlapScore(niceToHaveTokens, candidateTokens, 3, 9);
  const reasons = [];
  const risks = [];

  if (mustHaveTokens.length && mustHaveScore > 0) {
    reasons.push("Есть совпадения с обязательными требованиями профиля.");
  }

  if (mustHaveTokens.length && mustHaveScore === 0) {
    risks.push("Не вижу явного совпадения с обязательными требованиями, стоит проверить.");
  }

  if (niceToHaveScore > 0) {
    reasons.push("Есть совпадения с желательными пунктами профиля.");
  }

  return {
    score: mustHaveScore + niceToHaveScore,
    reasons,
    risks,
  };
}

function jobSearchText(job) {
  return [
    job.title,
    job.company,
    job.location,
    job.description,
    job.snippet,
    job.source,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function jobMatchesMustHave(job, mustHave) {
  if (!mustHave.length) return true;
  const text = jobSearchText(job);
  return mustHave.every((term) => {
    const lowered = String(term || "").toLowerCase().trim();
    if (!lowered) return true;
    return text.includes(lowered) || tokenOverlapScore(uniqueTokens(lowered), uniqueTokens(text), 1, 3) >= Math.min(2, uniqueTokens(lowered).length);
  });
}

function jobMatchesHiddenCompanies(job, hiddenCompanies) {
  if (!hiddenCompanies.length) return true;
  const company = String(job.company || "").toLowerCase();
  return !hiddenCompanies.some((item) => item && company.includes(String(item).toLowerCase()));
}

function jobMatchesHardPreferences(profile, job, user = null) {
  const normalized = normalizeSearchProfile(profile);
  const hiddenCompanies = [
    ...(normalized.hiddenCompanies || []),
    ...(user?.learnedPreferences?.avoidedCompanies || []),
  ];
  return !jobContainsExcludedTerm(job, profileBlockedTerms(normalized)) &&
    jobMatchesMustHave(job, normalized.mustHave || []) &&
    jobMatchesHiddenCompanies(job, hiddenCompanies);
}

function scoreFormat(candidate, profile) {
  const preferred = String(profile.format || "").toLowerCase();
  const format = String(candidate.format || "").toLowerCase();
  const candidateText = `${candidate.title || ""} ${candidate.location || ""} ${candidate.description || ""}`.toLowerCase();
  const isRemote = format.includes("remote") || /remote|віддал|удален/.test(candidateText);
  const isHybrid = format.includes("hybrid") || /hybrid|гібрид|гибрид/.test(candidateText);
  const isOffice = format.includes("office") || /office|офіс|офис/.test(candidateText);

  if (!preferred || preferred.includes("любой") || preferred.includes("будь") || preferred.includes("any")) {
    return { score: 0, risk: null };
  }

  if (preferred.includes("remote")) {
    if (isRemote) return { score: 18, risk: null };
    if (isHybrid && !preferred.includes("только")) return { score: 8, risk: null };
    if (isOffice) return { score: -18, risk: "Формат может не совпадать с предпочтением remote." };
    return { score: -3, risk: "Формат работы нужно проверить в источнике." };
  }

  if (preferred.includes("hybrid") || preferred.includes("гібрид") || preferred.includes("гибрид")) {
    if (isHybrid || isRemote) return { score: 10, risk: null };
    if (isOffice) return { score: -8, risk: "Формат может быть офисным, стоит проверить." };
  }

  if (preferred.includes("office") || preferred.includes("офіс") || preferred.includes("офис")) {
    if (isOffice) return { score: 10, risk: null };
    if (isRemote) return { score: -8, risk: "Вакансия может быть remote, а профиль просит office." };
  }

  return { score: 0, risk: null };
}

function scoreLocation(candidate, profile) {
  const desired = String(profile.location || "").toLowerCase();
  if (!desired) return 0;

  const candidateText = `${candidate.location || ""} ${candidate.description || ""}`.toLowerCase();
  if (/remote|віддал|удален|global/.test(desired) && /remote|віддал|удален/.test(candidateText)) return 12;
  if (desired.includes("ukraine") || desired.includes("укра")) {
    return /ukraine|укра|kyiv|київ|киев|lviv|львів|львов|odesa|одеса|дніпро|dnipro/.test(candidateText) ? 10 : 0;
  }

  const desiredTokens = uniqueTokens(desired);
  return tokenOverlapScore(desiredTokens, uniqueTokens(candidateText), 5, 10);
}

function scoreSalary(candidate, profile) {
  const desired = profile.minSalary;
  if (!desired || typeof desired !== "object" || desired.negotiable || !desired.amount) return { score: 0, risk: null };

  const salary = parseSalaryText(candidate.salary);
  if (!salary.max) return { score: -4, risk: "Зарплата не указана, нужно проверить условия." };
  if (desired.currency && salary.currency && desired.currency !== salary.currency) {
    return { score: 0, risk: "Валюта зарплаты отличается от профиля, без ручной проверки не сравниваю." };
  }
  if (desired.currency && !salary.currency) {
    return { score: 0, risk: "Валюта зарплаты не указана, нужно проверить вручную." };
  }

  if (salary.max < desired.amount) {
    return { score: -25, risk: "Зарплата может быть ниже указанного минимума." };
  }
  if (salary.min && salary.min >= desired.amount) return { score: 12, risk: null };
  return { score: 7, risk: null };
}

function feedbackWeight(signal) {
  if (signal === "s") return 16;
  if (signal === "l") return 10;
  if (signal === "d") return -12;
  if (signal === "h") return -22;
  return 0;
}

function feedbackAdjustmentForCandidate(user, candidate) {
  const sentByShortId = new Map((user.sentJobs || []).map((job) => [job.shortId, job]));
  const candidateTokens = uniqueTokens(`${candidate.title} ${candidate.company} ${candidate.description}`);
  let score = 0;
  let positive = false;
  let negative = false;

  for (const feedback of user.jobFeedback || []) {
    const previousJob = sentByShortId.get(feedback.jobShortId);
    if (!previousJob) continue;

    const weight = feedbackWeight(feedback.signal);
    if (!weight) continue;

    let similarity = 0;
    if (previousJob.company && candidate.company && previousJob.company === candidate.company) similarity += 0.45;
    if (previousJob.source && candidate.source && previousJob.source === candidate.source) similarity += 0.1;
    const previousTokens = uniqueTokens(`${previousJob.title} ${previousJob.company} ${previousJob.description}`);
    const overlap = tokenOverlapScore(candidateTokens, previousTokens, 1, 6);
    similarity += overlap / 12;

    if (similarity <= 0.2) continue;
    const adjustment = Math.round(weight * Math.min(1, similarity));
    score += adjustment;
    if (adjustment > 0) positive = true;
    if (adjustment < 0) negative = true;
  }

  return { score: Math.max(-30, Math.min(24, score)), positive, negative };
}

function scoreLabel(score) {
  if (score >= 70) return "Сильное совпадение";
  if (score >= 45) return "Хорошее совпадение";
  if (score >= 25) return "Есть пересечения";
  return "Стоит проверить вручную";
}

function buildMatchSummary(candidate, profile, score, reasons = [], risks = []) {
  const role = lowerList(profile.roles).find((item) => {
    const title = String(candidate.title || "").toLowerCase();
    return item.length >= 4 && title.includes(item);
  });
  const parts = [];

  if (role) {
    parts.push(`роль похожа на ${role}`);
  } else if (reasons.some((reason) => /роль|название|описание/i.test(reason))) {
    parts.push("есть совпадение с ролью из профиля");
  }

  const format = String(candidate.format || "").toLowerCase();
  const preferredFormat = String(profile.format || "").toLowerCase();
  if (format.includes("remote") || /remote|віддал|удален/.test(`${candidate.location || ""} ${candidate.description || ""}`.toLowerCase())) {
    parts.push(preferredFormat.includes("remote") ? "формат совпадает с remote" : "есть remote-формат");
  }

  if (scoreLocation(candidate, profile) > 0) {
    parts.push("локация похожа на профиль");
  }

  if (scoreSalary(candidate, profile).score > 0) {
    parts.push("зарплата похожа на ожидания");
  }

  if (reasons.some((reason) => /обязатель/i.test(reason))) {
    parts.push("есть обязательные требования");
  } else if (reasons.some((reason) => /желатель/i.test(reason))) {
    parts.push("есть желательные совпадения");
  }

  if (risks.some((risk) => /зарплат/i.test(risk))) {
    parts.push("зарплату нужно проверить");
  }

  const detail = parts.slice(0, 3).join(", ");
  return detail
    ? `${scoreLabel(score)}: ${detail}.`
    : `${scoreLabel(score)}: проверь детали в источнике.`;
}

function scoreCandidateForUser(user, candidate) {
  const profile = user.searchProfile || {};
  const roles = lowerList(profile.roles);
  const titleLower = String(candidate.title || "").toLowerCase();
  const descriptionLower = String(candidate.description || "").toLowerCase();
  const roleTokens = uniqueTokens(roles.join(" "));
  const candidateTokens = uniqueTokens(`${candidate.title} ${candidate.description}`);
  const reasons = [...(candidate.reasons || [])];
  const risks = [...(candidate.risks || [])];
  let score = 0;

  if (roles.some((role) => role.length >= 4 && titleLower.includes(role))) {
    score += 45;
    reasons.unshift("Название вакансии хорошо совпадает с ролью из профиля.");
  } else if (roles.some((role) => role.length >= 4 && descriptionLower.includes(role))) {
    score += 25;
    reasons.unshift("Описание вакансии совпадает с ролью из профиля.");
  } else {
    score += tokenOverlapScore(roleTokens, candidateTokens, 6, 24);
  }

  const formatScore = scoreFormat(candidate, profile);
  score += formatScore.score;
  if (formatScore.risk) risks.push(formatScore.risk);

  score += scoreLocation(candidate, profile);

  const salaryScore = scoreSalary(candidate, profile);
  score += salaryScore.score;
  if (salaryScore.risk) risks.push(salaryScore.risk);

  const preferenceTerms = scorePreferenceTerms(candidate, profile);
  score += preferenceTerms.score;
  reasons.push(...preferenceTerms.reasons);
  risks.push(...preferenceTerms.risks);

  const languageTokens = uniqueTokens(profile.languages || "");
  const languageScore = tokenOverlapScore(languageTokens, candidateTokens, 4, 8);
  if (languageScore > 0) {
    score += languageScore;
    reasons.push("Языковые требования похожи на профиль.");
  }

  const feedback = feedbackAdjustmentForCandidate(user, candidate);
  score += feedback.score;
  if (feedback.positive) reasons.push("Похожа на вакансии, которые ты уже отмечал положительно.");
  if (feedback.negative) risks.push("Похожа на вакансии, которые ты раньше отклонял.");

  return {
    ...candidate,
    score,
    matchSummary: buildMatchSummary(candidate, profile, score, reasons, risks),
    reasons: [...new Set(reasons)].slice(0, 4),
    risks: [...new Set(risks)].slice(0, 4),
  };
}

function rankCandidatesForUser(user, candidates) {
  ensureUserCollections(user);
  return candidates
    .map((candidate, index) => ({
      candidate: scoreCandidateForUser(user, candidate),
      index,
    }))
    .sort((left, right) => {
      const scoreDiff = (right.candidate.score || 0) - (left.candidate.score || 0);
      return scoreDiff || left.index - right.index;
    })
    .map((item) => item.candidate);
}

function profileMatchesCandidate(searchProfile, candidate) {
  const roles = lowerList(searchProfile.roles);
  if (!roles.length) return false;
  const text = `${candidate.title || ""} ${candidate.description || ""}`.toLowerCase();
  const roleTokens = uniqueTokens(roles.join(" "));
  return roles.some((role) => role.length >= 4 && text.includes(role)) ||
    tokenOverlapScore(roleTokens, uniqueTokens(text), 1, 2) >= 2;
}

function buildJoobleQuery(searchProfile = {}) {
  const roles = Array.isArray(searchProfile.roles)
    ? searchProfile.roles.filter(Boolean)
    : splitList(searchProfile.roles || "");
  const keywords = roles.slice(0, 4).join(", ");

  if (!keywords) {
    return null;
  }

  const locationText = String(searchProfile.location || "").trim();
  const firstLocation = splitList(locationText)[0] || locationText;
  const location = /remote|віддал|удален|global|any|любой|будь/i.test(firstLocation)
    ? "Ukraine"
    : firstLocation || "Ukraine";

  const query = {
    keywords,
    location,
    radius: "80",
    page: "1",
    ResultOnPage: "20",
    companysearch: "false",
  };

  const salary = salaryAmountForSearch(searchProfile.minSalary);
  if (salary) query.salary = salary;

  return query;
}

function joobleJobToCandidate(job, searchProfile = {}) {
  const sourceUrl = job.link || job.url || job.sourceUrl;
  if (!job.title || !sourceUrl) return null;

  const reasons = [];
  const risks = [];
  const roles = lowerList(searchProfile.roles);
  const title = String(job.title || "");
  const titleLower = title.toLowerCase();

  if (roles.some((role) => titleLower.includes(role))) {
    reasons.push("Название вакансии совпадает с ролью из профиля поиска.");
  } else {
    reasons.push("Вакансия найдена по ролям из профиля поиска.");
  }

  if (searchProfile.format && inferWorkFormat(job) !== "не указано") {
    reasons.push("Формат работы можно сверить с твоими предпочтениями.");
  }

  if (!job.salary) {
    risks.push("Зарплата не указана в источнике.");
  }

  if (inferWorkFormat(job) === "не указано") {
    risks.push("Формат работы нужно проверить в описании.");
  }

  return {
    source: "jooble",
    externalId: job.id ? String(job.id) : null,
    sourceUrl,
    title,
    company: job.company || "не указано",
    location: job.location || "не указано",
    format: inferWorkFormat(job),
    salary: job.salary || "Не указана",
    description: job.snippet || "",
    reasons,
    risks,
  };
}

function hasJobAlreadyBeenSent(user, job) {
  return user.sentJobs.some((sentJob) => jobsAreLikelySame(job, sentJob));
}

function hasJobAlreadyBeenFound(user, job) {
  return user.foundJobs.some((foundJob) => jobsAreLikelySame(job, foundJob));
}

function storeFoundJobs(user, candidates) {
  ensureUserCollections(user);
  const stored = [];

  for (const candidate of candidates
    .map(normalizeJobCandidate)
    .filter(Boolean)
    .filter((job) => jobMatchesHardPreferences(user.searchProfile || {}, job, user))) {
    if (hasJobAlreadyBeenFound(user, candidate)) continue;
    const foundJob = {
      ...candidate,
      foundAt: nowIso(),
      status: "found",
    };
    user.foundJobs.push(foundJob);
    stored.push(foundJob);
  }

  user.foundJobs = user.foundJobs.slice(-100);
  return stored;
}

function activeFoundJobs(user) {
  ensureUserCollections(user);
  return user.foundJobs.filter((job) => job.status !== "hidden" && job.status !== "dismissed");
}

module.exports = {
  activeFoundJobs,
  buildJoobleQuery,
  canonicalJobKey,
  defaultDigestSettings,
  defaultLearnedPreferences,
  dueDigestSlot,
  ensureUserCollections,
  hiddenCompanyMatches,
  hasJobAlreadyBeenSent,
  inferWorkFormat,
  isEmptyValue,
  jobContainsExcludedTerm,
  jobMatchesHardPreferences,
  jobsAreLikelySame,
  joobleJobToCandidate,
  buildMatchSummary,
  localDateTimeParts,
  lowerList,
  normalizeJobCandidate,
  normalizeJobLocation,
  normalizeSalary,
  normalizeSearchProfile,
  normalizeSourceUrl,
  parseSalaryText,
  profileBlockedTerms,
  profileHasSearchData,
  profileMatchesCandidate,
  rankCandidatesForUser,
  scoreCandidateForUser,
  splitList,
  storeFoundJobs,
  TOKEN_STOPWORDS,
  uniqueTokens,
};
