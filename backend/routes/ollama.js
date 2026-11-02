import { Router } from 'express';
import { checkOllamaStatus, getInstalledModels, callOllama, getOllamaDiagnostics } from '../services/ollama-service.js';
import { validateAnswerRequest } from '../validation/answer-schema.js';

const router = Router();

/**
 * GET /api/ollama/status
 * Connection check: returns whether Ollama is reachable and version info
 */
router.get('/ollama/status', async (req, res) => {
  try {
    const customUrl = req.query.url || req.query.ollamaUrl;
    const result = await checkOllamaStatus(customUrl);
    if (!result.ok) {
      return res.status(503).json(result);
    }
    return res.json(result);
  } catch (err) {
    return res.status(503).json({
      ok: false,
      error: err.message || 'Cannot connect to Ollama service'
    });
  }
});

/**
 * GET /api/ollama/models
 * Model listing: returns actual installed models directly from Ollama /api/tags
 */
router.get('/ollama/models', async (req, res) => {
  try {
    const customUrl = req.query.url || req.query.ollamaUrl;
    const result = await getInstalledModels(customUrl);
    return res.json(result);
  } catch (err) {
    return res.status(503).json({
      ok: false,
      models: [],
      error: err.message || 'Failed to retrieve models from Ollama'
    });
  }
});

/**
 * GET /api/ollama/diagnostics
 * Real offline diagnostics for local backend, Ollama service, and selected model
 */
router.get('/ollama/diagnostics', async (req, res) => {
  try {
    const customUrl = req.query.url || req.query.ollamaUrl;
    const selectedModel = req.query.model || req.query.selectedModel;
    const result = await getOllamaDiagnostics({ ollamaUrl: customUrl, selectedModel });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || 'Diagnostics failed'
    });
  }
});

/**
 * POST /api/solve
 * Model execution endpoint supporting local Ollama models (and compatible providers)
 * Accepts:
 * {
 *   "provider": "ollama",
 *   "model": "gemma3:4b",
 *   "question": "...",
 *   "options": [...],
 *   "image": null
 * }
 */
router.post('/solve', async (req, res) => {
  const startTime = Date.now();

  try {
    const validation = validateAnswerRequest(req.body);
    if (!validation.success) {
      return res.status(400).json({
        error: 'Invalid request payload',
        details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`)
      });
    }

    const payload = validation.data;
    const provider = (payload.provider || 'ollama').toLowerCase();

    if (provider !== 'ollama') {
      return res.status(400).json({
        error: `Provider "${provider}" is not handled by /api/solve. For cloud providers, use /api/answer.`
      });
    }

    const answerResult = await callOllama(payload, {
      ollamaUrl: req.body.ollamaUrl || req.query.ollamaUrl,
      model: payload.model
    });

    const latencyMs = Date.now() - startTime;
    return res.json({
      ...answerResult,
      cached: false,
      latencyMs
    });
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    console.error(`[Ollama Solve Error] ${err.message}`);

    const isClientError =
      err.message.includes('not installed in Ollama') ||
      err.message.includes('does not support image questions') ||
      err.message.includes('No local Ollama model specified');

    return res.status(isClientError ? 400 : 500).json({
      error: err.message || 'Failed to solve question with Ollama',
      message: err.message,
      latencyMs
    });
  }
});

export default router;
