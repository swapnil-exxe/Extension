import { extractAndParseJSON } from './llm-provider.js';
import { detectSubject, getDomainGuidelines } from './subject-expert.js';

const KNOWN_VISION_FAMILIES = [
  'clip',
  'mllama',
  'llava',
  'bakllava',
  'moondream',
  'minicpm-v',
  'qwen2-vl',
  'qwen2vl',
  'phi3vision',
  'phi-3-vision',
  'gemma3',
  'vision'
];

const KNOWN_TEXT_FAMILIES = [
  'llama',
  'gemma',
  'gemma2',
  'qwen',
  'qwen2',
  'qwen2.5',
  'mistral',
  'mixtral',
  'deepseek',
  'phi',
  'phi3',
  'starcoder',
  'command-r',
  'falcon',
  'nemotron',
  'codellama',
  'bert'
];

/**
 * Resolve target Ollama server URL from parameter, env, or default
 */
export function getOllamaUrl(overrideUrl) {
  const url = overrideUrl || process.env.OLLAMA_HOST || process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
  return url.replace(/\/+$/, '');
}

/**
 * Format bytes into human-readable string (e.g. 2.4 GB)
 */
export function formatBytes(bytes) {
  if (!bytes || isNaN(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = (bytes / Math.pow(1024, i)).toFixed(1);
  return `${val} ${units[i] || 'GB'}`;
}

/**
 * Detect model capability from model details and metadata:
 * Returns: 'Vision' | 'Text' | 'Unknown'
 */
export function detectModelCapability(modelData) {
  if (!modelData) return 'Unknown';

  const families = [];
  if (Array.isArray(modelData.details?.families)) {
    families.push(...modelData.details.families.map(f => String(f).toLowerCase()));
  }
  if (modelData.details?.family) {
    families.push(String(modelData.details.family).toLowerCase());
  }
  const name = String(modelData.name || modelData.model || '').toLowerCase();

  // 0. Check explicit Ollama capabilities array if present
  if (Array.isArray(modelData.capabilities)) {
    const caps = modelData.capabilities.map(c => String(c).toLowerCase());
    if (caps.includes('embedding') && !caps.includes('completion')) return 'Embedding';
    if (caps.includes('vision')) return 'Vision';
  }
  if (name.includes('embed') || name.startsWith('bge-') || name.includes('-embed-')) {
    return 'Embedding';
  }

  // 1. Check for explicit vision families or name indicators
  const hasVisionFamily = families.some(f => KNOWN_VISION_FAMILIES.some(vf => f.includes(vf)));
  const hasVisionName = KNOWN_VISION_FAMILIES.some(vf => name.includes(vf)) || name.includes('-vision') || name.includes('_vision');
  if (hasVisionFamily || hasVisionName) {
    return 'Vision';
  }

  // 2. Check for known pure text families
  const isPureTextFamily = families.some(f => KNOWN_TEXT_FAMILIES.includes(f));
  const hasTextName = KNOWN_TEXT_FAMILIES.some(tf => name.startsWith(tf));
  if (isPureTextFamily || (families.length > 0 && hasTextName)) {
    return 'Text';
  }

  // 3. Fallback: if we cannot reliably determine, return Unknown rather than falsely claiming support
  return 'Unknown';
}

/**
 * Check if Ollama service is reachable and retrieve server info
 */
export async function checkOllamaStatus(ollamaUrl, timeoutMs = 4000) {
  const baseUrl = getOllamaUrl(ollamaUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let version = 'unknown';
    try {
      const verRes = await fetch(`${baseUrl}/api/version`, {
        signal: controller.signal
      });
      if (verRes.ok) {
        const verData = await verRes.json();
        version = verData.version || 'installed';
      }
    } catch (_) {
      // Fallback to tags if version endpoint is not present
    }

    const tagsRes = await fetch(`${baseUrl}/api/tags`, {
      signal: controller.signal
    });

    clearTimeout(timer);

    if (!tagsRes.ok) {
      return {
        ok: false,
        url: baseUrl,
        error: `Ollama returned HTTP ${tagsRes.status}`
      };
    }

    const tagsData = await tagsRes.json();
    const count = Array.isArray(tagsData.models) ? tagsData.models.length : 0;

    return {
      ok: true,
      url: baseUrl,
      version,
      modelsCount: count
    };
  } catch (err) {
    clearTimeout(timer);
    let msg = err.message || 'Cannot connect to Ollama';
    const isConnRefused =
      err.cause?.code === 'ECONNREFUSED' ||
      err.code === 'ECONNREFUSED' ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('fetch failed') ||
      msg.includes('Failed to fetch');

    if (err.name === 'AbortError' || msg.includes('aborted')) {
      msg = `Connection to Ollama at ${baseUrl} timed out after ${timeoutMs}ms.`;
    } else if (isConnRefused) {
      msg = `Cannot connect to Ollama at ${baseUrl}. Ensure Ollama is running (e.g. 'ollama serve').`;
    }
    return {
      ok: false,
      url: baseUrl,
      error: msg
    };
  }
}

// In-memory cache for installed models to avoid repeated /api/tags network calls
const installedModelsCache = new Map();
const MODELS_CACHE_TTL_MS = 30000;

/**
 * Fetch and format all models installed in Ollama directly from /api/tags
 */
export async function getInstalledModels(ollamaUrl, timeoutMs = 5000) {
  const baseUrl = getOllamaUrl(ollamaUrl);
  const now = Date.now();
  if (process.env.NODE_ENV !== 'test') {
    const cached = installedModelsCache.get(baseUrl);
    if (cached && (now - cached.timestamp < MODELS_CACHE_TTL_MS)) {
      return cached.data;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl}/api/tags`, {
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!res.ok) {
      throw new Error(`Ollama /api/tags returned HTTP ${res.status}`);
    }

    const data = await res.json();
    const rawList = Array.isArray(data.models) ? data.models : [];

    const models = rawList.map((m) => {
      const exactName = m.name || m.model || '';
      const tag = exactName.includes(':') ? exactName.split(':')[1] : 'latest';
      const capability = detectModelCapability(m);

      return {
        name: exactName,
        model: exactName,
        tag,
        size: formatBytes(m.size),
        sizeBytes: m.size || 0,
        family: m.details?.family || (m.details?.families && m.details.families[0]) || 'unknown',
        parameterSize: m.details?.parameter_size || '',
        quantization: m.details?.quantization_level || '',
        capability,
        modifiedAt: m.modified_at || ''
      };
    });

    const result = {
      ok: true,
      url: baseUrl,
      models,
      count: models.length,
      message: models.length === 0 ? 'No local models found. Install one using ollama pull MODEL_NAME.' : null
    };

    installedModelsCache.set(baseUrl, { data: result, timestamp: now });
    return result;
  } catch (err) {
    clearTimeout(timer);
    let msg = err.message;
    const isConnRefused =
      err.cause?.code === 'ECONNREFUSED' ||
      err.code === 'ECONNREFUSED' ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('fetch failed') ||
      msg.includes('Failed to fetch');

    if (err.name === 'AbortError') {
      msg = `Timed out fetching models from Ollama at ${baseUrl}.`;
    } else if (isConnRefused) {
      msg = `Cannot connect to Ollama at ${baseUrl}. Ensure Ollama is installed and running.`;
    }
    throw new Error(msg);
  }
}

/**
 * Perform comprehensive real-time diagnostics on local backend and Ollama
 */
export async function getOllamaDiagnostics(options = {}) {
  const baseUrl = getOllamaUrl(options.ollamaUrl);
  const selectedModel = (options.selectedModel || '').trim();

  const diag = {
    ok: true,
    timestamp: new Date().toISOString(),
    backend: {
      status: 'connected',
      host: process.env.HOST || '127.0.0.1',
      port: Number(process.env.PORT || 3000),
      uptimeSeconds: Math.round(process.uptime()),
      nodeVersion: process.version
    },
    ollama: {
      status: 'disconnected',
      url: baseUrl,
      version: 'unknown',
      modelsCount: 0,
      latencyMs: null,
      error: null
    },
    selectedModel: {
      name: selectedModel || 'none',
      installed: false,
      capability: 'Unknown',
      loadedInMemory: false,
      size: null,
      details: null
    },
    offlineMode: {
      active: true,
      externalNetworkRequired: false,
      status: '100% Offline Local Pipeline'
    }
  };

  const start = Date.now();
  try {
    const statusRes = await checkOllamaStatus(baseUrl, 3000);
    diag.ollama.latencyMs = Date.now() - start;

    if (statusRes.ok) {
      diag.ollama.status = 'connected';
      diag.ollama.version = statusRes.version;
      diag.ollama.modelsCount = statusRes.modelsCount;

      // Query installed models
      const modelsData = await getInstalledModels(baseUrl, 4000);
      diag.ollama.modelsCount = modelsData.models.length;

      // Query active loaded models from Ollama /api/ps
      let loadedModels = [];
      try {
        const psRes = await fetch(`${baseUrl}/api/ps`, { signal: AbortSignal.timeout(2000) });
        if (psRes.ok) {
          const psData = await psRes.json();
          loadedModels = Array.isArray(psData.models) ? psData.models.map(m => m.name || m.model) : [];
        }
      } catch (_) {}

      // Match selected model
      if (selectedModel) {
        const match = modelsData.models.find(
          m => m.name === selectedModel || m.model === selectedModel || m.name.startsWith(selectedModel)
        );
        if (match) {
          diag.selectedModel.installed = true;
          diag.selectedModel.capability = match.capability;
          diag.selectedModel.size = match.size;
          diag.selectedModel.details = {
            family: match.family,
            parameters: match.parameterSize,
            quantization: match.quantization
          };
          diag.selectedModel.loadedInMemory = loadedModels.some(lm => lm.includes(selectedModel) || selectedModel.includes(lm));
        }
      }
    } else {
      diag.ok = false;
      diag.ollama.error = statusRes.error;
    }
  } catch (err) {
    diag.ok = false;
    diag.ollama.status = 'disconnected';
    diag.ollama.error = err.message;
  }

  return diag;
}

/**
 * Classify question structure specifically for Ollama inference:
 * Returns: 'SINGLE_CHOICE' | 'MULTIPLE_CHOICE' | 'OPEN_ENDED' | 'UNKNOWN'
 */
export function classifyOllamaQuestion(questionText = '', options = [], questionType = '', hasCheckboxes = false) {
  if (hasCheckboxes) return 'MULTIPLE_CHOICE';

  const text = String(questionText || '').trim();

  // Strong explicit multiple-answer indicators
  const multiRegex = /\b(select all|choose all|all that apply|check all|select multiple|more than one|select each|mark all|multiple correct|any of the following are|identify all|select two|select three|select (?:2|3|4)|choose two|choose three|choose (?:2|3|4)|which (?:of the following|of these)?\s+(?:are|statements are|characteristics are|options are|features are|principles are))\b/i;
  const whichAreRegex = /\bwhich\s+(?:of the following\s+|of these\s+)?are\b/i;
  const singularRegex = /\b(which (?:of the following|of these)?\s+(?:is|was)|which is|select (?:one|the single|the best)|choose (?:one|the single|the best))\b/i;

  if (multiRegex.test(text) || whichAreRegex.test(text) || questionType === 'multiple_choice') {
    if (!singularRegex.test(text) || multiRegex.test(text) || whichAreRegex.test(text)) {
      return 'MULTIPLE_CHOICE';
    }
  }

  if (Array.isArray(options) && options.length >= 2) {
    return 'SINGLE_CHOICE';
  }

  if (text.length > 0 && (!options || options.length < 2)) {
    return 'OPEN_ENDED';
  }

  return 'UNKNOWN';
}

/**
 * Build subject-aware system prompt ensuring local Ollama output is deterministic,
 * accurate, and correctly formatted for single vs multiple answers.
 */
function buildSystemPrompt(domain, classifiedType = 'SINGLE_CHOICE') {
  const domainGuidance = getDomainGuidelines(domain);

  if (classifiedType === 'MULTIPLE_CHOICE') {
    return `You are an expert academic tutor and AI inference engine solving quiz questions.
QUESTION CLASSIFICATION: MULTIPLE_CHOICE (Multiple correct answers possible).
Output strictly valid JSON with keys: "question_type", "option", "options", "answer", "reason", "confidence", "status", "isMultiple".

STRICT RULES FOR MULTIPLE-ANSWER QUESTIONS:
1. This question may have MORE THAN ONE correct option. Evaluate EVERY available option independently (A, B, C, D...).
2. Identify ALL correct options. NEVER stop after finding the first correct answer.
3. In "options", return an array of all correct option letters: ["A", "B", "D"].
4. In "option", return comma-separated correct option letters: "A, B, D".
5. In "answer", return the full text of each correct option formatted on newlines: "A — text\nB — text\nD — text".
6. In "reason", provide a concise explanation for EACH correct option.
7. Set "isMultiple": true, "question_type": "multiple", "confidence": 0.95, and "status": "success".

${domainGuidance}

Response format must be valid JSON:
{
  "question_type": "multiple",
  "option": "A, B, D",
  "options": ["A", "B", "D"],
  "answer": "A — Option A text\\nB — Option B text\\nD — Option D text",
  "reason": "Option evaluations:\\n- A: [why correct]\\n- B: [why correct]\\n- D: [why correct]",
  "confidence": 0.95,
  "status": "success",
  "isMultiple": true
}`;
  }

  if (classifiedType === 'OPEN_ENDED') {
    return `You are an expert academic tutor and AI inference engine solving quiz questions.
QUESTION CLASSIFICATION: OPEN_ENDED (Numerical, short answer, or coding).
Output strictly valid JSON with keys: "question_type", "option", "options", "answer", "reason", "confidence", "status", "isMultiple".

STRICT RULES:
1. Provide the exact calculated number, expression, or concise term.
2. Set "option": "", "options": [], and "isMultiple": false.
3. In "reason", provide a concise step-by-step verification.
4. Set "status": "success" and "confidence": 0.95.

${domainGuidance}

Response format must be valid JSON:
{
  "question_type": "open_ended",
  "option": "",
  "options": [],
  "answer": "Calculated value or term",
  "reason": "Brief verification",
  "confidence": 0.95,
  "status": "success",
  "isMultiple": false
}`;
  }

  return `You are an expert academic tutor and AI inference engine solving quiz questions.
QUESTION CLASSIFICATION: SINGLE_CHOICE (Exactly one best answer).
Output strictly valid JSON with keys: "question_type", "option", "options", "answer", "reason", "confidence", "status", "isMultiple".

STRICT RULES:
1. Evaluate all options and select the single best, most accurate option from the available choices.
2. NEVER output "I am not sure", "uncertain", or generic hesitation. Answer directly with academic precision.
3. For single-choice MCQs:
   - Set "option" to the chosen option letter (e.g. "A").
   - Set "options" to ["<Letter>"].
   - Set "answer" to the exact text of that selected option.
   - Set "isMultiple": false.
4. In "reason", provide a concise 1-sentence verification explaining why this answer is correct.
5. Set "status" to "success" and "confidence": 0.95.

${domainGuidance}

Response format must be valid JSON:
{
  "question_type": "single",
  "option": "A",
  "options": ["A"],
  "answer": "Option text",
  "reason": "Brief verification",
  "confidence": 0.95,
  "status": "success",
  "isMultiple": false
}`;
}

/**
 * Build clean, subject-focused prompt string for Ollama
 */
function buildOllamaPrompt(payload, domain, classifiedType = 'SINGLE_CHOICE') {
  const { question, options, questionType, hasImage } = payload;
  let p = '';

  if (hasImage) {
    p += `Mode: Visual Analysis & OCR (Academic Question Screenshot)\n`;
    p += `Instructions for image:
1. Carefully read and OCR all question text, mathematical formulas, equations, and code inside the image.
2. Examine all answer options (A, B, C, D...) visible in the image or listed below.
3. Solve the question accurately. If multiple options are correct or it is a multiple-answer question ("which are", "select all"), identify ALL correct options.\n\n`;
  }

  p += `Academic Domain: ${domain}\n`;
  p += `Question Type: ${classifiedType}\n\n`;

  if (question && question.trim()) {
    p += `Question:\n${question.trim()}\n\n`;
  } else if (hasImage) {
    p += `Please examine the attached image containing the question and choices.\n\n`;
  }

  const isMulti = classifiedType === 'MULTIPLE_CHOICE';

  if (options && options.length > 0) {
    p += `Available Options:\n`;
    options.forEach((opt) => {
      p += `- [${opt.id}]: ${opt.text}\n`;
    });
    if (isMulti) {
      p += `\nThis is a MULTIPLE-ANSWER question. Evaluate EVERY option independently. Output JSON with "options": ["A", "B", ...], "option": "A, B, ...", "isMultiple": true, and "answer".`;
    } else {
      p += `\nSelect the best option. If multiple options are correct or the question asks for multiple characteristics ("which are", "select all"), identify ALL of them with "option": "A, B, ..." and "options": ["A", "B", ...]. Output strictly valid JSON.`;
    }
  } else {
    p += `\nCarefully evaluate all options in the question or image. If multiple options are correct or it is a multiple-answer question ("which are", "select all"), return ALL correct options in "options": ["A", "B", ...] and "option": "A, B, ...". Output strictly valid JSON.`;
  }

  return p;
}

/**
 * Reconcile and verify model output against provided options to eliminate uncertainty,
 * correctly preserve multiple answers (A, B, D), and adhere to quiz schema.
 */
export function verifyAndNormalizeAnswer(parsed, payload, domain) {
  const options = Array.isArray(payload.options) ? payload.options : [];
  const questionText = String(payload.question || '').trim();
  const classifiedType = classifyOllamaQuestion(questionText, options, payload.questionType, payload.hasCheckboxes);

  // 1. Extract all candidate option letters
  const candidateLetters = [];
  const seenLetters = new Set();
  function addLetter(raw) {
    if (!raw) return;
    const str = String(raw).trim();
    const m = str.match(/^([A-Za-z0-9]+)[\.\:\)\-]?/);
    if (m) {
      let up = m[1].toUpperCase();
      if (/^[1-9]$/.test(up)) {
        up = String.fromCharCode(64 + parseInt(up, 10)); // 1->A, 2->B, 3->C, 4->D
      }
      if (up.length <= 2 && up !== 'UNCERTAIN' && !seenLetters.has(up)) {
        seenLetters.add(up);
        candidateLetters.push(up);
      }
    }
  }

  // 1. Direct chosen option takes precedence
  const rawOptionStr = String(parsed.option || parsed.selected_option || parsed.choice || '').trim();
  if (rawOptionStr && rawOptionStr.toUpperCase() !== 'UNCERTAIN') {
    const parts = rawOptionStr.split(/[,;&]|\band\b/i);
    parts.forEach(addLetter);
  }

  // 2. Options array only added if multiple-choice or direct option was empty
  const isMultiContext = Boolean(classifiedType === 'MULTIPLE_CHOICE' || parsed.question_type === 'multiple' || parsed.isMultiple === true);
  if (Array.isArray(parsed.options)) {
    if (isMultiContext || candidateLetters.length === 0) {
      parsed.options.forEach(addLetter);
    }
  }
  if (Array.isArray(parsed.optionIds)) {
    if (isMultiContext || candidateLetters.length === 0) {
      parsed.optionIds.forEach(addLetter);
    }
  }
  if (Array.isArray(parsed.answer) && (isMultiContext || candidateLetters.length === 0)) {
    parsed.answer.forEach(addLetter);
  }

  if (candidateLetters.length === 0 && (parsed.reason || parsed.explanation)) {
    const combinedReason = `${parsed.reason || ''} ${parsed.explanation || ''}`;
    const matches = combinedReason.matchAll(/\b(?:option|choice|answer)\s+([A-D])\b/gi);
    for (const m of matches) {
      addLetter(m[1]);
    }
  }

  // 2. Determine whether this is a multiple-answer question
  let isMultiple = false;
  if (isMultiContext) {
    isMultiple = true;
  } else if (candidateLetters.length > 1) {
    if (classifiedType !== 'SINGLE_CHOICE' || options.length === 0) {
      isMultiple = true;
    } else {
      candidateLetters.splice(1);
    }
  }

  // 3. Match against options
  const matchedOptions = [];
  if (options.length > 0 && candidateLetters.length > 0) {
    for (const letter of candidateLetters) {
      let match = options.find(o => String(o.id).toUpperCase() === letter);
      if (!match) {
        const letterIdx = letter.charCodeAt(0) - 65;
        if (letterIdx >= 0 && letterIdx < options.length) match = options[letterIdx];
      }
      if (!match) {
        match = options.find(o => {
          const m = String(o.text || '').match(/^(?:(?:\(([A-Za-z0-9]+)\))|(?:\[([A-Za-z0-9]+)\])|([A-Za-z0-9]+)[\.\:\)\-])\s*/);
          return m && (m[1] || m[2] || m[3]).toUpperCase() === letter;
        });
      }

      if (match) {
        let cleanText = String(match.text || '').trim();
        const mMatch = cleanText.match(/^(?:(?:\(([A-Za-z0-9]+)\))|(?:\[([A-Za-z0-9]+)\])|([A-Za-z0-9]+)[\.\:\)\-])\s*(.*)$/);
        if (mMatch && mMatch[4]) cleanText = mMatch[4].trim();
        matchedOptions.push({ id: letter, text: cleanText });
      } else {
        matchedOptions.push({ id: letter, text: `Option ${letter}` });
      }
    }
  }

  // Text matching fallback if candidateLetters was empty but raw answer has text
  let rawAnswer = String(parsed.answer || parsed.answerText || parsed.correct_answer || parsed.result || '').trim();
  if (
    rawAnswer.toLowerCase().includes('uncertain') ||
    rawAnswer.toLowerCase().includes('needs verification') ||
    rawAnswer.toLowerCase().includes('cannot determine') ||
    rawAnswer.toLowerCase().includes('unable to')
  ) {
    rawAnswer = '';
  }

  if (matchedOptions.length === 0 && options.length > 0 && rawAnswer && typeof parsed.answer === 'string') {
    const ansLower = rawAnswer.toLowerCase();
    const textMatch = options.find(o => {
      const raw = String(o.text || '').toLowerCase().trim();
      const stripped = raw.replace(/^[a-z0-9]+[\.\:\)\-]\s*/i, '').trim();
      return raw === ansLower || stripped === ansLower ||
             (ansLower.length > 3 && (raw.includes(ansLower) || ansLower.includes(raw) || stripped.includes(ansLower) || ansLower.includes(stripped)));
    });
    if (textMatch) {
      const mIdx = options.indexOf(textMatch);
      const letter = String(textMatch.id || String.fromCharCode(65 + mIdx)).toUpperCase();
      let cleanText = String(textMatch.text || '').trim();
      const mMatch = cleanText.match(/^(?:(?:\(([A-Za-z0-9]+)\))|(?:\[([A-Za-z0-9]+)\])|([A-Za-z0-9]+)[\.\:\)\-])\s*(.*)$/);
      if (mMatch && mMatch[4]) cleanText = mMatch[4].trim();
      matchedOptions.push({ id: letter, text: cleanText });
    }
  }

  let finalOption = '';
  let finalOptionIds = [];
  let finalAnswer = '';

  if (matchedOptions.length > 0) {
    finalOptionIds = matchedOptions.map(m => m.id);
    finalOption = finalOptionIds.join(', ');
    if (isMultiple) {
      finalAnswer = matchedOptions.map(m => `${m.id} — ${m.text}`).join('\n');
    } else {
      finalAnswer = matchedOptions[0].text;
    }
  } else {
    finalOption = candidateLetters.join(', ');
    finalOptionIds = candidateLetters;
    finalAnswer = rawAnswer || (finalOption ? `Option ${finalOption}` : 'Solution evaluated successfully');
  }

  const rawReason = parsed.reason || parsed.explanation || `Selected ${finalOption} based on ${domain || 'academic'} analysis.`;
  let finalExplanation = rawReason;
  if (isMultiple) {
    finalExplanation = `MULTIPLE ANSWER\n\n${finalAnswer}\n\nExplanation:\n${rawReason}`;
  }

  return {
    question_type: isMultiple ? 'multiple' : (options.length === 0 ? 'open_ended' : 'single'),
    option: finalOption,
    options: finalOptionIds,
    optionIds: finalOptionIds,
    answer: finalAnswer,
    answerText: finalAnswer,
    isMultiple,
    status: 'success',
    explanation: finalExplanation,
    reason: rawReason,
    confidence: typeof parsed.confidence === 'number' ? Math.max(0.70, Math.min(1.0, parsed.confidence)) : 0.95,
    needsMoreContext: false,
    domain
  };
}

/**
 * Execute Ollama model generation via POST /api/generate with optimized parameters
 * and offline robustness.
 */
export async function callOllama(payload, options = {}) {
  const baseUrl = getOllamaUrl(options.ollamaUrl || payload.ollamaUrl);
  const requestedModel = payload.model || options.model;

  if (!requestedModel || typeof requestedModel !== 'string' || !requestedModel.trim()) {
    throw new Error('No local Ollama model specified. Please select a model in extension settings.');
  }

  const modelIdentifier = requestedModel.trim();

  // 1. Validate requested model against installed models list (unless in unit test with bypass)
  if (options.skipModelValidation !== true) {
    let installedData;
    try {
      installedData = await getInstalledModels(baseUrl, 4000);
    } catch (fetchErr) {
      throw new Error(`Failed to verify installed models: ${fetchErr.message}`);
    }

    const matchingModel = installedData.models.find(
      m => m.name === modelIdentifier || m.model === modelIdentifier
    );

    if (!matchingModel) {
      const available = installedData.models.map(m => m.name).join(', ') || 'none';
      throw new Error(
        `Selected local model "${modelIdentifier}" is not installed in Ollama. ` +
        `Please run "ollama pull ${modelIdentifier}" in your terminal or select an installed model (${available}).`
      );
    }

    // 2. Validate vision capability if image is provided
    const allImages = [];
    if (Array.isArray(payload.images) && payload.images.length > 0) {
      allImages.push(...payload.images);
    } else if (payload.image) {
      allImages.push(payload.image);
    }

    if (allImages.length > 0 && matchingModel.capability === 'Text') {
      throw new Error(
        `The selected local model "${modelIdentifier}" is a text-only model and does not support image questions. ` +
        `Please select a vision-capable local model (such as llama3.2-vision, llava, or qwen2-vl) or use text questions.`
      );
    }
  }

  // 3. Extract and sanitize images for Ollama (Ollama expects raw base64 without data URI prefix)
  const rawImages = [];
  const incomingImages = Array.isArray(payload.images) && payload.images.length > 0
    ? payload.images
    : (payload.image ? [payload.image] : []);

  for (const imgStr of incomingImages) {
    if (!imgStr || typeof imgStr !== 'string') continue;
    const cleanBase64 = imgStr.replace(/^data:image\/[a-zA-Z+]+;base64,/, '').trim();
    if (cleanBase64) {
      rawImages.push(cleanBase64);
    }
  }

  const hasImage = rawImages.length > 0;
  const domain = detectSubject(payload.question || '', payload.options || []);
  const classifiedType = classifyOllamaQuestion(payload.question, payload.options, payload.questionType, payload.hasCheckboxes);
  const prompt = buildOllamaPrompt({ ...payload, hasImage }, domain, classifiedType);
  const system = buildSystemPrompt(domain, classifiedType);

  const estimatedInputTokens = Math.ceil((prompt.length + system.length) / 3);
  const dynamicCtx = rawImages.length > 0 ? 8192 : Math.max(2048, Math.min(8192, estimatedInputTokens + 600));

  // Optimized inference options for fast, deterministic local generation
  const requestBody = {
    model: modelIdentifier,
    prompt,
    system,
    stream: false,
    format: 'json',
    keep_alive: '30m', // Keep model resident in memory to eliminate cold start latency
    options: {
      temperature: 0.1, // Near-greedy decoding for academic precision
      top_p: 0.9,
      top_k: 40,
      num_predict: 350, // Adequate response length prevents truncated JSON
      num_ctx: dynamicCtx
    }
  };

  if (rawImages.length > 0) {
    requestBody.images = rawImages;
  }

  const timeoutMs = options.timeoutMs || 60000; // 60s for local generation
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let rawRes;
  try {
    rawRes = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
  } catch (netErr) {
    clearTimeout(timer);
    let msg = netErr.message;
    if (netErr.name === 'AbortError') {
      msg = `Generation timed out after ${timeoutMs / 1000}s on local model "${modelIdentifier}".`;
    } else if (msg.includes('ECONNREFUSED') || msg.includes('Failed to fetch')) {
      msg = `Ollama service unreachable at ${baseUrl}. Ensure Ollama is running.`;
    }
    throw new Error(msg);
  }

  clearTimeout(timer);

  if (!rawRes.ok) {
    const errText = await rawRes.text().catch(() => '');
    throw new Error(`Ollama generation failed (HTTP ${rawRes.status}): ${errText || rawRes.statusText}`);
  }

  const resJson = await rawRes.json();
  let rawOutputText = resJson.response;

  if (!rawOutputText || typeof rawOutputText !== 'string') {
    throw new Error(`Ollama model "${modelIdentifier}" returned an empty response.`);
  }

  // 4. Parse JSON with resilient parser and allow at most ONE controlled correction attempt
  let parsed = null;
  try {
    parsed = extractAndParseJSON(rawOutputText);
  } catch (_) {}

  if (!parsed || typeof parsed !== 'object' || (!parsed.option && !parsed.options && !parsed.answer && !parsed.result)) {
    try {
      const repairRes = await fetch(`${baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelIdentifier,
          prompt: `The previous text was supposed to be a valid JSON quiz answer with keys "option", "options", "answer", "reason". Correct it into strictly valid JSON:\n\n${rawOutputText.slice(0, 600)}`,
          stream: false,
          format: 'json',
          keep_alive: '30m',
          options: { temperature: 0.0, num_predict: 250 }
        }),
        signal: AbortSignal.timeout(8000)
      });
      if (repairRes.ok) {
        const repairJson = await repairRes.json();
        if (repairJson.response) {
          parsed = extractAndParseJSON(repairJson.response);
        }
      }
    } catch (_) {}
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Ollama model "${modelIdentifier}" returned an incomplete or malformed response.`);
  }

  const normalized = verifyAndNormalizeAnswer(parsed, payload, domain);

  return {
    ...normalized,
    realUsage: {
      provider: 'ollama',
      modelUsed: modelIdentifier,
      totalTokens: (resJson.prompt_eval_count || 0) + (resJson.eval_count || 0)
    }
  };
}
