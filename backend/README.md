# Moodle AI Quick Answer - Backend Deployment (Render.com)

This backend runs the AI answering service (Gemini / ChatGPT) and handles authentication for the Chrome Extension.

## 🚀 Quick 1-Click Free Deployment on Render

1. Go to **[Render.com](https://render.com)** and sign in with GitHub.
2. Click **New +** -> **Web Service**.
3. Select your repository.
4. Set the following options:
   - **Name:** `moodle-ai-backend`
   - **Root Directory:** `backend`
   - **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** `Free`

5. **Environment Variables** (in Render Dashboard -> Environment):
   - `GEMINI_API_KEY`: *(Your Google AI Studio Gemini API key)*
   - `LLM_PROVIDER`: `gemini`
   - `NODE_ENV`: `production`

6. Click **Create Web Service**.
   Your free public backend URL will look like:
   `https://moodle-ai-backend.onrender.com`

---

## 🛠 Local Development

```bash
cd backend
npm install
npm start
```
Server runs at `http://localhost:3001`.
