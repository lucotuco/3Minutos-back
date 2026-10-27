# 3Minutos - Backend API

Welcome to the backend repository for **3Minutos**, an automated, AI-powered news curation and delivery platform. This service ingests, categorizes, neutralizes, and summarizes daily news to generate personalized 3-minute digests (in both text and audio formats) for users.

---

## 🚀 Key Features

* **Data Ingestion:** Automated fetching of news articles via NewsAPI and custom RSS feed adapters.
* **AI Curation & Processing:** Uses OpenAI for topic classification, neutral curation, bias correction, and article summarization.
* **Semantic Search:** Generates and stores text embeddings to perform semantic search and similarity matching using Atlas.
* **Audio Digests:** Automatically generates text-to-speech (TTS) audio files for the daily digests and hosts them via Cloudinary.
* **Background Jobs:** Robust cron job architecture handling article ingestion, context generation, delivery preparation, and push notifications.
* **User Preferences:** Tailors the news delivery and digests based on explicit user preferences and tracking of already-shown articles.

---

## 🛠️ Tech Stack

* **Core:** Node.js, Express.js
* **Database:** MongoDB (Mongoose ORM)
* **AI & NLP:** OpenAI API (Summaries, embeddings, neutral curation)
* **Storage & Media:** Cloudinary (Audio file hosting)
* **Parsing:** Postlight Parser (`@postlight/parser`)

---

## 📂 Project Structure

```text
lucotuco-3minutos-back/
├── 3MinutosBack/
│   ├── package.json
│   ├── exportar_muestra.js       # Utility to export recent articles
│   ├── muestra_auditoria.json    # Exported sample data for auditing
│   └── src/
│       ├── app.js / server.js    # Application entry points
│       ├── *Job.js / *Cron.js    # Cron jobs (Ingestion, Delivery, Notifications)
│       ├── audio/                # Audio digest generation and Cloudinary uploads
│       ├── config/               # Third-party integrations (OpenAI, Cloudinary)
│       ├── curation/             # AI-driven neutral curation logic
│       ├── embeddings/           # Text embeddings generation & semantic search
│       ├── ingestion/            # Fetching from NewsAPI/RSS, parsing, and classifying
│       ├── middleware/           # Express middlewares (e.g., authentication)
│       ├── models/               # MongoDB Schemas (Article, UserPreference, etc.)
│       ├── routes/               # API endpoints (articles, users)
│       ├── summaries/            # Article summarization logic
│       ├── tests/                # Test battery for AI, embeddings, and classifiers
│       └── utils/                # Helper functions (ranking, date formatting, timing)
```

---

## ⚙️ Getting Started

### 1. Prerequisites
Ensure you have the following installed:
* [Node.js](https://nodejs.org/) (v16+ recommended)
* [MongoDB](https://www.mongodb.com/) (Local or Atlas URI)

### 2. Installation
Clone the repository and install the dependencies:
```bash
cd lucotuco-3minutos-back/3MinutosBack
npm install
```

### 3. Environment Variables
Create a `.env` file in the `3MinutosBack/` directory and configure the following keys:
```env
PORT=3000
MONGODB_URI=your_mongodb_connection_string
OPENAI_API_KEY=your_openai_api_key
CLOUDINARY_URL=your_cloudinary_url
NEWSAPI_KEY=your_newsapi_key
```

Optional switches for the article-picking engine (all default to *on*; no code change needed to turn them off):
```env
SAME_STORY_JUDGE=off          # AI check for "same story" pairs in the gray cosine zone (0.80-0.88)
TOPIC_JUDGE=off               # AI check that a free-topic article is really about the topic
JUDGE_WAIT_MS=1500            # max total wait for the judges in a digest someone is looking at (0 = cache only)
JUDGE_WAIT_MS_BACKGROUND=4000 # same, for digests built by the background job
TOPIC_EXPANSION_STORE=off     # keep free-topic expansions only in memory (default: also saved in Mongo, collection topic_expansions)
```
To force every free topic to be expanded again, empty the `topic_expansions` collection.

A free topic gives up in three steps, not one. First it looks for an article where the topic is the **focus** (the topic judge answers SI). If there is none, it accepts one where the topic only appears **in passing** (PARCIAL): for someone who asked for "boca juniors", an article that mentions Boca on the side is worth more than a flawless article about something else. Only if there is none of either does it fall back to a "suggested" article from the same category (the rescue). A NO never passes at any step. The stored `matchReason` says which step won (`| tema: SI` or `| tema: PARCIAL`), so the mix is measurable.

The rescue is stricter about repeats than the rest of the engine (`RESCUE_JUDGE_MIN_COSINE`, 0.70 instead of 0.80). It reads the whole category and delivers the most important and freshest article, so for two different topics in the same category it tends to land on the *same event* — two articles about the same award, one for "boca juniors" and one for "river plate", in a single digest. With different angles their cosine falls below 0.80 and they used to slip through; from 0.70 the judge decides.

Among the eligible articles of a topic, the one delivered is the best by `score = (1 - w) * importance + w * freshness`. Freshness is 100 up to a plateau (default 4 h: for a reader there is no difference between a 30-minute-old and a 3-hour-old article), then falls linearly to 0 at 24 h. `w` is the weight of freshness (0 = importance only, 1 = freshness only; default `0.3`). Values out of range (`w` outside 0-1, plateau outside 0-24) are ignored. The server must be restarted to change them:
```env
FRESHNESS_WEIGHT=0.3          # 0-1
FRESHNESS_PLATEAU_HOURS=4     # 0 = no plateau (linear from the first minute)
```

### Article votes (thumbs up / down)

Each article in a digest can be voted on. The vote is stored **together with the engine's decision** (age, importance, score, zone, level, whether it was a rescue), because a bare thumbs-down only says "something was wrong", while the decision context says *which rule to change*: thumbs-down on old articles means raising `FRESHNESS_WEIGHT`, thumbs-down on rescues means a supply problem, and `aburrida` on high-importance articles means `importanceScore` is not measuring interest.

The client sends only the article, the vote and (for a thumbs-down) the reason. The server fills in the context from the delivery run it already stored, so the client cannot pollute the data and does not need to know anything about the engine. One vote per user and article: voting again *changes* the vote.

```text
POST   /users/:userId/digest/vote              { articleId, vote: 1 | -1, reason? }
DELETE /users/:userId/digest/vote/:articleId
GET    /users/:userId/digest/votes             -> { items: [{ articleId, vote, reason }] }
```

`reason` is only accepted with `vote: -1`, and must be one of `aburrida`, `no_es_del_tema`, `ya_la_sabia`, `vieja`. A thumbs-up carries no reason on purpose: asking people who voted positively why they did lowers the number of votes.

Votes live in the `article_votes` collection. A vote for an article that is no longer in any recent delivery run (the digest was refreshed, or the vote arrived days later) is still stored, with `contextSource: 'sin_contexto'`.

### 4. Running the Server
Start the backend server:
```bash
npm start
# or manually: node src/server.js
```

### 5. Running Tests
You can execute the test scripts located in the `src/tests/` directory to verify embedding generation, semantic searches, and classifier accuracy:
```bash
node src/tests/testBattery.js
```

---

## 🤖 Automated Jobs Overview
The system relies on several standalone scripts that run as Cron Jobs:
* **`ingestionJob.js`**: Fetches, parses, and normalizes fresh news articles.
* **`prepareDeliveryRunsJob.js`**: Groups users and prepares the custom digests based on their preferences.
* **`buildDigestAudioScript.js`**: Converts the personalized text digests into audio formats.
* **`sendNotificationCronJob.js`**: Dispatches push notifications to users once their digests are ready.
* **`cleanupAudiosJob.js`**: Removes old audio files from Cloudinary to save space.

---

## 📄 License
*Private / Proprietary* - All rights reserved.
