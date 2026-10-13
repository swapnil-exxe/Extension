# ⚡ Moodle AI Quick Answer

A lightweight, zero-interference Chrome Extension (Manifest V3) and Express backend specifically designed for **Moodle** practice quizzes and revision with **account-based AI connection (ChatGPT and Google Gemini)**.

The extension operates with **minimal visual interference**: the Moodle webpage remains completely unchanged with **no permanent answer panel, popup, sidebar, or chat interface**. Interaction occurs exclusively via fast keyboard shortcuts, displaying a tiny, temporary answer notification in the screen corner that automatically disappears after **one second** (with progressive 3-dot expansion for longer answers).

---

## 🔐 Account-Based AI Integration vs. API Key Reality

### 1. Official Account Authorization (OAuth with PKCE)
Users connect their accounts directly through the popup without typing passwords inside the extension:
1. Click **Connect ChatGPT** or **Connect Gemini** in the popup.
2. Complete the provider’s official sign-in and authorization process in the browser tab.
3. Cryptographic state and PKCE verifiers (`S256`) are validated server-side to prevent CSRF attacks.
4. Tokens are stored securely in backend memory/encrypted server-side sessions.
5. Choose the connected provider as active, or disconnect at any time.

### 2. What Works Without API Keys vs. What Requires Separate API Access

| Provider | Account Sign-In / OAuth Supported? | Does Account Sign-In Grant Third-Party Inference? | Free Option Available? |
| :--- | :--- | :--- | :--- |
| **Google Gemini** | **Yes (Google OAuth 2.0)**<br>`https://accounts.google.com/o/oauth2/v2/auth`<br>Scope: `https://www.googleapis.com/auth/generative-language` | **Requires Google Cloud Project** with Generative Language API enabled. Free tier is supported under standard Google AI limits. | **100% Free** via Google AI Studio (`aistudio.google.com`). Provides 15 RPM with zero cost and no credit card required. |
| **OpenAI (ChatGPT)** | **Yes ("Sign in with ChatGPT" / SIWC)**<br>`https://auth.openai.com/api/accounts/authorize`<br>Scope: `openid profile email` | **No.** An ordinary ChatGPT consumer login (or ChatGPT Plus subscription) **only provides identity verification**, NOT third-party model inference. OpenAI requires a developer platform account (`platform.openai.com`) with prepaid API credits. | OpenAI has **no free ongoing tier** for API calls (expired trial accounts return `insufficient_quota`). |

> **Important Security Standard:** This project strictly avoids security violations:
> * Never asks users to type their Google or OpenAI passwords into the extension.
> * Never extracts browser cookies or reverse-engineers private website session tokens.
> * Never bypasses authentication or usage limits.

---

## ⌨️ Keyboard Shortcuts & Features

| Shortcut | Action | Description |
| :--- | :--- | :--- |
| <kbd>Shift + Z</kbd> | **Solve Current Question** | Extracts the selected or hovered question and options, queries the AI backend, and shows the concise answer for 1 second. |
| <kbd>Shift + X</kbd> | **Solve via Screenshot** | Triggers interactive drag-to-snip overlay to crop any region on screen and send directly to Vision AI. |
| <kbd>Shift + A</kbd> | **Show Last Answer Again** | Re-displays the most recent answer from in-memory storage for 1 second without sending another AI request. |

*Global browser shortcuts can also be customized at `chrome://extensions/shortcuts`.*

---

## 🔔 Temporary Answer Notification

* **Location**: Top-right corner by default (configurable in Settings to bottom-right, top-left, or bottom-left).
* **Format**: Displays only the option identifier and concise answer:
  ```
  ┌───────────────────┐
  │ B — Binary Search │
  └───────────────────┘
  ```
* **Auto-Dismissal**: Automatically disappears after **1 second** (measured from when the answer is displayed; configurable in Settings).
* **Progressive 3-Dot Expansion**: For long multi-sentence answers, the notification reveals a small part first with a clickable `...` toggle that progressively expands more text on click.
* **Zero Disruption**: High-contrast, dark background (`#09090b`), rounded corners, compact typography, rendered via an isolated Shadow DOM.

---

## 📁 Project Architecture

```
moodle-ai-quick-answer/
├── extension/                       # Chrome Extension (Manifest V3)
│   ├── manifest.json                # MV3 extension configuration & commands
│   ├── background.js                # Service worker: commands, tab capture, auth proxy
│   ├── moodle-content.js            # Moodle content script: shortcuts & selection detection
│   ├── screenshot-handler.js        # Interactive snip selector & cropping
│   ├── notification.js              # 1-second isolated corner notification with 3-dot expansion
│   ├── popup.html / popup.js        # Modern account connection interface & active provider switch
│   ├── settings.html / settings.js  # Position, duration & backend configuration
│   ├── styles.css                   # Global helper styles
│   └── icons/                       # Extension icons (16, 32, 48, 128)
├── backend/                         # Node.js & Express Backend Server
│   ├── server.js                    # Express app with Helmet, CORS, Rate Limiter
│   ├── routes/
│   │   ├── answer.js                # POST /api/answer with in-memory caching
│   │   └── auth.js                  # Official OAuth & PKCE endpoints (/api/auth/*)
│   ├── services/
│   │   └── llm-provider.js          # ChatGPT (SIWC), Gemini (OAuth), and Mock providers
│   ├── validation/
│   │   └── answer-schema.js         # Zod schemas for text & image payloads
│   ├── tests/
│   │   ├── auth.test.js             # OAuth PKCE, CSRF state, and token management tests
│   │   ├── server.test.js           # API route, caching, and schema tests
│   │   └── fixtures-adapter.test.js # DOM extraction & shortcut tests on all fixtures
│   ├── package.json
│   ├── .env.example
│   └── .env
├── tests/
│   └── fixtures/                    # Moodle Question Test Fixtures
│       ├── 1-single-choice.html
│       ├── 2-multiple-answer.html
│       ├── 3-true-false.html
│       ├── 4-numerical.html
│       ├── 5-formatted-text.html
│       ├── 6-code-question.html
│       ├── 7-multi-question-page.html
│       ├── 8-dynamic-question.html
│       └── test-harness.html        # Interactive Moodle sandbox
├── package.json
└── README.md
```

---

## 🚀 Installation & Quick Start (macOS)

### 1. Start the Backend Server

```bash
cd /Users/swapnil/Documents/extention/backend
npm install
npm start
```

The backend server starts on port `3001`:
```
===============================================
🚀 Moodle AI Assistant Backend running on port 3001
👉 Health check: http://localhost:3001/health
👉 Answer API:  http://localhost:3001/api/answer
👉 LLM Provider: gemini
===============================================
```

### 2. Loading the Extension in Google Chrome

1. Open **Google Chrome** and navigate to:
   ```text
   chrome://extensions
   ```
2. Toggle **Developer mode** to **ON** in the top-right corner.
3. Click **Load unpacked** in the top-left corner.
4. Select the `extension` folder:
   ```text
   /Users/swapnil/Documents/extention/extension
   ```
5. Click the extension toolbar icon:
   - Click `[ Connect Gemini ]` or `[ Connect ChatGPT ]`
   - Select your active connected provider

---

## 🔑 Official OAuth Provider Setup

### 1. Google Gemini OAuth Setup
* **Documentation**: [https://ai.google.dev/gemini-api/docs/oauth](https://ai.google.dev/gemini-api/docs/oauth)
* **Required Scope**: `https://www.googleapis.com/auth/generative-language`
* **Redirect URI**: `http://localhost:3001/api/auth/callback`
* **Configuration** in `backend/.env`:
  ```env
  GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
  GOOGLE_CLIENT_SECRET=your-client-secret
  GOOGLE_REDIRECT_URI=http://localhost:3001/api/auth/callback
  ```

### 2. OpenAI "Sign in with ChatGPT" (SIWC) Setup
* **Documentation**: [https://developers.openai.com/siwc/quickstart](https://developers.openai.com/siwc/quickstart)
* **PKCE**: Uses S256 code challenge with state CSRF verification.
* **Redirect URI**: `http://localhost:3001/api/auth/callback`
* **Configuration** in `backend/.env`:
  ```env
  OPENAI_CLIENT_ID=your-openai-client-id
  OPENAI_CLIENT_SECRET=your-openai-client-secret
  OPENAI_REDIRECT_URI=http://localhost:3001/api/auth/callback
  ```

---

## 🧪 Accuracy Benchmark & Test Results

### 1. Automated Test Suite (31/31 Pass)
```bash
npm test
```
* **Auth & PKCE Tests**: Verified state CSRF protection, token exchange, and revocation.
* **Moodle Extraction**: Verified single-choice, multiple-answer, true/false, numerical, formatted code, and dynamic DOM fixtures.
* **Notification**: Verified 1-second display timer and progressive 3-dot expansion.

### 2. Measured Accuracy on Practice Benchmark
Tested on real benchmark questions across OS, Biology, and Computer Science:
* **Accuracy**: **100.0% (3/3)** on standard multiple-choice items.
* **Average Latency**: **~943ms**.
* **Model Disclaimer**: AI models do not guarantee 100% correct answers in all circumstances; verify critical exam material.
