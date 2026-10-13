import { Router } from 'express';
import crypto from 'crypto';
import { validateAnswerRequest } from '../validation/answer-schema.js';
import { getLLMAnswer } from '../services/llm-provider.js';

const router = Router();

// In-memory cache for repeated questions (Key -> { data, expiresAt })
const responseCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CACHE_SIZE = 500;

/**
 * Generate a deterministic hash key for question deduplication
 * Incorporates question, options, image, provider, and model.
 */
function computeCacheKey(payload, provider = '', model = '') {
  const normalized = {
    platform: payload.platform || 'moodle',
    type: payload.questionType || 'single_choice',
    q: (payload.question || '').trim().toLowerCase(),
    opts: (payload.options || []).map(o => `${o.id}:${o.text.trim().toLowerCase()}`).sort(),
    img: payload.image ? crypto.createHash('md5').update(payload.image).digest('hex') : null,
    provider: (payload.provider || provider || '').toLowerCase(),
    model: (payload.model || model || '').toLowerCase()
  };
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/**
 * Clean up expired cache items periodically
 */
function cleanupCache() {
  const now = Date.now();
  for (const [key, entry] of responseCache.entries()) {
    if (entry.expiresAt < now) {
      responseCache.delete(key);
    }
  }
}

const cleanupTimer = setInterval(cleanupCache, 60 * 1000);
if (cleanupTimer.unref) {
  cleanupTimer.unref();
}

/**
 * POST /api/answer
 * Main endpoint to evaluate a Moodle question and return the answer
 */
router.post('/answer', async (req, res) => {
  const startTime = Date.now();

  try {
    // 1. Validate request payload against schema
    const validation = validateAnswerRequest(req.body);
    if (!validation.success) {
      return res.status(400).json({
        error: 'Invalid request payload',
        details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`)
      });
    }

    const payload = validation.data;
    const providerName = payload.provider || process.env.LLM_PROVIDER || 'mock';
    const modelName = payload.model || (providerName === 'chatgpt' ? (process.env.OPENAI_MODEL || 'gpt-4o-mini') : (process.env.GEMINI_MODEL || 'gemini-flash-lite-latest'));
    const cacheKey = computeCacheKey(payload, providerName, modelName);

    // 2. Check if identical request is cached
    const cachedEntry = responseCache.get(cacheKey);
    if (cachedEntry && cachedEntry.expiresAt > Date.now()) {
      const latencyMs = Date.now() - startTime;
      return res.json({
        ...cachedEntry.data,
        cached: true,
        latencyMs
      });
    }

    // 3. Request LLM answer
    const llmResult = await getLLMAnswer(payload);
    const latencyMs = Date.now() - startTime;

    // 4. Save to cache
    if (responseCache.size >= MAX_CACHE_SIZE) {
      // Evict oldest entry
      const firstKey = responseCache.keys().next().value;
      if (firstKey) responseCache.delete(firstKey);
    }

    responseCache.set(cacheKey, {
      data: llmResult,
      expiresAt: Date.now() + CACHE_TTL_MS
    });

    // 5. Return validated answer response
    return res.json({
      ...llmResult,
      cached: false,
      latencyMs
    });
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    // Log error internally without exposing credentials or sensitive dumps
    console.error(`[Answer Error] ${error.message}`);

    return res.status(500).json({
      error: 'Failed to process question',
      message: error.message || 'Internal server error',
      latencyMs
    });
  }
});

/**
 * GET /api/cache/clear
 * Helper endpoint to clear cache during testing or settings
 */
router.post('/cache/clear', (req, res) => {
  responseCache.clear();
  res.json({ message: 'Response cache cleared successfully' });
});

export default router;
