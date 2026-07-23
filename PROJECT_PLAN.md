# AI Job Search Agent: Product and Engineering Plan

## 1. Product Goal

Build a multi-user AI agent that helps each candidate find relevant, current job openings across Ukrainian job platforms and sends matched vacancies to that candidate's own Telegram chat.

The agent should not simply search by keywords. It should understand the candidate's resume, current job-search intent, constraints, and feedback, then continuously improve the quality of recommendations.

## 2. Core Product Principle

The system separates three concepts:

1. **Resume Facts**: what the candidate has actually done and can prove from a resume.
2. **Search Profile**: what the candidate wants to find now.
3. **Feedback History**: what the candidate liked, rejected, hid, or asked to see more often.

This prevents the agent from overfitting to old experience. For example, if a resume contains sales experience but the candidate no longer wants sales roles, the Search Profile wins.

## 3. MVP Scope

The first useful version should support:

- Telegram bot onboarding.
- Resume upload via Telegram.
- PDF/DOCX/TXT parsing.
- One active Search Profile per user.
- Multiple independent users in the same bot.
- Per-user resumes, preferences, feedback, digest schedule, and data deletion.
- Resume-first onboarding: analyze uploaded resume before asking for missing search preferences.
- Manual confirmation of parsed resume facts and inferred Search Profile draft.
- Job search across the first priority sources.
- Deduplication and relevance scoring.
- Daily Telegram digest.
- Manual `find now` command.
- Feedback buttons: suitable, not suitable, hide company, more like this.
- Basic admin/debug logs.

## 4. Recommended Source Priority

### Phase 1 Sources

- Jooble API: official API and broad aggregation. Implemented in MVP.
- DOU RSS feed: public feed and strong for IT roles. Implemented in MVP.
- Djinni RSS feed: public tech jobs feed. Implemented in MVP.
- Work.ua public search HTML adapter. Implemented as best-effort source.
- robota.ua public search HTML adapter. Implemented as best-effort source.
- Jobs.ua public search HTML adapter. Implemented as best-effort source.
- OLX Robota public search HTML adapter. Implemented as best-effort source with extended-search noise filtering.
- Happy Monday public WordPress REST search adapter. Implemented as best-effort source.
- Lobby X public WordPress REST search adapter. Implemented as best-effort source.

### Phase 2 Sources

- No additional job platforms are planned for the current roadmap.

### Access Rules

- Prefer official APIs, RSS feeds, saved searches, email alerts, and public pages.
- Do not bypass login walls, bot protection, rate limits, or platform restrictions.
- Keep each source behind a separate adapter so sources can be disabled safely.

## 5. Main User Flow

1. User starts the Telegram bot.
2. System creates or updates a User record from the Telegram `chat.id`.
3. Bot asks for a resume file.
4. User uploads a resume.
5. Resume Parser extracts structured facts.
6. AI Resume Analyzer automatically uses the best configured internal analysis path and creates Resume Facts plus a draft Search Profile.
7. Bot shows a short interpretation of the resume and draft Search Profile.
8. User confirms the draft or chooses to supplement/edit missing details.
9. If needed, bot asks for search preferences:
   - target roles;
   - remote/hybrid/office;
   - cities/countries;
   - minimum salary;
   - excluded industries;
   - preferred languages;
   - daily digest time.
10. System creates an active Search Profile linked to that user and resume.
11. Scheduler searches for jobs for each active user/profile.
12. Matching Engine makes an initial per-user estimate against that user's active Search Profile and Resume Facts.
13. Bot sends a small batch of top matches to the matching user's Telegram chat.
14. Each sent vacancy includes the original source link at the end of the message.
15. User gives feedback on the sent vacancies.
16. After several sent vacancies and feedback signals, Feedback Learner recalibrates only that user's ranking weights.
17. Future recommendations improve for that user without changing recommendations for other users.

## 6. Resume Selection Logic

The agent can support multiple resumes, but the MVP should keep the behavior simple and explicit.

### MVP Rule

Each user has one active Search Profile. That Search Profile references one active resume and is created only after the user has reviewed the resume analysis.

The user never chooses an AI model or provider. The bot keeps model/provider selection internal and presents only product-level actions: upload resume, review profile, supplement fields, save profile, or delete data.

The agent uses:

- the active Search Profile for search decisions;
- the linked resume for evidence and matching;
- feedback history for ranking adjustment.

All resume selection, matching, exclusions, and feedback are scoped by `user_id`. A decision made by one user must not change another user's recommendations.

### Future Multi-Resume Rule

If a user has multiple profiles, the agent chooses a profile only when confidence is high.

If two profiles are close, the bot asks:

> This request matches two profiles: Product Manager and AI Engineer. Which one should I use?

The agent should not silently guess when profile intent is ambiguous.

## 7. Core Data Model

### User

```json
{
  "id": "user_123",
  "telegram_chat_id": "123456789",
  "telegram_user_id": "123456789",
  "telegram_username": "bohdan_bielik",
  "first_name": "Bohdan",
  "last_name": "Bielik",
  "timezone": "Europe/Kiev",
  "role": "user",
  "status": "active",
  "created_at": "2026-07-23T00:00:00Z"
}
```

The Telegram `chat.id` is the delivery address for private chats. It must be unique per user record. The bot should never rely on a single global `TELEGRAM_CHAT_ID` for product behavior.

### Resume

```json
{
  "id": "resume_123",
  "user_id": "user_123",
  "source_file_name": "resume_pm_en.pdf",
  "language": "en",
  "raw_text": "...",
  "parsed_facts": {
    "headline": "Product Manager / AI Products",
    "seniority": "middle/senior",
    "years_experience": 5,
    "skills": ["SaaS", "AI products", "analytics", "roadmaps"],
    "roles": ["Product Manager", "Product Owner"],
    "industries": ["SaaS", "automation"],
    "languages": ["English B2", "Ukrainian native"]
  },
  "confidence": 0.86,
  "created_at": "2026-07-23T00:00:00Z"
}
```

### User Session State

```json
{
  "user_id": "user_123",
  "state": "awaiting_resume_upload",
  "state_payload": {},
  "updated_at": "2026-07-23T00:00:00Z"
}
```

This allows different users to be in different bot flows at the same time. For example, one user may be uploading a resume while another is editing preferences.

### Search Profile

```json
{
  "id": "search_profile_123",
  "user_id": "user_123",
  "resume_id": "resume_123",
  "name": "AI Product Manager Remote",
  "active": true,
  "status": "active",
  "target_roles": ["AI Product Manager", "Product Manager", "Product Owner"],
  "must_have": ["remote", "AI or SaaS"],
  "nice_to_have": ["startup", "international team"],
  "exclude_keywords": ["casino", "adult", "network marketing"],
  "hidden_companies": [],
	  "learned_preferences": {
	    "preferred_keywords": [],
	    "avoided_keywords": [],
	    "preferred_companies": [],
	    "avoided_companies": [],
	    "pending_suggestions": [],
	    "confirmed_suggestions": [],
	    "dismissed_suggestions": [],
	    "format_weight": 1.0,
	    "salary_weight": 1.0,
	    "domain_weight": 1.0,
    "seniority_weight": 1.0
  },
  "salary_min": 2500,
  "locations": ["Remote", "Ukraine", "Europe"],
  "digest_frequency": "daily",
  "digest_time": "09:00"
}
```

### Job

```json
{
  "id": "job_123",
  "source": "dou",
  "external_id": "dou_456",
  "url": "https://example.com/job",
  "title": "AI Product Manager",
  "company": "Example Company",
  "location": "Remote",
  "salary": "$3000-4500",
  "description": "...",
  "requirements": ["Product management", "AI", "Analytics"],
  "posted_at": "2026-07-23T00:00:00Z",
  "fetched_at": "2026-07-23T00:00:00Z",
  "status": "open"
}
```

### Match

```json
{
  "id": "match_123",
  "job_id": "job_123",
  "search_profile_id": "search_profile_123",
  "user_id": "user_123",
  "score": 87,
  "score_version": "initial_v1",
  "reasons": [
    "Matches AI/SaaS product experience",
    "Remote format matches preferences",
    "Seniority appears compatible"
  ],
  "risks": [
    "Fintech experience requested but weak in resume"
  ],
  "sent_to_telegram": true,
  "source_url_sent": "https://example.com/job",
  "feedback": "suitable"
}
```

### Feedback Event

```json
{
  "id": "feedback_123",
  "user_id": "user_123",
  "search_profile_id": "search_profile_123",
  "match_id": "match_123",
  "job_id": "job_123",
  "signal": "suitable",
  "reason": "more_like_this",
  "created_at": "2026-07-23T00:00:00Z"
}
```

The Feedback Learner must wait for several sent vacancies or explicit feedback events before changing learned preferences. As an MVP rule, learned preferences should start influencing ranking after 5-10 feedback signals from the same user. This avoids overreacting to one accidental click.

## 8. System Architecture

### Components

1. **Telegram Bot**
   Handles onboarding, resume upload, preferences, digest delivery, and feedback. Every update is resolved to a `user_id` from Telegram identity before any business logic runs.

2. **Resume Parser**
   Extracts text from PDF/DOCX/TXT and converts it into structured Resume Facts.

3. **Profile Builder**
   Creates and updates Search Profiles from resume facts and user preferences.

4. **Source Adapters**
   Fetch jobs from Jooble, DOU, Work.ua, robota.ua, Djinni, and later sources.
   Each adapter returns the same candidate format. Source failures are isolated: if one source fails, other sources can still produce vacancies.

5. **Job Normalizer**
   Converts source-specific job data into a single internal Job schema.

6. **Deduplication Engine**
   Removes duplicates using URL, source ID, company/title similarity, and text similarity.

7. **Matching Engine**
   Scores jobs per user using hard filters, embeddings, keyword matching, seniority checks, learned preferences, and LLM explanation. There is no global universal score for all users.

8. **Feedback Learner**
   Updates ranking preferences from that user's Telegram feedback only after enough sent vacancies or feedback signals have accumulated. It may also ask confirmation questions before turning repeated feedback into a hard exclusion.

9. **Scheduler**
   Runs periodic searches and daily digest jobs per active Search Profile. Jobs must be idempotent per `user_id`, `search_profile_id`, and date/window.

10. **Storage**
    Stores users, resumes, profiles, jobs, matches, feedback, digest state, source sync state, and logs. The local MVP uses SQLite with JSON migration backups; PostgreSQL remains the later deployment target.

11. **Admin/Debug Interface**
    Optional MVP+ tool for inspecting source health, match explanations, and failed jobs. MVP now includes per-user last source status in Telegram.

## 9. Suggested Tech Stack

### Backend

- Python 3.11+
- FastAPI
- Pydantic
- SQLAlchemy or SQLModel
- PostgreSQL
- pgvector for embeddings
- Redis for queue/cache
- Celery, Dramatiq, or RQ for background jobs

### Telegram

- `python-telegram-bot` or `aiogram`

### AI/LLM

- Ollama local LLM as the default resume-analysis provider.
- Default local model: `qwen2.5:7b`.
- Provider/model selection is an internal system setting and must not appear in the normal Telegram UX.
- External LLM providers such as Google/Gemini or OpenAI are optional advanced/admin fallbacks and require explicit privacy consent before resume text is sent outside the machine.
- Embeddings for semantic matching.
- Perplexity MCP/API as optional discovery and validation layer, not the primary data source.

### Deployment

- Docker Compose for MVP.
- VPS or small cloud instance.
- PostgreSQL backups.
- Cron/worker monitoring.

## 10. Matching Strategy

### Hard Filters

- Excluded keywords.
- Hidden companies.
- Minimum salary if salary is provided.
- Required work format.
- Required location.
- Must-have terms from the Search Profile.
- Freshness window.

### Soft Scoring

- Role/title match.
- Role match in job description/snippet.
- Work format match.
- Location match.
- Salary compatibility when currency is comparable.
- Language token overlap.
- Nice-to-have term overlap.
- Personal feedback adjustment from that user's previous reactions.

Scoring is always scoped to `user_id` and `search_profile_id`. The first batch uses only resume facts and stated preferences. Later batches add feedback adjustment from that user's feedback history. The user never sees the numeric score.

Automatic digests run only for active confirmed profiles. Draft or needs-review profiles do not trigger scheduled vacancy delivery.

After several user reactions, the bot may suggest a learned exclusion or hidden company, but the user must confirm it before it becomes a hard filter.

The current MVP ranking is a transparent component score, not a final ML model. Semantic matching, seniority matching, and LLM explanations are Phase 2 improvements.

Feedback is personal by default. Global learning may be added later only from anonymized aggregate signals.

### Telegram Vacancy Message Contract

Every sent vacancy must end with the original source link.

Example:

```text
AI Product Manager
Company: Example Company
Format: Remote
Salary: $3000-4500

Why it may fit:
- Matches AI/SaaS product experience.
- Remote format matches preferences.

Risks:
- Fintech experience is requested but weak in the resume.

Source: https://example.com/job
```

### LLM Explanation

The LLM should not decide alone. It should explain a score produced by the Matching Engine and identify risks.

Example output:

```text
Match: 87%

Why it fits:
- AI/SaaS product experience matches the vacancy.
- Remote format matches preferences.
- Analytics and roadmap skills are present in the resume.

Risks:
- Vacancy mentions fintech, but resume has limited fintech evidence.
```

## 11. Telegram Commands

```text
/start
/upload_resume
/preferences
/profile
/find_now
/found_jobs
/favorites
/delete_my_data
/cancel
/help
```

### Favorites Mini App

Saved vacancies are managed as a lightweight application funnel:

- `saved`: user wants to review the vacancy later.
- `applied`: user has sent an application.
- `archived`: user removed the vacancy from favorites.

The Telegram bot keeps a chat fallback for `/favorites`, while the preferred UX is a Telegram Mini App opened from the `Избранные` button. The Mini App is served by a Cloudflare Worker and stores per-user favorites in Cloudflare D1. User access is verified with Telegram Web App `initData`; bot-to-Mini-App sync uses a shared `FAVORITES_API_SECRET`.

### Automatic Delivery

The MVP sends automatic vacancy batches every day at fixed Kyiv-time slots:

- `09:00`
- `13:00`
- `21:00`

Each user has independent digest state:

- `digestSettings.enabled`
- `digestSettings.timezone`, default `Europe/Kiev`
- `digestSettings.slots`
- `digestSettings.lastRunSlots`

The scheduler must not rely on the server timezone and must not send the same slot twice for the same user after restart.

### Manual Found Jobs

The main menu includes a `Показать найденные` button and the `/found_jobs` command. This shows already found active vacancies for that user without forcing a new external source search.

### Removing Unsuitable Vacancies

When the user presses `Не подходит` or `Скрыть похожие`, the bot saves feedback and then tries to remove the vacancy message from the chat. If Telegram cannot delete the message, the bot should fall back to editing the message into a short status. Delete/edit failures must not break callback handling.

### Admin/Test Commands

Admin commands are optional and must be limited to configured admin chat IDs:

```text
/admin_stats
/admin_source_health
/admin_test_digest
```

## 12. Development Phases

### Phase 0: Setup

- Finalize product decisions.
- Collect first resume samples.
- Create Telegram bot via BotFather.
- Choose hosting/deployment target.
- Configure API keys.

### Phase 1: MVP Backbone

- Implement a simple Node.js Telegram bot for the first local MVP.
- Store MVP user/profile/history data in SQLite with user-level isolation. Done.
- Keep legacy JSON files as migration backups/fallback, not as the active store. Done.
- Later migrate storage to PostgreSQL when the product flow is stable.
- Implement user registration from Telegram updates.
- Implement resume upload and parsing.
- Implement Search Profile creation.
- Implement per-user sent vacancy history and feedback buttons.
- Implement Jooble adapter as the first real source. Done.
- Implement DOU adapter. Done.
- Implement Djinni adapter. Done.
- Implement Work.ua best-effort public search adapter. Done.
- Implement robota.ua best-effort public search adapter. Done.
- Implement Happy Monday best-effort WordPress REST search adapter. Done.
- Implement Lobby X best-effort WordPress REST search adapter. Done.
- Implement basic per-user matching and daily digest.
- Implement favorites funnel with Telegram Mini App scaffold, local chat fallback, and optional Cloudflare D1 sync. Done.
- Implement profile statuses (`draft`, `needs_review`, `active`) and block manual/scheduled search for unconfirmed profiles. Done.
- Implement confirmation-based learned preference suggestions for repeated negative feedback. Done.
- Implement SQLite storage layer with idempotent migration from JSON and structured foundation tables. Done.

### Phase 2: Better Matching

- Add embeddings.
- Add deterministic match summaries in vacancy cards. Done.
- Add optional LLM match explanations after latency/cost controls.
- Improve learned preference suggestions beyond basic repeated company/keyword detection.
- Add deduplication beyond URL/source ID using conservative title/company similarity. Done.
- Improve public-source resilience and add per-user source health diagnostics. Done.
- Enrich Happy Monday and Lobby X candidates from detail REST endpoints, filtering clearly closed/removed vacancies. Done.
- Preserve availability/enrichment metadata in found and sent job JSON records. Done.

### Phase 3: Coverage and Reliability

- Harden current source adapters and delivery reliability before considering any new platform.
- Move Telegram bot from laptop polling to hosted webhook mode. Runtime support has been added with `npm run bot:webhook`, `GET /health`, `POST /telegram/webhook`, Dockerfile, Fly.io config, and GitHub Actions deployment workflow.
- Add queryable SQL availability/enrichment columns when admin analytics need them.
- Add Perplexity-assisted source discovery.
- Add job availability validation.
- Add historical source health monitoring.
- Add admin/debug view.

### Phase 4: Application Support

- Generate tailored cover letters.
- Generate resume improvement suggestions per vacancy.
- Track applications.
- Optional: semi-automated apply workflow with explicit user confirmation.

## 13. Risks and Guardrails

### Platform Access Risk

Some platforms may not provide official APIs or may restrict automated access. The system must keep source adapters configurable and disable unsafe sources quickly.

### Personal Data Risk

Resumes contain personal data. The product must support:

- explicit consent before any third-party resume analysis;
- data deletion;
- minimal data retention;
- encrypted secrets;
- no unnecessary sharing with third-party APIs.
- strict user-level data isolation;
- deletion by `user_id` across resumes, profiles, matches, feedback, and logs.

### Hallucination Risk

The LLM must not invent job details. Job details must come from fetched source data. The LLM may summarize and explain only from provided data.

### Quality Risk

Bad recommendations reduce trust quickly. The MVP should prefer fewer, better matches over high-volume noisy digests.

## 14. What We Need From the User

### Required

1. Telegram bot token from BotFather.
2. Optional admin/test Telegram chat ID.
3. At least one resume file.
4. Target roles and exclusions.
5. Preferred location/work format.
6. Minimum acceptable salary or salary preference.
7. API keys:
   - Jooble API key;
   - optional Perplexity API key;
   - optional Google/OpenAI/Groq/OpenRouter key only if external LLM fallback is desired.

### Helpful

1. Examples of 5 good vacancies.
2. Examples of 5 bad vacancies.
3. List of companies to avoid.
4. List of dream companies.
5. Preferred digest time.
6. Whether to search only Ukraine or also Europe/global remote.

## 15. MVP Acceptance Criteria

The MVP is successful when:

- user can upload a resume in Telegram;
- multiple users can use the same bot independently;
- bot creates a confirmed Search Profile;
- system fetches jobs from at least two sources;
- system deduplicates jobs;
- system sends daily top matches;
- each match includes score, reasons, risks, and source link;
- user feedback changes future recommendations;
- user feedback changes only that user's recommendations;
- user can delete personal data;
- production bot runs from hosted webhook infrastructure, not from a local laptop.
