import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables reliably first
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '.env') });

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import answerRouter from './routes/answer.js';
import authRouter from './routes/auth.js';
import ollamaRouter from './routes/ollama.js';
import { getActiveProviderInfo } from './services/llm-provider.js';

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';

// 1. Security Headers with Helmet
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// 2. CORS Configuration
// Allow Chrome extension origins and local development
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, curl, server-to-server)
    if (!origin) return callback(null, true);
    if (
      origin.startsWith('chrome-extension://') ||
      origin.startsWith('http://localhost') ||
      origin.startsWith('http://127.0.0.1')
    ) {
      return callback(null, true);
    }
    // In dev mode allow all origins, or customize for strict production
    return callback(null, true);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// 3. Request Body Size Limits (Supports high-res screenshots up to 15MB)
app.use(express.json({ limit: '15mb' }));

// 4. Rate Limiting (Security: Section 8)
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // Limit each IP to 60 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many requests, please slow down.'
  }
});
app.use('/api/', limiter);

// 5. Health Check Endpoints
function getHealthPayload() {
  const activeInfo = getActiveProviderInfo ? getActiveProviderInfo() : { provider: 'mock', status: 'not_connected' };
  const activeProvider = activeInfo.provider;
  const activeModel = activeProvider === 'chatgpt' || activeProvider === 'openai'
    ? (process.env.OPENAI_MODEL || 'gpt-4o-mini')
    : (process.env.GEMINI_MODEL || 'gemini-3.5-flash');

  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    provider: activeProvider,
    connectionStatus: activeInfo.status,
    accountEmail: activeInfo.accountEmail || null,
    model: activeModel
  };
}

app.get('/health', (req, res) => {
  res.json(getHealthPayload());
});

app.get('/api/health', (req, res) => {
  res.json(getHealthPayload());
});

// 6. API Routes
app.use('/api', answerRouter);
app.use('/api', ollamaRouter);
app.use('/api/auth', authRouter);

// 7. Global 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// 8. Global Error Handler
app.use((err, req, res, next) => {
  console.error('[Server Error]', err.message);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// Start listening if executed directly and not in test environment
const isDirectExecution = process.argv[1] && (process.argv[1].endsWith('server.js') || process.argv[1].endsWith('server'));
if (process.env.NODE_ENV !== 'test' && isDirectExecution) {
  let activeServer = null;

  const startServer = (portToUse) => {
    const srv = app.listen(portToUse, HOST, () => {
      console.log(`===============================================`);
      console.log(`🚀 Moodle AI Assistant Backend running on http://${HOST}:${portToUse}`);
      console.log(`👉 Health check: http://${HOST}:${portToUse}/health`);
      console.log(`👉 Answer API:   http://${HOST}:${portToUse}/api/answer`);
      console.log(`👉 Ollama Solve: http://${HOST}:${portToUse}/api/solve`);
      console.log(`👉 Ollama Models:http://${HOST}:${portToUse}/api/ollama/models`);
      console.log(`👉 LLM Provider: ${process.env.LLM_PROVIDER || 'mock (default)'}`);
      console.log(`===============================================`);
    });

    srv.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && portToUse === 3000) {
        console.warn(`⚠️ Port 3000 is busy, automatically falling back to port 3001...`);
        startServer(3001);
      } else {
        console.error('[Server Error]', err.message);
      }
    });

    activeServer = srv;
  };

  startServer(Number(PORT));

  const shutdown = () => {
    console.log('\nShutting down backend server...');
    if (activeServer) {
      activeServer.close(() => {
        console.log('Server stopped.');
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

export default app;
