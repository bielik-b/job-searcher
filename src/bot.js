const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile: execFileCallback } = require("node:child_process");
const { promisify } = require("node:util");
const storage = require("./storage");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const ENV_PATH = path.join(PROJECT_ROOT, ".env");
const DATA_DIR = path.join(PROJECT_ROOT, "data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const USERS_PATH = path.join(DATA_DIR, "users.json");
const STATE_PATH = path.join(DATA_DIR, "bot-state.json");
const EXTRACT_SCRIPT_PATH = path.join(PROJECT_ROOT, "scripts", "extract_resume_text.py");
const execFile = promisify(execFileCallback);

const START_KEYBOARD = [
  ["Загрузить резюме"],
  ["Найти вакансии сейчас", "Показать найденные"],
  ["Заполнить профиль вручную", "Показать профиль"],
];

const RESUME_REVIEW_KEYBOARD = [
  ["Все верно, создать профиль"],
  ["Дополнить профиль"],
  ["Загрузить другое резюме"],
  ["Отмена"],
];

const RESUME_CONSENT_KEYBOARD = [
  ["Анализировать резюме"],
  ["Отмена"],
];

const REVIEW_KEYBOARD = [
  ["Сохранить", "Начать заново"],
  ["Изменить роли", "Изменить локацию"],
  ["Изменить формат", "Изменить зарплату"],
  ["Изменить языки", "Изменить исключения"],
  ["Изменить обязательное", "Изменить желательное"],
  ["Изменить скрытые компании"],
  ["Отмена"],
];

const FEEDBACK_SIGNALS = {
  l: "Подходит",
  d: "Не подходит",
  h: "Скрыть похожие",
  s: "Сохранить",
};

const FEEDBACK_STATUS_BY_SIGNAL = {
  l: "liked",
  d: "dismissed",
  h: "hidden",
  s: "saved",
};

const DIGEST_SLOTS = ["09:00", "13:00", "21:00"];
const DEFAULT_TIMEZONE = "Europe/Kiev";
const SCHEDULER_INTERVAL_MS = 60 * 1000;
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

const PREFERENCE_FIELDS = [
  {
    key: "roles",
    label: "Роли",
    question:
      "Какие роли искать? Напиши коротко, через запятую.\n\nНапример: Product Manager, AI Product Manager, Product Owner",
  },
  {
    key: "location",
    label: "Локация",
    question:
      "Где искать вакансии? Напиши города, страны или remote-зону.\n\nНапример: Украина, Киев, Европа, global remote",
  },
  {
    key: "format",
    label: "Формат",
    question: "Какой формат работы подходит?",
    keyboard: [
      ["Только remote", "Remote или hybrid"],
      ["Office", "Любой"],
    ],
  },
  {
    key: "minSalary",
    label: "Минимальная зарплата",
    question:
      "Какая минимальная зарплата? Можно число с валютой или 'не важно'.\n\nНапример: $2500, 100000 грн, не важно",
  },
  {
    key: "languages",
    label: "Языки",
    question:
      "Какие языки учитывать? Напиши свободно или списком.\n\nНапример: Ukrainian native, English B2, Russian fluent",
  },
  {
    key: "mustHave",
    label: "Обязательно",
    question:
      "Что обязательно должно быть в вакансии? Напиши через запятую или Пропустить.\n\nНапример: remote, SaaS, B2B, бронь",
  },
  {
    key: "niceToHave",
    label: "Желательно",
    question:
      "Что будет плюсом, но не обязательно? Напиши через запятую или Пропустить.\n\nНапример: startup, AI products, international team",
  },
  {
    key: "exclusions",
    label: "Что не предлагать",
    question:
      "Что не предлагать? Укажи сферы, компании, слова или типы вакансий через запятую.\n\nНапример: casino, adult, cold sales, MLM",
  },
  {
    key: "hiddenCompanies",
    label: "Скрытые компании",
    question:
      "Какие компании не показывать? Напиши через запятую или Пропустить.\n\nНапример: Company A, Company B",
  },
];

const FIELD_BY_EDIT_TEXT = new Map([
  ["Изменить роли", "roles"],
  ["Изменить локацию", "location"],
  ["Изменить формат", "format"],
  ["Изменить зарплату", "minSalary"],
  ["Изменить языки", "languages"],
  ["Изменить обязательное", "mustHave"],
  ["Изменить желательное", "niceToHave"],
  ["Изменить исключения", "exclusions"],
  ["Изменить скрытые компании", "hiddenCompanies"],
]);

let writeQueue = Promise.resolve();

function loadEnvFile(content) {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

async function loadEnv() {
  try {
    const content = await fs.readFile(ENV_PATH, "utf8");
    loadEnvFile(content);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function ensureStorage() {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await fs.mkdir(UPLOADS_DIR, { recursive: true, mode: 0o700 });
  await fs.chmod(DATA_DIR, 0o700);
  await fs.chmod(UPLOADS_DIR, 0o700);
  await storage.initializeStorage({
    dataDir: DATA_DIR,
    usersJsonPath: USERS_PATH,
    stateJsonPath: STATE_PATH,
  });
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(filePath, value) {
  const operation = async () => {
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    });
    await fs.rename(tmpPath, filePath);
    await fs.chmod(filePath, 0o600);
  };

  writeQueue = writeQueue.then(operation, operation);
  return writeQueue;
}

async function getUser(userId) {
  return storage.getUser(userId);
}

async function saveUser(user) {
  await storage.saveUser(user);
}

async function deleteUser(userId) {
  await storage.deleteUser(userId);
}

async function listDigestUsers() {
  return storage.listDigestUsers();
}

async function saveCurrentUser(user) {
  await saveUser(user);
}

async function loadBotState() {
  return storage.loadBotState();
}

async function saveBotState(state) {
  await storage.saveBotState(state);
}

function nowIso() {
  return new Date().toISOString();
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

function normalizeAnswer(fieldKey, value) {
  const trimmed = value.trim();

  if (
    fieldKey === "roles" ||
    fieldKey === "exclusions" ||
    fieldKey === "mustHave" ||
    fieldKey === "niceToHave" ||
    fieldKey === "hiddenCompanies"
  ) {
    return splitList(trimmed);
  }

  if (fieldKey === "format") {
    return trimmed;
  }

  if (fieldKey === "minSalary") {
    return normalizeSalary(trimmed);
  }

  return trimmed;
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

function normalizeResumeAnalysis(raw) {
  const profile = raw?.searchProfile || {};
  return {
    resumeFacts: {
      headline: raw?.resumeFacts?.headline || "",
      seniority: raw?.resumeFacts?.seniority || "",
      yearsExperience: raw?.resumeFacts?.yearsExperience || null,
      roles: Array.isArray(raw?.resumeFacts?.roles) ? raw.resumeFacts.roles : [],
      skills: Array.isArray(raw?.resumeFacts?.skills) ? raw.resumeFacts.skills : [],
      industries: Array.isArray(raw?.resumeFacts?.industries) ? raw.resumeFacts.industries : [],
      languages: Array.isArray(raw?.resumeFacts?.languages) ? raw.resumeFacts.languages : [],
      summary: raw?.resumeFacts?.summary || "",
    },
    searchProfile: {
      roles: Array.isArray(profile.roles) ? profile.roles : [],
      location: profile.location || "",
      format: profile.format || "",
      minSalary: profile.minSalary ? normalizeSalary(String(profile.minSalary)) : undefined,
      languages: profile.languages || "",
      mustHave: Array.isArray(profile.mustHave) ? profile.mustHave : [],
      niceToHave: Array.isArray(profile.niceToHave) ? profile.niceToHave : [],
      exclusions: Array.isArray(profile.exclusions) ? profile.exclusions : [],
      hiddenCompanies: Array.isArray(profile.hiddenCompanies) ? profile.hiddenCompanies : [],
      status: "needs_review",
    },
    questions: Array.isArray(raw?.questions) ? raw.questions.slice(0, 5) : [],
    confidence: typeof raw?.confidence === "number" ? raw.confidence : null,
    analysisSource: raw?.analysisSource || "llm",
    analysisModel: raw?.analysisModel || null,
  };
}

function parseJsonObject(text) {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error("LLM output is not valid JSON");
  }
}

function localResumeAnalysis(text) {
  const lower = text.toLowerCase();
  const roleHints = [
    "Support specialist",
    "Client support manager",
    "Customer support specialist",
    "Logistics specialist",
    "Спеціаліст з логістики",
    "Lead generation manager",
    "Java developer",
    "Junior Java developer",
  ];
  const skillHints = [
    "Java",
    "Git",
    "Maven",
    "Spring Framework",
    "Spring Boot",
    "OOP",
    "JDBC",
    "MS Excel",
    "SAP",
    "REST",
    "JUnit",
    "Mockito",
    "Selenium",
    "Customer support",
    "Lead generation",
    "Logistics",
  ];
  const industryHints = ["IT", "Electronics", "Logistics", "Customer Support", "Lead Generation"];
  const languageHints = [
    ["англійська", "English"],
    ["польська", "Polish"],
    ["російська", "Russian"],
    ["українська", "Ukrainian"],
  ];

  const roles = roleHints.filter((role) => lower.includes(role.toLowerCase()));
  const skills = skillHints.filter((skill) => lower.includes(skill.toLowerCase()));
  const languages = languageHints
    .filter(([needle]) => lower.includes(needle))
    .map(([, label]) => label);
  const industries = industryHints.filter((industry) => lower.includes(industry.toLowerCase()));

  const supportRole = roles.find((role) => /support/i.test(role));
  const javaRole = skills.some((skill) => /java|spring/i.test(skill)) ? "Junior Java Developer" : null;

  return normalizeResumeAnalysis({
    resumeFacts: {
      headline: supportRole || javaRole || roles[0] || "Candidate",
      seniority: "junior/middle",
      yearsExperience: lower.includes("3 роки 10 місяців") ? 3.8 : null,
      roles,
      skills,
      industries,
      languages,
      summary:
        "Local parser extracted a draft from resume text. LLM provider was unavailable or not selected.",
    },
    searchProfile: {
      roles: [supportRole, javaRole].filter(Boolean),
      location: "Ukraine / Remote",
      format: "Remote или hybrid",
      minSalary: "",
      languages: languages.join(", "),
      mustHave: [],
      niceToHave: [],
      exclusions: [],
      hiddenCompanies: [],
    },
    questions: [
      "Какие роли приоритетнее: support/logistics или junior Java?",
      "Какая минимальная зарплата и валюта?",
      "Рассматривать только remote или hybrid тоже подходит?",
      "Какие сферы точно не предлагать?",
    ],
    confidence: 0.55,
    analysisSource: "local_fallback",
    analysisModel: "local_basic_rules",
  });
}

function formatValue(value) {
  if (Array.isArray(value)) return value.length ? value.join(", ") : "не указано";
  if (typeof value === "object" && value) {
    if (value.negotiable) return "не важно";
    return value.raw || "не указано";
  }
  return isEmptyValue(value) ? "не указано" : String(value);
}

function formatProfile(profile = {}) {
  const normalized = normalizeSearchProfile(profile);
  const statusLabel = normalized.status === "active"
    ? "активен"
    : normalized.status === "needs_review"
      ? "нужно уточнить"
      : "черновик";
  return [
    "Текущий профиль поиска:",
    "",
    `Статус: ${statusLabel}`,
    `Роли: ${formatValue(normalized.roles)}`,
    `Локация: ${formatValue(normalized.location)}`,
    `Формат: ${formatValue(normalized.format)}`,
    `Минимальная зарплата: ${formatValue(normalized.minSalary)}`,
    `Языки: ${formatValue(normalized.languages)}`,
    `Обязательно: ${formatValue(normalized.mustHave)}`,
    `Желательно: ${formatValue(normalized.niceToHave)}`,
    `Что не предлагать: ${formatValue(normalized.exclusions)}`,
    `Скрытые компании: ${formatValue(normalized.hiddenCompanies)}`,
  ].join("\n");
}

function formatResumeAnalysis(analysis) {
  const facts = analysis.resumeFacts || {};
  const profile = analysis.searchProfile || {};
  const questions = analysis.questions?.length
    ? `\n\nЧто стоит уточнить:\n${analysis.questions.map((item) => `- ${item}`).join("\n")}`
    : "";

  return [
    "Я составил черновик профиля поиска по резюме.",
    "",
    "Что понял из резюме:",
    `Позиционирование: ${formatValue(facts.headline)}`,
    `Уровень: ${formatValue(facts.seniority)}`,
    `Опыт: ${formatValue(facts.yearsExperience)}`,
    `Роли из опыта: ${formatValue(facts.roles)}`,
    `Навыки: ${formatValue(facts.skills)}`,
    `Индустрии: ${formatValue(facts.industries)}`,
    `Языки: ${formatValue(facts.languages)}`,
    "",
    "Черновик профиля поиска:",
    `Роли: ${formatValue(profile.roles)}`,
    `Локация: ${formatValue(profile.location)}`,
    `Формат: ${formatValue(profile.format)}`,
    `Минимальная зарплата: ${formatValue(profile.minSalary)}`,
    `Языки: ${formatValue(profile.languages)}`,
    `Обязательно: ${formatValue(profile.mustHave)}`,
    `Желательно: ${formatValue(profile.niceToHave)}`,
    `Что не предлагать: ${formatValue(profile.exclusions)}`,
    `Скрытые компании: ${formatValue(profile.hiddenCompanies)}`,
    questions,
  ].join("\n");
}

function makeShortId(prefix = "j") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeJobCandidate(candidate) {
  const sourceUrl = candidate.sourceUrl || candidate.url || candidate.source_url;
  if (!candidate.title || !sourceUrl) return null;

  return {
    shortId: candidate.shortId || makeShortId("j"),
    externalId: candidate.externalId || candidate.external_id || null,
    source: candidate.source || "unknown",
    sourceUrl,
    title: candidate.title,
    company: candidate.company || "не указано",
    location: candidate.location || "не указано",
    format: candidate.format || "не указано",
    salary: candidate.salary || "не указано",
    description: candidate.description || "",
    reasons: Array.isArray(candidate.reasons) ? candidate.reasons.filter(Boolean) : [],
    risks: Array.isArray(candidate.risks) ? candidate.risks.filter(Boolean) : [],
    score: Number.isFinite(candidate.score) ? candidate.score : null,
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

function decodeXmlEntities(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
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
  return decodeXmlEntities(String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
}

function xmlTagValue(itemXml, tagName) {
  const match = itemXml.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match ? decodeXmlEntities(match[1]) : "";
}

function parseRssItems(xml) {
  return [...String(xml || "").matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((match) => {
    const itemXml = match[1];
    return {
      title: stripHtml(xmlTagValue(itemXml, "title")),
      link: stripHtml(xmlTagValue(itemXml, "link")),
      description: stripHtml(xmlTagValue(itemXml, "description")),
      pubDate: stripHtml(xmlTagValue(itemXml, "pubDate")),
      guid: stripHtml(xmlTagValue(itemXml, "guid")),
    };
  });
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

function formatListSection(title, items) {
  if (!items?.length) return `${title}\n- не указано`;
  return `${title}\n${items.map((item) => `- ${item}`).join("\n")}`;
}

function formatVacancyMessage(sentJob) {
  return [
    sentJob.title,
    `Компания: ${formatValue(sentJob.company)}`,
    `Локация: ${formatValue(sentJob.location)}`,
    `Формат: ${formatValue(sentJob.format)}`,
    `Зарплата: ${formatValue(sentJob.salary)}`,
    "",
    formatListSection("Почему может подойти:", sentJob.reasons),
    "",
    formatListSection("Что проверить:", sentJob.risks),
    "",
    `Источник: ${sentJob.sourceUrl}`,
  ].join("\n");
}

function jobFeedbackKeyboard(shortId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: FEEDBACK_SIGNALS.l, callback_data: `j:l:${shortId}` },
          { text: FEEDBACK_SIGNALS.d, callback_data: `j:d:${shortId}` },
        ],
        [
          { text: FEEDBACK_SIGNALS.s, callback_data: `j:s:${shortId}` },
          { text: FEEDBACK_SIGNALS.h, callback_data: `j:h:${shortId}` },
        ],
      ],
    },
  };
}

function preferenceSuggestionKeyboard(suggestionId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Да, скрыть", callback_data: `lp:a:${suggestionId}` },
          { text: "Оставить как есть", callback_data: `lp:k:${suggestionId}` },
        ],
      ],
    },
  };
}

function createSentJob(user, candidate, searchProfile = {}) {
  const normalized = normalizeJobCandidate(candidate);
  if (!normalized) return null;

  return {
    ...normalized,
    userId: user.id,
    telegramUserId: user.telegramUserId,
    searchProfileUpdatedAt: searchProfile.updatedAt || null,
    sentAt: nowIso(),
    messageId: null,
    status: "sent",
    feedback: null,
    feedbackUpdatedAt: null,
  };
}

function hasJobAlreadyBeenSent(user, job) {
  const key = canonicalJobKey(job);
  return user.sentJobs.some((sentJob) => {
    if (job.externalId && sentJob.externalId === job.externalId && sentJob.source === job.source) return true;
    return sentJob.sourceUrl === job.sourceUrl || canonicalJobKey(sentJob) === key;
  });
}

function hasJobAlreadyBeenFound(user, job) {
  const key = canonicalJobKey(job);
  return user.foundJobs.some((foundJob) => {
    if (job.externalId && foundJob.externalId === job.externalId && foundJob.source === job.source) return true;
    return foundJob.sourceUrl === job.sourceUrl || canonicalJobKey(foundJob) === key;
  });
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

function getFeedbackStats(user) {
  const feedback = user.jobFeedback || [];
  return {
    total: feedback.length,
    positive: feedback.filter((item) => item.signal === "l" || item.signal === "s").length,
    negative: feedback.filter((item) => item.signal === "d" || item.signal === "h").length,
  };
}

function countBy(items, getKey) {
  const counts = new Map();
  for (const item of items) {
    const key = getKey(item);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1]);
}

function activeSuggestionKeys(user) {
  const learned = user.learnedPreferences || {};
  return new Set([
    ...(learned.pendingSuggestions || []),
    ...(learned.confirmedSuggestions || []),
    ...(learned.dismissedSuggestions || []),
  ].map((suggestion) => `${suggestion.type}:${String(suggestion.value || "").toLowerCase()}`));
}

function createLearningSuggestion(type, value, text) {
  return {
    id: makeShortId("p"),
    type,
    value,
    text,
    status: "pending",
    createdAt: nowIso(),
  };
}

function buildLearnedPreferenceSuggestion(user) {
  ensureUserCollections(user);
  const sentByShortId = new Map(user.sentJobs.map((job) => [job.shortId, job]));
  const negativeJobs = user.jobFeedback
    .filter((item) => item.signal === "d" || item.signal === "h")
    .map((item) => sentByShortId.get(item.jobShortId))
    .filter(Boolean);

  if (negativeJobs.length < 3) return null;

  const existingKeys = activeSuggestionKeys(user);
  const hiddenCompanies = lowerList(user.searchProfile.hiddenCompanies);
  const [companyEntry] = countBy(negativeJobs, (job) => {
    const company = String(job.company || "").trim();
    if (!company || company === "не указано") return null;
    return company;
  });

  if (companyEntry && companyEntry[1] >= 2) {
    const [company] = companyEntry;
    const key = `company:${company.toLowerCase()}`;
    if (!existingKeys.has(key) && !hiddenCompanies.some((item) => company.toLowerCase().includes(item))) {
      return createLearningSuggestion(
        "company",
        company,
        `Похоже, тебе не подходят вакансии компании ${company}. Скрыть ее в следующих подборках?`
      );
    }
  }

  const roleTokens = new Set(uniqueTokens(lowerList(user.searchProfile.roles).join(" ")));
  const [keywordEntry] = countBy(negativeJobs.flatMap((job) => {
    return uniqueTokens(`${job.title} ${job.description}`)
      .filter((token) => token.length >= 5)
      .filter((token) => !TOKEN_STOPWORDS.has(token))
      .filter((token) => !roleTokens.has(token));
  }), (token) => token);

  if (keywordEntry && keywordEntry[1] >= 3) {
    const [keyword] = keywordEntry;
    const key = `keyword:${keyword.toLowerCase()}`;
    const exclusions = lowerList(user.searchProfile.exclusions);
    if (!existingKeys.has(key) && !exclusions.includes(keyword.toLowerCase())) {
      return createLearningSuggestion(
        "keyword",
        keyword,
        `Похоже, тебе часто не подходят вакансии со словом "${keyword}". Исключить похожие вакансии?`
      );
    }
  }

  return null;
}

function updateLearnedPreferencesFromFeedback(user) {
  const learned = {
    ...defaultLearnedPreferences(),
    ...(user.learnedPreferences || {}),
  };
  learned.feedbackSignalsCount = user.jobFeedback.length;
  learned.updatedAt = nowIso();
  user.learnedPreferences = learned;
}

function makeUserFromMessage(message, existingUser) {
  const from = message.from || {};
  const chat = message.chat || {};
  const now = nowIso();

  return ensureUserCollections({
    id: String(chat.id),
    telegramChatId: chat.id,
    telegramUserId: from.id || null,
    telegramUsername: from.username || null,
    languageCode: from.language_code || null,
    role: existingUser?.role || "user",
    status: existingUser?.status || "active",
    searchProfile: normalizeSearchProfile(existingUser?.searchProfile || {}),
    sentJobs: existingUser?.sentJobs || [],
    foundJobs: existingUser?.foundJobs || [],
    jobFeedback: existingUser?.jobFeedback || [],
    learnedPreferences: existingUser?.learnedPreferences || defaultLearnedPreferences(),
    digestSettings: existingUser?.digestSettings || defaultDigestSettings(),
    flow: existingUser?.flow || null,
    createdAt: existingUser?.createdAt || now,
    updatedAt: now,
  });
}

function makeUserFromCallbackQuery(callbackQuery, existingUser) {
  const message = callbackQuery.message || {};
  const chat = message.chat || {};
  const from = callbackQuery.from || {};
  const now = nowIso();

  return ensureUserCollections({
    id: String(chat.id),
    telegramChatId: chat.id,
    telegramUserId: from.id || existingUser?.telegramUserId || null,
    telegramUsername: from.username || existingUser?.telegramUsername || null,
    languageCode: from.language_code || existingUser?.languageCode || null,
    role: existingUser?.role || "user",
    status: existingUser?.status || "active",
    searchProfile: normalizeSearchProfile(existingUser?.searchProfile || {}),
    sentJobs: existingUser?.sentJobs || [],
    foundJobs: existingUser?.foundJobs || [],
    jobFeedback: existingUser?.jobFeedback || [],
    learnedPreferences: existingUser?.learnedPreferences || defaultLearnedPreferences(),
    digestSettings: existingUser?.digestSettings || defaultDigestSettings(),
    flow: existingUser?.flow || null,
    createdAt: existingUser?.createdAt || now,
    updatedAt: now,
  });
}

async function telegramRequest(method, payload = {}, options = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is missing in .env");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15000);

  let response;
  let bodyText = "";

  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
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
    throw new Error(`Telegram ${method} returned non-JSON response: ${bodyText}`);
  }

  if (!response.ok || !data.ok) {
    const error = new Error(`Telegram ${method} failed: ${bodyText}`);
    error.telegramErrorCode = data.error_code;
    error.telegramDescription = data.description;
    throw error;
  }

  return data.result;
}

async function joobleRequest(payload) {
  const apiKey = process.env.JOOBLE_API_KEY;
  if (!apiKey) {
    throw new Error("JOOBLE_API_KEY is missing in .env");
  }

  const baseUrl = (process.env.JOOBLE_BASE_URL || "https://ua.jooble.org/api").replace(/\/+$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.JOOBLE_TIMEOUT_MS || 15000));
  let response;
  let bodyText = "";

  try {
    response = await fetch(`${baseUrl}/${encodeURIComponent(apiKey)}`, {
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

async function douRequest() {
  const feedUrl = process.env.DOU_FEED_URL || "https://jobs.dou.ua/vacancies/feeds/";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.DOU_TIMEOUT_MS || 15000));
  let response;
  let bodyText = "";

  try {
    response = await fetch(feedUrl, {
      headers: {
        "user-agent": "JobSearcherBot/0.1 (+Telegram job search assistant)",
        accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
      },
      signal: controller.signal,
    });
    bodyText = await response.text();
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`DOU feed request failed: ${response.status}`);
  }

  return bodyText;
}

async function rssFeedRequest(feedUrl, timeoutMs, sourceName) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let bodyText = "";

  try {
    response = await fetch(feedUrl, {
      headers: {
        "user-agent": "JobSearcherBot/0.1 (+Telegram job search assistant)",
        accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
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

  const feedUrl = process.env.DJINNI_FEED_URL || "https://djinni.co/jobs/rss/";
  const xml = await rssFeedRequest(feedUrl, Number(process.env.DJINNI_TIMEOUT_MS || 15000), "Djinni");
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

async function fetchCandidatesFromSources(searchProfile = {}) {
  const sourceFetchers = [
    ["jooble", fetchJoobleCandidates],
    ["dou", fetchDouCandidates],
    ["djinni", fetchDjinniCandidates],
  ];
  const candidates = [];
  const failures = [];
  let needsProfile = false;

  for (const [source, fetcher] of sourceFetchers) {
    try {
      const result = await fetcher(searchProfile);
      if (result.needsProfile) needsProfile = true;
      candidates.push(...(result.candidates || []));
    } catch (error) {
      console.error(`[bot] ${source} source failed: ${error.message}`);
      failures.push(source);
    }
  }

  return {
    needsProfile,
    candidates,
    failures,
  };
}

async function openAiRequest(payload) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing in .env");
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const bodyText = await response.text();
  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new Error(`OpenAI returned non-JSON response: ${bodyText}`);
  }

  if (!response.ok) {
    throw new Error(`OpenAI request failed: ${bodyText}`);
  }

  return data;
}

async function googleRequest(prompt) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_API_KEY is missing in .env");
  }

  const model = process.env.GOOGLE_MODEL || "gemini-3.6-flash";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  let response;
  let bodyText = "";

  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
          },
        }),
        signal: controller.signal,
      }
    );
    bodyText = await response.text();
  } finally {
    clearTimeout(timeout);
  }

  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new Error(`Google returned non-JSON response: ${bodyText}`);
  }

  if (!response.ok) {
    throw new Error(`Google request failed: ${bodyText}`);
  }

  const outputText = data.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("");

  if (!outputText) {
    throw new Error(`Google response did not include text: ${bodyText}`);
  }

  return outputText;
}

async function ollamaRequest(prompt) {
  const baseUrl = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
  const model = process.env.OLLAMA_MODEL || "qwen2.5:7b";
  const timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS || 90000);
  const keepAlive = process.env.OLLAMA_KEEP_ALIVE || "10m";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let bodyText = "";

  try {
    response = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        format: "json",
        keep_alive: keepAlive,
        options: {
          temperature: 0.1,
        },
      }),
      signal: controller.signal,
    });
    bodyText = await response.text();
  } finally {
    clearTimeout(timeout);
  }

  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new Error(`Ollama returned non-JSON response from API: ${bodyText.slice(0, 500)}`);
  }

  if (!response.ok) {
    throw new Error(`Ollama request failed for model ${model}: ${bodyText.slice(0, 500)}`);
  }

  if (!data.response) {
    throw new Error(`Ollama response did not include generated text for model ${model}`);
  }

  return data.response;
}

async function checkOllamaModelAvailable() {
  const baseUrl = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
  const model = process.env.OLLAMA_MODEL || "qwen2.5:7b";
  const response = await fetch(`${baseUrl}/api/tags`);

  if (!response.ok) {
    throw new Error(`Ollama is not reachable at ${baseUrl}`);
  }

  const data = await response.json();
  const models = data.models || [];
  const found = models.some((item) => item.name === model || item.model === model);

  if (!found) {
    throw new Error(`Ollama model ${model} is not installed. Run: ollama pull ${model}`);
  }

  return { baseUrl, model };
}

function resumeAnalysisPrompt(text) {
  return [
    "You analyze resumes for a Ukrainian job-search Telegram bot.",
    "Return only valid compact JSON. Do not use Markdown. Do not invent facts not supported by the resume.",
    "Use null or empty arrays for missing data.",
    "",
    "Analyze this resume and infer a draft job-search profile.",
    "Return JSON with this exact shape:",
    "{",
    '  "resumeFacts": {',
    '    "headline": string,',
    '    "seniority": string,',
    '    "yearsExperience": number|null,',
    '    "roles": string[],',
    '    "skills": string[],',
    '    "industries": string[],',
    '    "languages": string[],',
    '    "summary": string',
    "  },",
    '  "searchProfile": {',
    '    "roles": string[],',
    '    "location": string,',
    '    "format": string,',
    '    "minSalary": string,',
    '    "languages": string,',
    '    "mustHave": string[],',
    '    "niceToHave": string[],',
    '    "exclusions": string[],',
    '    "hiddenCompanies": string[]',
    "  },",
    '  "questions": string[],',
    '  "confidence": number',
    "}",
    "",
    "Resume text:",
    text,
  ].join("\n");
}

async function sendMessage(chatId, text, options = {}) {
  return telegramRequest("sendMessage", {
    chat_id: chatId,
    text,
    ...options,
  });
}

async function answerCallbackQuery(callbackQueryId, text, options = {}) {
  return telegramRequest("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: false,
    ...options,
  });
}

async function deleteMessage(chatId, messageId) {
  return telegramRequest("deleteMessage", {
    chat_id: chatId,
    message_id: messageId,
  });
}

async function editMessageText(chatId, messageId, text) {
  return telegramRequest("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    reply_markup: { inline_keyboard: [] },
  });
}

async function hideVacancyMessage(chatId, messageId) {
  if (!chatId || !messageId) return;
  try {
    await deleteMessage(chatId, messageId);
    return;
  } catch (error) {
    console.error(`[bot] deleteMessage failed: ${error.message}`);
  }

  try {
    await editMessageText(chatId, messageId, "Понял, больше не буду показывать похожие так высоко.");
  } catch (error) {
    console.error(`[bot] editMessageText fallback failed: ${error.message}`);
  }
}

function replyKeyboard(keyboard) {
  return {
    reply_markup: {
      keyboard,
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  };
}

function removeKeyboard() {
  return {
    reply_markup: {
      remove_keyboard: true,
    },
  };
}

function preferenceKeyboard(field, canGoBack) {
  const rows = [];
  if (field.keyboard) rows.push(...field.keyboard);

  const controls = ["Пропустить"];
  if (canGoBack) controls.push("Назад");
  rows.push(controls);
  rows.push(["Отмена"]);

  return replyKeyboard(rows);
}

function reviewKeyboard() {
  return replyKeyboard(REVIEW_KEYBOARD);
}

function resumeReviewKeyboard() {
  return replyKeyboard(RESUME_REVIEW_KEYBOARD);
}

function resumeConsentKeyboard() {
  return replyKeyboard(RESUME_CONSENT_KEYBOARD);
}

async function askPreferenceField(chatId, user) {
  const fieldIndex = user.flow?.fieldIndex ?? 0;
  const field = PREFERENCE_FIELDS[fieldIndex];

  if (!field) {
    user.flow = null;
    throw new Error(`Invalid preference field index: ${fieldIndex}`);
  }

  const draft = user.flow.draft || {};
  const current = formatValue(draft[field.key]);
  const text = [
    `Шаг ${fieldIndex + 1}/${PREFERENCE_FIELDS.length}: ${field.label}`,
    "",
    field.question,
    "",
    `Сейчас: ${current}`,
  ].join("\n");

  await sendMessage(chatId, text, preferenceKeyboard(field, fieldIndex > 0));
}

async function showStartMenu(chatId) {
  await sendMessage(
    chatId,
    [
      "Что делаем дальше?",
      "",
      "Лучший путь: сначала загрузить резюме, я его проанализирую, а потом попрошу дополнить только недостающие детали.",
    ].join("\n"),
    replyKeyboard(START_KEYBOARD)
  );
}

async function startResumeUploadFlow(store, user, chatId) {
  user.flow = {
    name: "awaiting_resume",
    startedAt: nowIso(),
  };
  user.updatedAt = nowIso();
  await saveCurrentUser(user);

  await sendMessage(
    chatId,
    [
      "Пришли резюме файлом PDF, DOCX или TXT.",
      "",
      "Я проанализирую резюме, покажу черновик профиля поиска и спрошу, нужно ли что-то дополнить перед сохранением.",
      "",
      "Команда /cancel отменит загрузку.",
    ].join("\n"),
    removeKeyboard()
  );
}

async function startPreferencesFlow(store, user, chatId, draft = user.searchProfile || {}) {
  user.flow = {
    name: "preferences",
    fieldIndex: 0,
    draft: {
      ...normalizeSearchProfile(draft),
      status: "needs_review",
    },
    startedAt: nowIso(),
    updatedAt: nowIso(),
  };

  await saveCurrentUser(user);

  await sendMessage(
    chatId,
    "Ок, заполним профиль поиска. Отвечай по одному пункту. Можно использовать кнопки Пропустить, Назад и Отмена."
  );
  await askPreferenceField(chatId, user);
}

async function showPreferencesReview(store, user, chatId) {
  user.flow = {
    ...user.flow,
    name: "preferences_review",
    updatedAt: nowIso(),
  };

  await saveCurrentUser(user);

  await sendMessage(
    chatId,
    `${formatProfile(user.flow.draft)}\n\nПроверь данные перед сохранением.`,
    reviewKeyboard()
  );
}

function markFoundJobSent(user, sentJob) {
  const foundJob = user.foundJobs.find((job) => {
    if (sentJob.externalId && job.externalId === sentJob.externalId && job.source === sentJob.source) return true;
    return job.sourceUrl === sentJob.sourceUrl;
  });
  if (!foundJob) return;

  foundJob.status = "sent";
  foundJob.sentAt = sentJob.sentAt;
  foundJob.messageId = sentJob.messageId;
  foundJob.shortId = sentJob.shortId;
}

function markFoundJobFeedback(user, sentJob, signal) {
  const foundJob = user.foundJobs.find((job) => {
    if (sentJob.externalId && job.externalId === sentJob.externalId && job.source === sentJob.source) return true;
    return job.sourceUrl === sentJob.sourceUrl;
  });
  if (!foundJob) return;

  foundJob.feedback = signal;
  foundJob.status = FEEDBACK_STATUS_BY_SIGNAL[signal] || foundJob.status;
  foundJob.feedbackUpdatedAt = nowIso();
}

async function sendPersonalVacancyBatch(store, user, chatId, candidates, options = {}) {
  ensureUserCollections(user);

  const normalizedCandidates = candidates
    .map(normalizeJobCandidate)
    .filter(Boolean)
    .filter((job) => jobMatchesHardPreferences(user.searchProfile || {}, job, user))
    .filter((job) => !hasJobAlreadyBeenSent(user, job));
  const rankedCandidates = rankCandidatesForUser(user, normalizedCandidates);

  if (!rankedCandidates.length) {
    if (!options.silentIfEmpty) {
      await sendMessage(
        chatId,
        "Новых вакансий для этого профиля пока нет. Можно изменить профиль поиска через /preferences."
      );
    }
    return;
  }

  for (const candidate of rankedCandidates.slice(0, 5)) {
    const sentJob = createSentJob(user, candidate, user.searchProfile);
    if (!sentJob) continue;

    const message = await sendMessage(
      chatId,
      formatVacancyMessage(sentJob),
      jobFeedbackKeyboard(sentJob.shortId)
    );
    sentJob.messageId = message.message_id || null;
    user.sentJobs.push(sentJob);
    markFoundJobSent(user, sentJob);
    user.updatedAt = nowIso();
    await saveCurrentUser(user);
  }

  user.updatedAt = nowIso();
  await saveCurrentUser(user);
}

async function findNow(store, user, chatId) {
  user.searchProfile = normalizeSearchProfile(user.searchProfile || {});
  if (!user.searchProfile || Object.keys(user.searchProfile).length === 0 || !profileHasSearchData(user.searchProfile)) {
    await sendMessage(
      chatId,
      "Сначала нужен профиль поиска. Лучше начни с резюме: /upload_resume",
      removeKeyboard()
    );
    await showStartMenu(chatId);
    return;
  }

  if (user.searchProfile.status !== "active") {
    await sendMessage(
      chatId,
      "Профиль еще нужно подтвердить. Проверь данные через /preferences и нажми Сохранить."
    );
    return;
  }

  const query = buildJoobleQuery(user.searchProfile);
  if (!query) {
    await sendMessage(
      chatId,
      "В профиле не хватает ролей для поиска. Добавь роли через /preferences, чтобы я не искал слишком широко."
    );
    return;
  }

  await sendMessage(chatId, "Ищу вакансии под твой профиль. После нескольких реакций подбор станет точнее.");

  try {
    const result = await fetchCandidatesFromSources(user.searchProfile);
    if (result.needsProfile) {
      await sendMessage(chatId, "В профиле не хватает ролей для поиска. Добавь роли через /preferences.");
      return;
    }

    if (result.failures.length && result.candidates.length) {
      await sendMessage(chatId, "Сейчас нашел меньше вакансий, чем обычно. Попробую добрать еще в следующую рассылку.");
    }

    const stored = storeFoundJobs(user, result.candidates);
    await saveCurrentUser(user);
    await sendPersonalVacancyBatch(store, user, chatId, stored.length ? stored : activeFoundJobs(user));
  } catch (error) {
    console.error(`[bot] job source request failed: ${error.message}`);
    await sendMessage(chatId, "Сейчас не получилось получить вакансии. Попробуй позже, а профиль пока можно изменить через /preferences.");
  }
}

async function showFoundJobs(store, user, chatId) {
  ensureUserCollections(user);
  const jobs = rankCandidatesForUser(user, activeFoundJobs(user))
    .filter((job) => !hasJobAlreadyBeenSent(user, job))
    .slice(0, 5);

  if (!jobs.length) {
    await sendMessage(chatId, "Пока нет найденных вакансий для показа. Я пришлю новые в ближайшую рассылку или можно нажать /find_now.");
    return;
  }

  await sendMessage(chatId, "Вот вакансии, которые я уже нашел для тебя.");
  await sendPersonalVacancyBatch(store, user, chatId, jobs);
}

function hasActiveSearchProfile(user) {
  const profile = normalizeSearchProfile(user.searchProfile || {});
  return profile.status === "active" && Boolean(buildJoobleQuery(profile));
}

function digestGreeting(slot) {
  if (slot === "09:00") return "Доброе утро. Нашел новые вакансии по твоему профилю.";
  if (slot === "13:00") return "Нашел свежие вакансии на обеденную проверку.";
  return "Вечерняя подборка новых вакансий по твоему профилю.";
}

async function runDigestForUser(store, user, due) {
  ensureUserCollections(user);
  user.digestSettings.lastRunSlots[due.slotKey] = nowIso();

  if (!hasActiveSearchProfile(user)) {
    user.updatedAt = nowIso();
    await saveCurrentUser(user);
    return;
  }

  try {
    const result = await fetchCandidatesFromSources(user.searchProfile);
    const stored = storeFoundJobs(user, result.candidates);
    await saveCurrentUser(user);

    const toSend = stored.length ? stored : activeFoundJobs(user);
    if (!toSend.length) {
      return;
    }

    await sendMessage(user.telegramChatId, digestGreeting(due.slot));
    if (result.failures.length) {
      await sendMessage(user.telegramChatId, "Сейчас нашел меньше вакансий, чем обычно. Попробую добрать еще в следующую рассылку.");
    }
    await sendPersonalVacancyBatch(store, user, user.telegramChatId, toSend, { silentIfEmpty: true });
  } catch (error) {
    console.error(`[bot] digest failed for user ${user.id}: ${error.message}`);
    user.updatedAt = nowIso();
    await saveCurrentUser(user);
  }
}

async function runDueDigestsOnce(date = new Date()) {
  for (const rawUser of await listDigestUsers()) {
    const user = ensureUserCollections(rawUser);
    const due = dueDigestSlot(user, date);
    if (!due) continue;
    await runDigestForUser(null, user, due);
  }
}

function startDigestScheduler() {
  const tick = async () => {
    try {
      await runDueDigestsOnce();
    } catch (error) {
      console.error(`[bot] digest scheduler failed: ${error.message}`);
    }
  };

  setTimeout(tick, 5000);
  return setInterval(tick, SCHEDULER_INTERVAL_MS);
}

async function savePreferencesDraft(store, user, chatId) {
  const nextProfile = normalizeSearchProfile({
    ...(user.flow?.draft || {}),
    updatedAt: nowIso(),
  });
  nextProfile.status = buildJoobleQuery(nextProfile) ? "active" : "needs_review";
  user.searchProfile = nextProfile;
  user.flow = null;
  user.updatedAt = nowIso();

  await saveCurrentUser(user);

  await sendMessage(
    chatId,
    `${formatProfile(user.searchProfile)}\n\nПрофиль сохранен. Его можно изменить командой /preferences.`,
    removeKeyboard()
  );
}

async function saveAnalyzedSearchProfile(store, user, chatId) {
  const nextProfile = normalizeSearchProfile({
    ...(user.flow?.analysis?.searchProfile || {}),
    source: "resume_analysis",
    resumeId: user.flow?.resume?.id || null,
    updatedAt: nowIso(),
  });
  nextProfile.status = buildJoobleQuery(nextProfile) ? "active" : "needs_review";
  user.searchProfile = nextProfile;
  user.resumeFacts = user.flow?.analysis?.resumeFacts || null;
  user.flow = null;
  user.updatedAt = nowIso();

  await saveCurrentUser(user);

  await sendMessage(
    chatId,
    `${formatProfile(user.searchProfile)}\n\nПрофиль поиска создан на основе резюме. Его можно изменить командой /preferences.`,
    removeKeyboard()
  );
}

async function cancelFlow(store, user, chatId, text = "Настройка отменена.") {
  user.flow = null;
  user.updatedAt = nowIso();
  await saveCurrentUser(user);
  await sendMessage(chatId, text, removeKeyboard());
}

async function handlePreferenceAnswer(store, user, message) {
  const chatId = message.chat.id;
  const text = message.text?.trim();

  if (!text) {
    await sendMessage(chatId, "Пожалуйста, отправь ответ текстом.");
    return;
  }

  if (text === "Отмена") {
    await cancelFlow(store, user, chatId);
    return;
  }

  if (text === "Назад") {
    user.flow.fieldIndex = Math.max(0, user.flow.fieldIndex - 1);
    user.flow.updatedAt = nowIso();
    await saveCurrentUser(user);
    await askPreferenceField(chatId, user);
    return;
  }

  const fieldIndex = user.flow.fieldIndex;
  const field = PREFERENCE_FIELDS[fieldIndex];

  if (!field) {
    await cancelFlow(store, user, chatId, "Состояние настройки повреждено, я сбросил его. Запусти /preferences снова.");
    return;
  }

  if (text !== "Пропустить") {
    user.flow.draft[field.key] = normalizeAnswer(field.key, text);
  }

  const nextIndex = fieldIndex + 1;
  if (nextIndex >= PREFERENCE_FIELDS.length) {
    await showPreferencesReview(store, user, chatId);
    return;
  }

  user.flow.fieldIndex = nextIndex;
  user.flow.updatedAt = nowIso();
  await saveCurrentUser(user);

  await askPreferenceField(chatId, user);
}

async function handleReviewAnswer(store, user, message) {
  const chatId = message.chat.id;
  const text = message.text?.trim();

  if (text === "Сохранить") {
    await savePreferencesDraft(store, user, chatId);
    return;
  }

  if (text === "Начать заново") {
    await startPreferencesFlow(store, user, chatId, {});
    return;
  }

  if (text === "Отмена") {
    await cancelFlow(store, user, chatId);
    return;
  }

  const fieldKey = FIELD_BY_EDIT_TEXT.get(text);
  if (fieldKey) {
    const fieldIndex = PREFERENCE_FIELDS.findIndex((field) => field.key === fieldKey);
    user.flow = {
      name: "preferences",
      fieldIndex,
      draft: user.flow.draft || {},
      startedAt: user.flow.startedAt || nowIso(),
      updatedAt: nowIso(),
    };
    await saveCurrentUser(user);
    await askPreferenceField(chatId, user);
    return;
  }

  await sendMessage(chatId, "Выбери действие кнопкой: Сохранить, изменить поле, начать заново или отменить.", reviewKeyboard());
}

function safeFileName(fileName) {
  return path.basename(fileName || "resume").replace(/[^\p{L}\p{N}._ -]/gu, "_");
}

async function downloadTelegramFile(fileId, destinationPath) {
  const file = await telegramRequest("getFile", { file_id: fileId });
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);

  if (!response.ok) {
    throw new Error(`Failed to download Telegram file: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(destinationPath, buffer, { mode: 0o600 });
}

async function extractResumeText(filePath) {
  const pythonBin = process.env.PYTHON_BIN || "/Users/bohdanbielik/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3";
  const { stdout, stderr } = await execFile(pythonBin, [EXTRACT_SCRIPT_PATH, filePath], {
    maxBuffer: 10 * 1024 * 1024,
  });

  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error(`Resume parser returned invalid JSON: ${stderr || stdout}`);
  }

  if (!data.ok) {
    throw new Error(data.error || "Resume parser failed");
  }

  return data.text;
}

async function analyzeResumeText(text, providerOverride = null, options = {}) {
  const trimmedText = text.slice(0, 45000);
  const prompt = resumeAnalysisPrompt(trimmedText);
  const provider = (providerOverride || process.env.LLM_PROVIDER || "ollama").toLowerCase();
  const fallbackToLocal = options.fallbackToLocal !== false;

  try {
    if (provider === "ollama") {
      await checkOllamaModelAvailable();
      const outputText = await ollamaRequest(prompt);
      return normalizeResumeAnalysis({
        ...parseJsonObject(outputText),
        analysisSource: "ollama_local",
        analysisModel: process.env.OLLAMA_MODEL || "qwen2.5:7b",
      });
    }

    if (provider === "google" || provider === "gemini") {
      const outputText = await googleRequest(prompt);
      return normalizeResumeAnalysis({
        ...parseJsonObject(outputText),
        analysisSource: "google",
        analysisModel: process.env.GOOGLE_MODEL || "gemini-3.6-flash",
      });
    }

    const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
    const response = await openAiRequest({
      model,
      input: [
        {
          role: "system",
          content:
            "You analyze resumes for a Ukrainian job-search Telegram bot. Return only valid compact JSON. Do not invent facts not supported by the resume. Use null or empty arrays for missing data.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      text: {
        format: {
          type: "json_object",
        },
      },
    });

    const outputText =
      response.output_text ||
      response.output?.flatMap((item) => item.content || [])
        .map((content) => content.text || "")
        .join("");

    if (!outputText) {
      throw new Error("OpenAI response did not include output_text");
    }

    return normalizeResumeAnalysis({
      ...parseJsonObject(outputText),
      analysisSource: "openai",
      analysisModel: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    });
  } catch (error) {
    if (!fallbackToLocal) {
      throw error;
    }
    console.error(`[bot] ${provider} resume analysis failed, using local fallback: ${error.message}`);
    return localResumeAnalysis(text);
  }
}

async function finishResumeAnalysis(store, user, chatId, analysisMode) {
  const pending = user.flow?.pendingResume;
  if (!pending?.textPath) {
    await cancelFlow(store, user, chatId, "Не нашел ожидающее резюме. Пришли файл еще раз.");
    return;
  }

  await sendMessage(chatId, "Анализирую резюме. Это может занять немного времени.");

  const resumeText = await fs.readFile(pending.textPath, "utf8");
  let analysis;

  try {
    if (analysisMode === "local_basic") {
      analysis = localResumeAnalysis(resumeText);
    } else if (analysisMode === "external") {
      const externalProvider = process.env.EXTERNAL_LLM_PROVIDER || "google";
      analysis = await analyzeResumeText(resumeText, externalProvider);
    } else {
      analysis = await analyzeResumeText(resumeText, "ollama", { fallbackToLocal: false });
    }
  } catch (error) {
    await sendMessage(
      chatId,
      [
        "Сейчас не получилось сделать расширенный анализ.",
        "Я сделаю базовый анализ резюме, чтобы не останавливать настройку.",
      ].join("\n"),
    );
    analysis = localResumeAnalysis(resumeText);
  }

  user.flow = {
    name: "resume_analysis_review",
    resume: pending.resume,
    analysis,
    startedAt: user.flow?.startedAt || nowIso(),
    updatedAt: nowIso(),
  };
  user.updatedAt = nowIso();
  await saveCurrentUser(user);

  await sendMessage(
    chatId,
    `${formatResumeAnalysis(analysis)}\n\nСоздать профиль поиска из этого черновика или хочешь дополнить?`,
    resumeReviewKeyboard()
  );
}

async function handleResumeDocument(store, user, message) {
  const chatId = message.chat.id;
  const document = message.document;

  if (!document) {
    await sendMessage(chatId, "Пришли резюме именно файлом PDF, DOCX или TXT.");
    return;
  }

  const originalName = safeFileName(document.file_name);
  const extension = path.extname(originalName).toLowerCase();
  if (![".pdf", ".docx", ".txt", ".md"].includes(extension)) {
    await sendMessage(chatId, "Пока я принимаю только PDF, DOCX или TXT.");
    return;
  }

  const userUploadDir = path.join(UPLOADS_DIR, user.id);
  await fs.mkdir(userUploadDir, { recursive: true, mode: 0o700 });
  await fs.chmod(userUploadDir, 0o700);

  const resumeId = `resume_${Date.now()}`;
  const filePath = path.join(userUploadDir, `${resumeId}_${originalName}`);
  const textPath = path.join(userUploadDir, `${resumeId}.txt`);

  await sendMessage(chatId, "Файл получил. Скачиваю резюме и извлекаю текст локально.");
  await downloadTelegramFile(document.file_id, filePath);
  const text = await extractResumeText(filePath);

  if (!text.trim()) {
    await sendMessage(chatId, "Не смог извлечь текст из резюме. Попробуй PDF/DOCX с выделяемым текстом или TXT.");
    return;
  }
  await fs.writeFile(textPath, text, { mode: 0o600 });

  user.flow = {
    name: "resume_analysis_consent",
    pendingResume: {
      resume: {
        id: resumeId,
        fileName: originalName,
        storedAt: filePath,
        textPath,
        textLength: text.length,
        uploadedAt: nowIso(),
      },
      textPath,
    },
    startedAt: user.flow?.startedAt || nowIso(),
    updatedAt: nowIso(),
  };
  user.updatedAt = nowIso();
  await saveCurrentUser(user);

  await sendMessage(
    chatId,
    [
      "Текст резюме извлечен.",
      "",
      "Я проанализирую его и подготовлю черновик профиля поиска.",
      "",
      "Данные можно удалить командой /delete_my_data.",
    ].join("\n"),
    removeKeyboard()
  );
  await finishResumeAnalysis(store, user, chatId, "ollama");
}

async function handleResumeConsentAnswer(store, user, message) {
  const chatId = message.chat.id;
  const text = message.text?.trim();

  if (text === "Анализировать резюме") {
    await finishResumeAnalysis(store, user, chatId, "ollama");
    return;
  }

  if (text === "Отмена") {
    await cancelFlow(store, user, chatId);
    return;
  }

  await sendMessage(
    chatId,
    "Нажми Анализировать резюме или Отмена.",
    resumeConsentKeyboard()
  );
}

async function handleResumeReviewAnswer(store, user, message) {
  const chatId = message.chat.id;
  const text = message.text?.trim();

  if (text === "Все верно, создать профиль") {
    await saveAnalyzedSearchProfile(store, user, chatId);
    return;
  }

  if (text === "Дополнить профиль") {
    await startPreferencesFlow(store, user, chatId, user.flow.analysis.searchProfile);
    return;
  }

  if (text === "Загрузить другое резюме") {
    await startResumeUploadFlow(store, user, chatId);
    return;
  }

  if (text === "Отмена") {
    await cancelFlow(store, user, chatId);
    return;
  }

  await sendMessage(chatId, "Выбери действие кнопкой: создать профиль, дополнить, загрузить другое или отменить.", resumeReviewKeyboard());
}

async function handleJobFeedbackCallback(store, user, callbackQuery) {
  const chatId = callbackQuery.message?.chat?.id;
  const callbackUserId = callbackQuery.from?.id;
  const [, signal, shortId] = (callbackQuery.data || "").split(":");

  if (!chatId || !signal || !shortId || !FEEDBACK_SIGNALS[signal]) {
    await answerCallbackQuery(callbackQuery.id, "Эта кнопка устарела.");
    return;
  }

  ensureUserCollections(user);
  const sentJob = user.sentJobs.find((job) => job.shortId === shortId);
  if (!sentJob) {
    await answerCallbackQuery(callbackQuery.id, "Не нашел эту вакансию в твоей истории.");
    return;
  }

  if (sentJob.telegramUserId && callbackUserId && sentJob.telegramUserId !== callbackUserId) {
    await answerCallbackQuery(callbackQuery.id, "Эта вакансия относится к другому пользователю.");
    return;
  }

  const feedbackEvent = {
    id: `feedback_${shortId}`,
    userId: user.id,
    telegramUserId: callbackUserId || null,
    searchProfileUpdatedAt: sentJob.searchProfileUpdatedAt || null,
    jobShortId: shortId,
    source: sentJob.source,
    sourceUrl: sentJob.sourceUrl,
    signal,
    label: FEEDBACK_SIGNALS[signal],
    createdAt: nowIso(),
  };

  const existingIndex = user.jobFeedback.findIndex((item) => item.jobShortId === shortId);
  if (existingIndex >= 0) {
    user.jobFeedback[existingIndex] = {
      ...user.jobFeedback[existingIndex],
      ...feedbackEvent,
      updatedAt: nowIso(),
    };
  } else {
    user.jobFeedback.push(feedbackEvent);
  }

  sentJob.feedback = signal;
  sentJob.status = FEEDBACK_STATUS_BY_SIGNAL[signal] || "sent";
  sentJob.feedbackUpdatedAt = nowIso();
  markFoundJobFeedback(user, sentJob, signal);
  updateLearnedPreferencesFromFeedback(user);

  user.updatedAt = nowIso();
  await saveCurrentUser(user);

  const stats = getFeedbackStats(user);
  await answerCallbackQuery(callbackQuery.id, `Запомнил: ${FEEDBACK_SIGNALS[signal]}.`);

  if (signal === "d" || signal === "h") {
    await hideVacancyMessage(chatId, sentJob.messageId || callbackQuery.message?.message_id);
  }

  if (stats.total === 5 || stats.total === 10) {
    const suggestion = buildLearnedPreferenceSuggestion(user);
    if (suggestion) {
      user.learnedPreferences.pendingSuggestions.push(suggestion);
      user.updatedAt = nowIso();
      await saveCurrentUser(user);
      await sendMessage(chatId, suggestion.text, preferenceSuggestionKeyboard(suggestion.id));
    } else {
      await sendMessage(
        chatId,
        "Уже есть несколько твоих реакций. Я буду учитывать их в следующих подборках, а спорные выводы сначала уточню вопросом."
      );
    }
  }
}

async function handleLearningPreferenceCallback(store, user, callbackQuery) {
  const [, action, suggestionId] = (callbackQuery.data || "").split(":");
  if (!action || !suggestionId || !["a", "k"].includes(action)) {
    await answerCallbackQuery(callbackQuery.id, "Эта кнопка устарела.");
    return;
  }

  ensureUserCollections(user);
  const pendingIndex = user.learnedPreferences.pendingSuggestions.findIndex((item) => item.id === suggestionId);
  if (pendingIndex < 0) {
    await answerCallbackQuery(callbackQuery.id, "Это предложение уже обработано.");
    return;
  }

  const suggestion = {
    ...user.learnedPreferences.pendingSuggestions[pendingIndex],
    status: action === "a" ? "confirmed" : "dismissed",
    resolvedAt: nowIso(),
  };
  user.learnedPreferences.pendingSuggestions.splice(pendingIndex, 1);

  if (action === "a") {
    const profile = normalizeSearchProfile(user.searchProfile);
    if (suggestion.type === "company") {
      profile.hiddenCompanies = [...new Set([...(profile.hiddenCompanies || []), suggestion.value])];
      user.learnedPreferences.avoidedCompanies = [...new Set([
        ...(user.learnedPreferences.avoidedCompanies || []),
        suggestion.value,
      ])];
    }
    if (suggestion.type === "keyword") {
      profile.exclusions = [...new Set([...(profile.exclusions || []), suggestion.value])];
      user.learnedPreferences.avoidedKeywords = [...new Set([
        ...(user.learnedPreferences.avoidedKeywords || []),
        suggestion.value,
      ])];
    }
    profile.status = "active";
    profile.updatedAt = nowIso();
    user.searchProfile = profile;
    user.learnedPreferences.confirmedSuggestions.push(suggestion);
  } else {
    user.learnedPreferences.dismissedSuggestions.push(suggestion);
  }

  user.learnedPreferences.updatedAt = nowIso();
  user.updatedAt = nowIso();
  await saveCurrentUser(user);

  await answerCallbackQuery(
    callbackQuery.id,
    action === "a" ? "Ок, учту в следующих подборках." : "Ок, оставлю как есть."
  );
}

async function handleCallbackQuery(callbackQuery) {
  const chat = callbackQuery.message?.chat;
  if (!chat?.id) {
    await answerCallbackQuery(callbackQuery.id, "Не смог определить чат.");
    return;
  }

  if (chat.type !== "private") {
    await answerCallbackQuery(callbackQuery.id, "Персональные вакансии работают только в личном чате.");
    return;
  }

  const userId = String(chat.id);
  const existingUser = await getUser(userId);
  if (!existingUser) {
    await answerCallbackQuery(callbackQuery.id, "Данные уже удалены или профиль не найден.");
    return;
  }

  const user = makeUserFromCallbackQuery(callbackQuery, existingUser);

  if (callbackQuery.data?.startsWith("j:")) {
    await handleJobFeedbackCallback(null, user, callbackQuery);
    return;
  }

  if (callbackQuery.data?.startsWith("lp:")) {
    await handleLearningPreferenceCallback(null, user, callbackQuery);
    return;
  }

  await answerCallbackQuery(callbackQuery.id, "Эта кнопка устарела.");
}

async function deleteUserData(store, user, chatId) {
  await deleteUser(user.id);
  await sendMessage(
    chatId,
    "Твои данные удалены из локального хранилища бота. Если захочешь начать заново, отправь /start.",
    removeKeyboard()
  );
}

function helpText() {
  return [
    "Команды:",
    "/start - главное меню",
    "/preferences - заполнить или изменить профиль поиска",
    "/profile - показать текущий профиль",
    "/upload_resume - загрузить резюме",
    "/find_now - найти вакансии сейчас",
    "/found_jobs - показать уже найденные вакансии",
    "/delete_my_data - удалить свои данные",
    "/cancel - отменить текущую настройку",
    "/help - помощь",
  ].join("\n");
}

async function handleCommand(store, user, message) {
  const chatId = message.chat.id;
  const text = message.text.trim();
  const command = text.split(/\s+/)[0].split("@")[0].toLowerCase();

  if (command === "/start") {
    user.flow = null;
    await saveCurrentUser(user);
    await sendMessage(
      chatId,
      [
        "Привет. Я Job Searcher bot.",
        "",
        "Сначала загрузи резюме. Я его проанализирую, покажу что понял, потом спрошу что дополнить и создам профиль поиска.",
        "",
        helpText(),
      ].join("\n"),
      removeKeyboard()
    );
    await showStartMenu(chatId);
    return;
  }

  if (command === "/preferences") {
    await startPreferencesFlow(store, user, chatId);
    return;
  }

  if (command === "/profile") {
    await sendMessage(chatId, formatProfile(user.searchProfile), removeKeyboard());
    await showStartMenu(chatId);
    return;
  }

  if (command === "/upload_resume") {
    await startResumeUploadFlow(store, user, chatId);
    return;
  }

  if (command === "/find_now") {
    await findNow(store, user, chatId);
    return;
  }

  if (command === "/found_jobs") {
    await showFoundJobs(store, user, chatId);
    return;
  }

  if (command === "/delete_my_data") {
    user.flow = {
      name: "delete_confirmation",
      startedAt: nowIso(),
    };
    await saveCurrentUser(user);
    await sendMessage(
      chatId,
      "Удалить твои данные из локального хранилища бота? Напиши УДАЛИТЬ для подтверждения или Отмена.",
      replyKeyboard([["УДАЛИТЬ"], ["Отмена"]])
    );
    return;
  }

  if (command === "/cancel") {
    await cancelFlow(store, user, chatId);
    return;
  }

  if (command === "/help") {
    await sendMessage(chatId, helpText());
    return;
  }

  await sendMessage(chatId, "Я пока знаю команды /upload_resume, /preferences, /profile, /find_now, /found_jobs, /delete_my_data, /cancel и /help.");
}

async function handleMenuText(store, user, message) {
  const chatId = message.chat.id;
  const text = message.text?.trim();

  if (text === "Заполнить профиль вручную") {
    await startPreferencesFlow(store, user, chatId);
    return true;
  }

  if (text === "Показать профиль") {
    await sendMessage(chatId, formatProfile(user.searchProfile), removeKeyboard());
    await showStartMenu(chatId);
    return true;
  }

  if (text === "Загрузить резюме") {
    await startResumeUploadFlow(store, user, chatId);
    return true;
  }

  if (text === "Найти вакансии сейчас") {
    await findNow(store, user, chatId);
    return true;
  }

  if (text === "Показать найденные") {
    await showFoundJobs(store, user, chatId);
    return true;
  }

  return false;
}

async function handleMessage(message) {
  const chatId = message.chat?.id;
  if (!chatId) return;

  if (message.chat.type !== "private") {
    await sendMessage(chatId, "Для резюме и профиля поиска открой меня в личном чате. В группах я не собираю персональные данные.");
    return;
  }

  const userId = String(chatId);
  const existingUser = await getUser(userId);
  const user = makeUserFromMessage(message, existingUser);
  await saveCurrentUser(user);

  if (message.document && user.flow?.name !== "awaiting_resume") {
    user.flow = {
      name: "awaiting_resume",
      startedAt: nowIso(),
    };
    await saveCurrentUser(user);
    await handleResumeDocument(null, user, message);
    return;
  }

  if (message.text?.startsWith("/")) {
    await handleCommand(null, user, message);
    return;
  }

  if (user.flow?.name === "awaiting_resume") {
    await handleResumeDocument(null, user, message);
    return;
  }

  if (user.flow?.name === "resume_analysis_review") {
    await handleResumeReviewAnswer(null, user, message);
    return;
  }

  if (user.flow?.name === "resume_analysis_consent") {
    await handleResumeConsentAnswer(null, user, message);
    return;
  }

  if (user.flow?.name === "delete_confirmation") {
    if (message.text?.trim() === "УДАЛИТЬ") {
      await deleteUserData(null, user, chatId);
      return;
    }
    await cancelFlow(null, user, chatId, "Удаление отменено.");
    return;
  }

  if (user.flow?.name === "preferences") {
    await handlePreferenceAnswer(null, user, message);
    return;
  }

  if (user.flow?.name === "preferences_review") {
    await handleReviewAnswer(null, user, message);
    return;
  }

  if (await handleMenuText(null, user, message)) {
    return;
  }

  await sendMessage(chatId, "Чтобы заполнить профиль поиска, отправь /preferences.");
}

async function pollUpdates() {
  const state = await loadBotState();

  while (true) {
    try {
      const updates = await telegramRequest(
        "getUpdates",
        {
          offset: state.offset || 0,
          timeout: 30,
          allowed_updates: ["message", "callback_query"],
        },
        { timeoutMs: 45000 }
      );

      for (const update of updates) {
        if (update.message) {
          await handleMessage(update.message);
        }
        if (update.callback_query) {
          await handleCallbackQuery(update.callback_query);
        }

        state.offset = update.update_id + 1;
        await saveBotState(state);
      }
    } catch (error) {
      if (error.telegramErrorCode === 409) {
        console.error("[bot] Telegram polling conflict. Stop the other bot process or webhook before starting this one.");
        process.exitCode = 1;
        return;
      }

      console.error(`[bot] ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

async function setupBotCommands() {
  await telegramRequest("setMyCommands", {
    commands: [
      { command: "start", description: "Главное меню" },
      { command: "preferences", description: "Заполнить или изменить профиль поиска" },
      { command: "profile", description: "Показать текущий профиль" },
      { command: "upload_resume", description: "Загрузить резюме" },
      { command: "find_now", description: "Найти вакансии сейчас" },
      { command: "found_jobs", description: "Показать найденные вакансии" },
      { command: "delete_my_data", description: "Удалить свои данные" },
      { command: "cancel", description: "Отменить текущую настройку" },
      { command: "help", description: "Помощь" },
    ],
  });
}

async function main() {
  await loadEnv();
  await ensureStorage();
  await telegramRequest("deleteWebhook", { drop_pending_updates: false });
  await setupBotCommands();
  startDigestScheduler();

  console.log("[bot] starting Telegram polling");
  await pollUpdates();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  buildJoobleQuery,
  buildLearnedPreferenceSuggestion,
  canonicalJobKey,
  createSentJob,
  defaultLearnedPreferences,
  djinniItemToCandidate,
  douItemToCandidate,
  dueDigestSlot,
  ensureUserCollections,
  fetchCandidatesFromSources,
  fetchDjinniCandidates,
  fetchDouCandidates,
  fetchJoobleCandidates,
  formatVacancyMessage,
  getFeedbackStats,
  hasActiveSearchProfile,
  jobMatchesHardPreferences,
  jobFeedbackKeyboard,
  joobleJobToCandidate,
  localDateTimeParts,
  normalizeJobCandidate,
  normalizeSearchProfile,
  parseRssItems,
  preferenceSuggestionKeyboard,
  rankCandidatesForUser,
  scoreCandidateForUser,
  splitDjinniTitle,
  storeFoundJobs,
};
