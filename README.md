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
