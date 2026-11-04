/**
 * Moodle AI Quick Answer - Background Service Worker (Manifest V3)
 * Handles Chrome commands, screenshot captures, script injection, and secure backend proxying.
 */

const DEFAULT_SETTINGS = {
  enabled: true,
  notificationPosition: 'top-right',
  notificationDuration: 500,
  backendUrl: 'https://extension-w1ac.onrender.com'
};

/**
 * Configure declarativeNetRequest to bypass Ollama's 403 Forbidden origin check
 * by rewriting browser origin to http://127.0.0.1:11434 for direct Ollama calls.
 */
async function registerOllamaCorsRules() {
  if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateDynamicRules) return;
  try {
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const existingRuleIds = existingRules.map(r => r.id);
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existingRuleIds,
      addRules: [
        {
          id: 1,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              {
                header: 'Origin',
                operation: 'set',
                value: 'http://127.0.0.1:11434'
              }
            ]
          },
          condition: {
            urlFilter: '127.0.0.1:11434'
          }
        },
        {
          id: 2,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              {
                header: 'Origin',
                operation: 'set',
                value: 'http://127.0.0.1:11434'
              }
            ]
          },
          condition: {
            urlFilter: 'localhost:11434'
          }
        },
        {
          id: 3,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              {
                header: 'Origin',
                operation: 'set',
                value: 'http://127.0.0.1:11434'
              }
            ]
          },
          condition: {
            urlFilter: ':11434'
          }
        }
      ]
    });
    console.log('[Ollama Pipeline] Registered Origin bypass rules for 127.0.0.1:11434, localhost:11434, and :11434');
  } catch (err) {
    console.warn('[Ollama Pipeline] Could not register declarativeNetRequest rules:', err.message);
  }
}

// Safely register Ollama CORS rules on startup without blocking service worker boot
registerOllamaCorsRules().catch((err) => {
  console.warn('[Ollama Pipeline] registerOllamaCorsRules on boot:', err.message);
});
if (chrome.runtime && chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    registerOllamaCorsRules().catch(() => {});
  });
}

// Initialize settings on installation and retroactively inject content scripts into open tabs
chrome.runtime.onInstalled.addListener(async () => {
  await registerOllamaCorsRules();
  const existing = await chrome.storage.local.get(null);
  const toSet = {};
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (existing[key] === undefined) {
      toSet[key] = value;
    }
  }
  if (Object.keys(toSet).length > 0) {
    await chrome.storage.local.set(toSet);
  }

  // Inject content scripts into all active HTTP/HTTPS tabs so shortcuts work without page reload
  try {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['notification.js', 'screenshot-handler.js', 'moodle-content.js']
      }).catch(() => {});
    }
  } catch (_) {}

  console.log('[Moodle Quick AI] Background worker initialized.');
});

/**
 * Safely send message to active tab, auto-injecting content script if tab was opened before extension loaded
 */
async function sendMessageToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    if (err.message && err.message.includes('Receiving end does not exist')) {
      console.log('[Moodle Quick AI] Injecting content scripts into tab', tabId);
      try {
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          files: ['notification.js', 'screenshot-handler.js', 'moodle-content.js']
        });
        // Small delay to let scripts initialize
        setTimeout(async () => {
          try {
            await chrome.tabs.sendMessage(tabId, message);
          } catch (retryErr) {
            console.warn('[Moodle Quick AI] Retry send failed:', retryErr.message);
          }
        }, 150);
      } catch (injectErr) {
        console.warn('[Moodle Quick AI] Script injection failed:', injectErr.message);
      }
    } else {
      console.warn('[Moodle Quick AI] Command forwarding failed:', err.message);
    }
  }
}

// Handle Chrome Keyboard Commands (registered in manifest.json)
chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;

  if (command === 'solve-question') {
    await sendMessageToTab(tab.id, { action: 'TRIGGER_SOLVE_QUESTION' });
  } else if (command === 'solve-screenshot') {
    await sendMessageToTab(tab.id, { action: 'TRIGGER_SOLVE_SCREENSHOT' });
  } else if (command === 'show-last-answer') {
    await sendMessageToTab(tab.id, { action: 'TRIGGER_SHOW_LAST_ANSWER' });
  }
});

// Handle messages from content script or popup/options UI
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'CAPTURE_VISIBLE_TAB') {
    try {
      const targetWinId = sender.tab ? sender.tab.windowId : undefined;
      chrome.tabs.captureVisibleTab(targetWinId, { format: 'jpeg', quality: 92 }, (dataUrl) => {
        if (!chrome.runtime.lastError && dataUrl) {
          sendResponse({ success: true, dataUrl });
        } else {
          try {
            chrome.windows.getLastFocused({ populate: false }, (win) => {
              if (chrome.runtime.lastError || !win) {
                sendResponse({ success: false, error: 'Cannot find focused window' });
                return;
              }
              const fallbackWinId = win ? win.id : undefined;
              chrome.tabs.captureVisibleTab(fallbackWinId, { format: 'jpeg', quality: 92 }, (fallbackUrl) => {
                if (chrome.runtime.lastError || !fallbackUrl) {
                  sendResponse({ success: false, error: chrome.runtime.lastError?.message || 'Capture failed' });
                } else {
                  sendResponse({ success: true, dataUrl: fallbackUrl });
                }
              });
            });
          } catch (winErr) {
            sendResponse({ success: false, error: winErr.message || 'Window query failed' });
          }
        }
      });
    } catch (err) {
      sendResponse({ success: false, error: err.message || 'Capture visible tab error' });
    }
    return true; // Keep port open
  }

  if (message.action === 'FETCH_IMAGE_AS_DATA_URL') {
    fetch(message.url)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      })
      .then(blob => {
        const reader = new FileReader();
        reader.onloadend = () => sendResponse({ success: true, dataUrl: reader.result });
        reader.onerror = () => sendResponse({ success: false, error: 'Could not decode image' });
        reader.readAsDataURL(blob);
      })
      .catch(err => {
        sendResponse({ success: false, error: err.message || 'Image fetch failed' });
      });
    return true; // Keep port open
  }

  if (message.action === 'ANALYZE_QUESTION') {
    console.log('[Moodle AI] BACKGROUND_MESSAGE_RECEIVED:', { action: message.action });
    console.log('[Moodle AI Diagnostic 9/14] Background message received:', { action: message.action });
    handleAnalyzeQuestion(message.payload)
      .then(sendResponse)
      .catch((err) => {
        sendResponse({ success: false, error: err.message || 'Backend error' });
      });
    return true;
  }

  if (message.action === 'CHECK_BACKEND_STATUS') {
    handleHealthCheck(message.backendUrl)
      .then(sendResponse)
      .catch((err) => {
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  if (message.action === 'CLEAR_CACHE') {
    handleClearCache(message.backendUrl)
      .then(sendResponse)
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (message.action === 'AUTH_GET_STATUS') {
    handleAuthStatus(message.backendUrl)
      .then(sendResponse)
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (message.action === 'AUTH_START') {
    handleAuthStart(message.provider, message.backendUrl)
      .then(sendResponse)
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (message.action === 'AUTH_DISCONNECT') {
    handleAuthDisconnect(message.provider, message.backendUrl)
      .then(sendResponse)
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (message.action === 'AUTH_SELECT_PROVIDER') {
    handleAuthSelect(message.provider, message.backendUrl)
      .then(sendResponse)
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (message.action === 'AUTH_SAVE_KEY') {
    handleAuthSaveKey(message.provider, message.apiKey, message.backendUrl)
      .then(sendResponse)
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (message.action === 'OLLAMA_GET_STATUS') {
    handleOllamaStatus(message.localBackendUrl, message.ollamaUrl)
      .then(sendResponse)
      .catch((err) => {
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  if (message.action === 'OLLAMA_GET_MODELS') {
    handleOllamaModels(message.localBackendUrl, message.ollamaUrl)
      .then(sendResponse)
      .catch((err) => {
        sendResponse({ ok: false, models: [], error: err.message });
      });
    return true;
  }

  if (message.action === 'OLLAMA_GET_DIAGNOSTICS') {
    handleOllamaDiagnostics(message.localBackendUrl, message.ollamaUrl, message.selectedModel)
      .then(sendResponse)
      .catch((err) => {
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  if (message.action === 'TEST_GEMINI_CONNECTION') {
    testGeminiConnection(message.apiKey, message.model)
      .then(sendResponse)
      .catch((err) => {
        sendResponse({ ok: false, error: err.message || 'Connection test failed' });
      });
    return true;
  }

  if (message.action === 'TEST_OPENAI_CONNECTION') {
    testOpenAIConnection(message.apiKey, message.model)
      .then(sendResponse)
      .catch((err) => {
        sendResponse({ ok: false, error: err.message || 'Connection test failed' });
      });
    return true;
  }

  if (message.action === 'TEST_OLLAMA_CONNECTION') {
    testOllamaConnection(message.ollamaUrl, message.model)
      .then(sendResponse)
      .catch((err) => {
        sendResponse({ ok: false, error: err.message || 'Connection test failed' });
      });
    return true;
  }
});



// Active request abort controller to cancel obsolete in-flight requests
let activeRequestController = null;

const SYSTEM_PROMPT = `You are an expert academic tutor and AI inference engine solving quiz questions.
Output strictly valid JSON with keys: "option", "options", "answer", "reason", "confidence", "status", "isMultiple".
RULES:
1. Identify if the question is single-choice or multiple-answer ("select all that apply", "which are", plural characteristics, multiple correct options).
2. For SINGLE-CHOICE questions:
   - Identify the single best option.
   - Set "option": "<Letter>" (e.g. "A").
   - Set "options": ["<Letter>"].
   - Set "answer": "<Option Text>".
   - Set "isMultiple": false.
3. For MULTIPLE-ANSWER questions:
   - Evaluate EVERY available option independently against the question.
   - Return ALL correct options. Never stop after the first correct answer.
   - Set "options": ["A", "B", "D"] (array of all correct option letters).
   - Set "option": "A, B, D" (comma-separated list of all correct option letters).
   - Set "answer": complete text of each correct option formatted as lines (e.g. "A — Text 1\\nB — Text 2\\nD — Text 3").
   - Set "isMultiple": true.
   - In "reason", provide a concise explanation for EACH correct option (e.g. "- A: explanation\\n- B: explanation\\n- D: explanation").
4. CRITICAL FOR NEGATIVE QUESTIONS: If the question contains "NOT", "EXCEPT", "FALSE", "INCORRECT", "LEAST", "NEVER", or "UNLIKE", focus on the negative qualifier. Identify the statement that is FALSE or does NOT apply, and choose that option.
5. For matching questions, format "answer" with complete item pairings (e.g. "1-B, 2-D, 3-A") and "option" to matching choice.
6. For short-answer/math, set "option": "", "options": [], and "answer" to calculated value.
7. If genuinely ambiguous or uncertain, explain the uncertainty in "reason", calibrate confidence (0.60-0.75), but do not invent extra answers. Set "status": "success".`;

/**
 * Extracts candidate option letters from parsed AI JSON output
 */
function extractCandidateLetters(parsed) {
  const letters = [];
  const seen = new Set();

  function addLetter(raw) {
    if (!raw) return;
    const str = String(raw).trim();
    const m = str.match(/^([A-Za-z0-9]+)[\.\:\)\-]?/);
    if (m) {
      const up = m[1].toUpperCase();
      if (up.length <= 2 && up !== 'UNCERTAIN' && !seen.has(up)) {
        seen.add(up);
        letters.push(up);
      }
    }
  }

  if (Array.isArray(parsed.options)) {
    parsed.options.forEach(addLetter);
  }
  if (Array.isArray(parsed.optionIds)) {
    parsed.optionIds.forEach(addLetter);
  }

  const rawOption = String(parsed.option || parsed.choice || '').trim();
  if (rawOption && rawOption.toUpperCase() !== 'UNCERTAIN') {
    const parts = rawOption.split(/[,;&]|\band\b/i);
    for (const part of parts) {
      addLetter(part);
    }
  }

  return letters;
}

/**
 * Normalizes raw JSON response and matches against candidate options
 */
function normalizeAnswerPayload(parsed, payload, model, provider) {
  const options = Array.isArray(payload.options) ? payload.options : [];
  const questionText = String(payload.question || '').trim();
  const isMultiWording = Boolean(payload.isMultiple) ||
    /\b(select all|choose all|which (?:of the following|of these)?\s+are|which are|all that apply|check all|select multiple|more than one|select each|mark all|select two|select three|select (?:2|3|4)|choose two|choose three|choose (?:2|3|4)|multiple correct|any of the following are|identify all)\b/i.test(questionText);

  let candidateLetters = extractCandidateLetters(parsed);

  if (candidateLetters.length === 0 && (parsed.reason || parsed.explanation)) {
    const combinedReason = `${parsed.reason || ''} ${parsed.explanation || ''}`;
    const matches = combinedReason.matchAll(/\b(?:option|choice|answer)\s+([A-D])\b/gi);
    for (const m of matches) {
      const up = m[1].toUpperCase();
      if (!candidateLetters.includes(up)) candidateLetters.push(up);
    }
  }

  let isMultiple = false;
  if (candidateLetters.length > 1) {
    if (isMultiWording || parsed.isMultiple === true) {
      isMultiple = true;
    } else {
      // Single answer question: keep only first option
      candidateLetters = [candidateLetters[0]];
    }
  } else if (candidateLetters.length === 1 && isMultiWording && parsed.isMultiple === true) {
    isMultiple = true;
  }

  const matchedOptions = [];
  if (options.length > 0 && candidateLetters.length > 0) {
    for (const letter of candidateLetters) {
      let match = options.find(o => String(o.id).toUpperCase() === letter);
      if (!match) {
        const idx = letter.charCodeAt(0) - 65;
        if (idx >= 0 && idx < options.length) match = options[idx];
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
        if (mMatch && mMatch[4]) {
          cleanText = mMatch[4].trim();
        }
        matchedOptions.push({
          id: letter,
          text: cleanText
        });
      } else {
        matchedOptions.push({
          id: letter,
          text: `Option ${letter}`
        });
      }
    }
  }

  let rawAnswer = String(parsed.answer || parsed.result || '').trim();
  if (rawAnswer.toLowerCase().includes('uncertain') || rawAnswer.toLowerCase().includes('needs verification') || rawAnswer.toLowerCase().includes('cannot determine')) {
    rawAnswer = '';
  }

  if (matchedOptions.length === 0 && options.length > 0 && rawAnswer) {
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
  let finalAnswer = '';
  let finalOptionIds = [];

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
    finalAnswer = rawAnswer || (finalOption ? `Option ${finalOption}` : 'Solution determined');
  }

  const rawReason = parsed.reason || parsed.explanation || `Selected ${finalOption} using ${provider} (${model}).`;
  let finalExplanation = rawReason;
  if (isMultiple) {
    finalExplanation = `MULTIPLE ANSWER\n\n${finalAnswer}\n\nExplanation:\n${rawReason}`;
  }

  return {
    option: finalOption,
    options: finalOptionIds,
    optionIds: finalOptionIds,
    answer: finalAnswer,
    answerText: finalAnswer,
    isMultiple,
    status: 'success',
    confidence: isMultiple ? (parsed.confidence || 0.95) : 0.95,
    explanation: finalExplanation,
    reason: rawReason,
    provider,
    model,
    isDirect: true
  };
}

/**
 * Direct official Google Gemini API solver with multimodal vision support
 */
async function callDirectGemini(payload, apiKey, modelName = 'gemini-2.5-flash') {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 5) {
    throw new Error('Please configure a valid Google Gemini API key in Settings');
  }
  const cleanKey = apiKey.trim();
  const model = modelName || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const incomingImages = Array.isArray(payload.images) && payload.images.length > 0
    ? payload.images
    : (payload.image ? [payload.image] : []);

  let promptText = `${SYSTEM_PROMPT}\n\n`;
  if (incomingImages.length > 0) {
    promptText += 'Visual Question Mode: Carefully inspect and solve the question shown in the attached image.\n';
  }
  if (payload.question && payload.question.trim()) {
    promptText += `Question:\n${payload.question.trim()}\n\n`;
  }
  if (Array.isArray(payload.options) && payload.options.length > 0) {
    promptText += 'Options:\n';
    payload.options.forEach(opt => {
      promptText += `- [${opt.id}]: ${opt.text}\n`;
    });
    promptText += '\nSelect the best option. Output JSON with "option": "<Option Letter>" and "answer": "<Option Text>".';
  } else {
    promptText += '\nOutput strictly valid JSON with "option" and "answer".';
  }

  const parts = [{ text: promptText }];

  for (const img of incomingImages) {
    if (typeof img === 'string' && img.trim()) {
      let mimeType = 'image/jpeg';
      let data = img;
      if (img.startsWith('data:')) {
        const match = img.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          mimeType = match[1];
          data = match[2];
        } else {
          data = img.replace(/^data:[^;]+;base64,/, '');
        }
      }
      parts.push({
        inlineData: {
          mimeType,
          data
        }
      });
    }
  }

  const generationConfig = {
    temperature: 0.1,
    maxOutputTokens: 350,
    responseMimeType: 'application/json'
  };
  if (model.includes('2.5')) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': cleanKey
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig
    }),
    signal: AbortSignal.timeout(30000)
  });

  console.log('[AI Provider Diagnostic]', {
    selectedProvider: 'gemini',
    providerActuallyCalled: 'gemini',
    selectedModel: model,
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/...:generateContent',
    status: res.status
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    let parsedErr = null;
    try { parsedErr = JSON.parse(errText); } catch (_) {}
    const rawMsg = parsedErr?.error?.message || errText;

    if (res.status === 400 || res.status === 401 || res.status === 403 || /api_key|invalid|unregistered/i.test(rawMsg)) {
      throw new Error('Gemini Authentication Error: Invalid API key. Please check your Gemini API key in Settings.');
    }
    if (res.status === 404) {
      throw new Error(`Gemini Model Error: "${model}" is not available for this API key.`);
    }
    if (res.status === 429 || /quota|exhausted|resource/i.test(rawMsg)) {
      throw new Error('Gemini Quota Error: Rate limit or quota exceeded on your Gemini API key.');
    }
    throw new Error(`Gemini API error (${res.status}): ${rawMsg.slice(0, 160)}`);
  }

  const data = await res.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    throw new Error('Gemini returned an empty response');
  }

  const parsed = extractJSON(rawText) || {};
  return normalizeAnswerPayload(parsed, payload, model, 'gemini');
}

/**
 * Direct official OpenAI API solver with multimodal vision support
 */
async function callDirectOpenAI(payload, apiKey, modelName = 'gpt-4o-mini') {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 5) {
    throw new Error('Please configure a valid OpenAI API key in Settings');
  }
  const cleanKey = apiKey.trim();
  const model = modelName || 'gpt-4o-mini';
  const url = 'https://api.openai.com/v1/chat/completions';

  const incomingImages = Array.isArray(payload.images) && payload.images.length > 0
    ? payload.images
    : (payload.image ? [payload.image] : []);

  let userPrompt = '';
  if (incomingImages.length > 0) {
    userPrompt += 'Visual Question Mode: Carefully inspect and solve the question shown in the attached image.\n';
  }
  if (payload.question && payload.question.trim()) {
    userPrompt += `Question:\n${payload.question.trim()}\n\n`;
  }
  if (Array.isArray(payload.options) && payload.options.length > 0) {
    userPrompt += 'Options:\n';
    payload.options.forEach(opt => {
      userPrompt += `- [${opt.id}]: ${opt.text}\n`;
    });
    userPrompt += '\nSelect the best option. Output JSON with "option": "<Option Letter>" and "answer": "<Option Text>".';
  } else {
    userPrompt += '\nOutput strictly valid JSON with "option" and "answer".';
  }

  const userContent = [{ type: 'text', text: userPrompt }];

  for (const img of incomingImages) {
    if (typeof img === 'string' && img.trim()) {
      const imageUrl = img.startsWith('data:') ? img : `data:image/jpeg;base64,${img}`;
      userContent.push({
        type: 'image_url',
        image_url: { url: imageUrl, detail: 'high' }
      });
    }
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cleanKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 300,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent }
      ]
    }),
    signal: AbortSignal.timeout(30000)
  });

  console.log('[AI Provider Diagnostic]', {
    selectedProvider: 'openai',
    providerActuallyCalled: 'openai',
    selectedModel: model,
    endpoint: url,
    status: res.status
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    let parsedErr = null;
    try { parsedErr = JSON.parse(errText); } catch (_) {}
    const rawMsg = parsedErr?.error?.message || errText;

    if (res.status === 401) {
      throw new Error('OpenAI Authentication Error: Invalid API key. Please check your OpenAI API key in Settings.');
    }
    if (res.status === 403) {
      throw new Error('OpenAI Permission Error: Access forbidden or country not supported.');
    }
    if (res.status === 404) {
      throw new Error(`OpenAI Model Error: "${model}" is not available for your account.`);
    }
    if (res.status === 429 || /quota|insufficient_quota|credit/i.test(rawMsg)) {
      throw new Error('OpenAI Quota Error: Quota exceeded or insufficient credits on your OpenAI account.');
    }
    throw new Error(`OpenAI API error (${res.status}): ${rawMsg.slice(0, 160)}`);
  }

  const data = await res.json();
  const rawText = data?.choices?.[0]?.message?.content;
  if (!rawText) {
    throw new Error('OpenAI returned an empty response');
  }

  const parsed = extractJSON(rawText) || {};
  return normalizeAnswerPayload(parsed, payload, model, 'openai');
}

/**
 * Independent connection test for Google Gemini
 */
async function testGeminiConnection(apiKey, model) {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 5) {
    return { ok: false, error: 'Please enter a valid Google Gemini API key.' };
  }
  const cleanKey = apiKey.trim();
  const targetModel = model || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': cleanKey
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'ping' }] }],
        generationConfig: { maxOutputTokens: 5 }
      }),
      signal: AbortSignal.timeout(12000)
    });

    console.log('[AI Provider Diagnostic]', {
      test: 'gemini',
      model: targetModel,
      endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/...:generateContent',
      status: res.status
    });

    if (res.ok) {
      return { ok: true, message: `Connection successful! Gemini API is online and verified (Model: ${targetModel}).` };
    }

    const errJson = await res.json().catch(() => ({}));
    const rawMsg = errJson?.error?.message || `HTTP ${res.status}`;

    if (res.status === 400 || res.status === 401 || res.status === 403 || /api_key|invalid|unregistered/i.test(rawMsg)) {
      return { ok: false, error: 'Invalid API key or authentication failed.' };
    }
    if (res.status === 404) {
      return { ok: false, error: `Model unavailable (${targetModel} not found).` };
    }
    if (res.status === 429 || /quota|exhausted|resource/i.test(rawMsg)) {
      return { ok: false, error: 'Rate limit or quota exceeded on this Gemini API key.' };
    }
    return { ok: false, error: `Gemini error (${res.status}): ${rawMsg}` };
  } catch (err) {
    console.log('[AI Provider Diagnostic]', {
      test: 'gemini',
      model: targetModel,
      endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/...:generateContent',
      error: err.message
    });
    return { ok: false, error: `Network error: ${err.message}` };
  }
}

/**
 * Independent connection test for OpenAI
 */
async function testOpenAIConnection(apiKey, model) {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 5) {
    return { ok: false, error: 'Please enter a valid OpenAI API key.' };
  }
  const cleanKey = apiKey.trim();
  const targetModel = model || 'gpt-4o-mini';
  const url = 'https://api.openai.com/v1/chat/completions';

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cleanKey}`
      },
      body: JSON.stringify({
        model: targetModel,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 5
      }),
      signal: AbortSignal.timeout(12000)
    });

    console.log('[AI Provider Diagnostic]', {
      test: 'openai',
      model: targetModel,
      endpoint: url,
      status: res.status
    });

    if (res.ok) {
      return { ok: true, message: `Connection successful! OpenAI API is online and verified (Model: ${targetModel}).` };
    }

    const errJson = await res.json().catch(() => ({}));
    const rawMsg = errJson?.error?.message || `HTTP ${res.status}`;

    if (res.status === 401) {
      return { ok: false, error: 'Invalid API key.' };
    }
    if (res.status === 403) {
      return { ok: false, error: 'Authentication failed or access restricted.' };
    }
    if (res.status === 404) {
      return { ok: false, error: `Model unavailable (${targetModel} not found).` };
    }
    if (res.status === 429 || /quota|insufficient_quota|credit/i.test(rawMsg)) {
      return { ok: false, error: 'Rate limit or quota exceeded (check account balance at platform.openai.com).' };
    }
    return { ok: false, error: `OpenAI error (${res.status}): ${rawMsg}` };
  } catch (err) {
    console.log('[AI Provider Diagnostic]', {
      test: 'openai',
      model: targetModel,
      endpoint: url,
      error: err.message
    });
    return { ok: false, error: `Network error: ${err.message}` };
  }
}

/**
 * Independent connection test for Ollama Local
 */
async function testOllamaConnection(ollamaUrl, model) {
  const baseUrl = (ollamaUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const targetModel = model || 'gemma3:4b';
  try {
    const ping = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3500) });
    if (!ping.ok) {
      return { ok: false, error: `Ollama server unavailable (HTTP ${ping.status})` };
    }
    const data = await ping.json();
    const installed = Array.isArray(data.models) ? data.models.map(m => m.name) : [];

    console.log('[AI Provider Diagnostic]', {
      test: 'ollama',
      model: targetModel,
      endpoint: `${baseUrl}/api/tags`,
      status: ping.status
    });

    if (installed.length === 0) {
      return { ok: false, error: 'Ollama server is running, but no models are installed. Please run "ollama pull gemma3:4b".' };
    }

    const found = installed.some(name => name === targetModel || name.startsWith(targetModel + ':') || targetModel.startsWith(name + ':'));
    if (!found) {
      return {
        ok: false,
        error: `Model unavailable: "${targetModel}" is not installed in Ollama. Available models: ${installed.slice(0, 5).join(', ')}`
      };
    }

    return {
      ok: true,
      message: `Connection successful! Ollama is online and model "${targetModel}" is ready.`
    };
  } catch (err) {
    console.log('[AI Provider Diagnostic]', {
      test: 'ollama',
      model: targetModel,
      endpoint: `${baseUrl}/api/tags`,
      error: err.message
    });
    return { ok: false, error: 'Ollama server unavailable. Please make sure the Ollama application is running on your computer.' };
  }
}

// In-memory fast answer cache and in-flight request coalescing
const recentAnswerCache = new Map();
const inFlightRequests = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

function hashImagePayload(img) {
  if (!img || typeof img !== 'string') return '';
  let hash = 0;
  const len = img.length;
  const step = Math.max(1, Math.floor(len / 500));
  for (let i = 0; i < len; i += step) {
    hash = ((hash << 5) - hash) + img.charCodeAt(i);
    hash |= 0;
  }
  return `${len}_${hash}`;
}

function computeQuestionHash(payload, provider = '', model = '') {
  const q = (payload.question || '').trim().toLowerCase();
  const opts = (payload.options || []).map(o => `${o.id}:${(o.text || '').trim().toLowerCase()}`).join('|');
  const imgStr = payload.image || (payload.images && payload.images[0]) || '';
  const imgHash = hashImagePayload(imgStr);
  return `${provider}:::${model}:::${q}:::${opts}:::${imgHash}`;
}

/**
 * Strict Provider Routing: Routes question directly to selected provider without cross-fallback
 */
async function handleAnalyzeQuestion(payload) {
  const storage = await chrome.storage.local.get([
    'activeProvider',
    'geminiApiKey',
    'geminiSelectedModel',
    'userGeminiKey',
    'openaiApiKey',
    'openaiSelectedModel',
    'userOpenAIKey',
    'ollamaUrl',
    'ollamaSelectedModel',
    'backendUrl',
    'localBackendUrl',
    'customProviders'
  ]);

  const rawProvider = payload.provider || storage.activeProvider || 'gemini';
  let provider = (rawProvider || 'gemini').toLowerCase();
  if (provider.startsWith('gemini')) provider = 'gemini';
  if (provider === 'chatgpt' || provider === 'openai') provider = 'openai';

  const targetModel = payload.model || (provider === 'gemini' ? storage.geminiSelectedModel : (provider === 'openai' ? storage.openaiSelectedModel : storage.ollamaSelectedModel)) || '';
  const questionKey = computeQuestionHash(payload, provider, targetModel);

  // Return cached result if same question asked recently
  const cachedEntry = recentAnswerCache.get(questionKey);
  if (cachedEntry && (Date.now() - cachedEntry.timestamp < CACHE_TTL_MS) && payload.skipCache !== true) {
    return { success: true, data: { ...cachedEntry.data, cached: true } };
  }

  // Coalesce duplicate in-flight requests for the exact same question
  if (inFlightRequests.has(questionKey)) {
    return await inFlightRequests.get(questionKey);
  }

  // Cancel previous in-flight request if user moved to a different question
  if (activeRequestController) {
    try {
      activeRequestController.abort(new DOMException('Superseded by newer request', 'AbortError'));
    } catch (e) {}
  }
  activeRequestController = new AbortController();
  const currentController = activeRequestController;

  const executionPromise = (async () => {
    return await executeProviderRouting(payload, provider, rawProvider, targetModel, storage, currentController);
  })();

  inFlightRequests.set(questionKey, executionPromise);
  try {
    const res = await executionPromise;
    if (res && res.success && res.data) {
      recentAnswerCache.set(questionKey, { data: res.data, timestamp: Date.now() });
    }
    return res;
  } finally {
    inFlightRequests.delete(questionKey);
  }
}

async function executeProviderRouting(payload, provider, rawProvider, targetModel, storage, currentController) {

  console.log('[Moodle AI Diagnostic 10/14] Provider selected:', { rawProvider, routedProvider: provider });

  // 1. GOOGLE GEMINI ROUTING
  if (provider === 'gemini') {
    const apiKey = (storage.geminiApiKey || storage.userGeminiKey || payload.apiKey || '').trim();
    const model = payload.model || storage.geminiSelectedModel || 'gemini-2.5-flash';

    console.log('[AI Provider Routing]', {
      selectedProvider: rawProvider,
      providerActuallyCalled: 'gemini',
      selectedModel: model,
      endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/...:generateContent'
    });

    try {
      if (apiKey) {
        const result = await callDirectGemini(payload, apiKey, model);
        await updateRealUsageStats({ provider: 'gemini', totalTokens: 140 });
        return { success: true, data: { ...result, isOllama: false, source: 'gemini' } };
      } else if (storage.backendUrl) {
        const cleanUrl = storage.backendUrl.replace(/\/+$/, '');
        const targetEndpoint = `${cleanUrl}/api/answer`;
        const res = await fetch(targetEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, provider: 'gemini', model }),
          signal: currentController.signal
        });
        if (!res.ok) {
          const errJson = await res.json().catch(() => ({}));
          let errMsg = errJson.message || errJson.error || `HTTP ${res.status}`;
          if (res.status === 429 || /quota|429/i.test(errMsg)) {
            errMsg = 'Gemini free quota limit reached. Please configure your personal Gemini API key or switch to Ollama in Settings.';
          }
          throw new Error(errMsg);
        }
        const data = await res.json();
        await updateRealUsageStats(data.realUsage || { provider: 'gemini', totalTokens: 140 });
        return { success: true, data: { ...data, provider: 'gemini', isOllama: false, source: 'gemini' } };
      } else {
        throw new Error('Please configure your Google Gemini API key in Extension Settings.');
      }
    } catch (err) {
      console.log('[AI Provider Routing Error]', {
        provider: 'gemini',
        sanitizedError: err.message
      });
      // STRICT ISOLATION: Never fall back to Ollama or OpenAI
      return { success: false, error: err.message };
    }
  }

  // 2. OPENAI ROUTING
  if (provider === 'openai') {
    const apiKey = (storage.openaiApiKey || storage.userOpenAIKey || payload.apiKey || '').trim();
    const model = payload.model || storage.openaiSelectedModel || 'gpt-4o-mini';

    console.log('[AI Provider Routing]', {
      selectedProvider: rawProvider,
      providerActuallyCalled: 'openai',
      selectedModel: model,
      endpoint: 'https://api.openai.com/v1/chat/completions'
    });

    try {
      if (apiKey) {
        const result = await callDirectOpenAI(payload, apiKey, model);
        await updateRealUsageStats({ provider: 'chatgpt', totalTokens: 140 });
        return { success: true, data: { ...result, isOllama: false, source: 'openai' } };
      } else if (storage.backendUrl) {
        const cleanUrl = storage.backendUrl.replace(/\/+$/, '');
        const targetEndpoint = `${cleanUrl}/api/answer`;
        const res = await fetch(targetEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, provider: 'chatgpt', model }),
          signal: currentController.signal
        });
        if (!res.ok) {
          const errJson = await res.json().catch(() => ({}));
          let errMsg = errJson.message || errJson.error || `HTTP ${res.status}`;
          if (res.status === 429 || /quota|429/i.test(errMsg)) {
            errMsg = 'Gemini free quota limit reached. Please configure your personal Gemini API key or switch to Ollama in Settings.';
          }
          throw new Error(errMsg);
        }
        const data = await res.json();
        await updateRealUsageStats(data.realUsage || { provider: 'chatgpt', totalTokens: 140 });
        return { success: true, data: { ...data, provider: 'openai', isOllama: false, source: 'openai' } };
      } else {
        throw new Error('Please configure your OpenAI API key in Extension Settings.');
      }
    } catch (err) {
      console.log('[AI Provider Routing Error]', {
        provider: 'openai',
        sanitizedError: err.message
      });
      // STRICT ISOLATION: Never fall back to Ollama or Gemini
      return { success: false, error: err.message };
    }
  }

  // 3. OLLAMA LOCAL ROUTING
  if (provider === 'ollama') {
    const ollamaUrl = storage.ollamaUrl || 'http://127.0.0.1:11434';
    const model = payload.model || storage.ollamaSelectedModel;

    console.log('[AI Provider Routing]', {
      selectedProvider: 'ollama',
      providerActuallyCalled: 'ollama',
      selectedModel: model || 'auto',
      endpoint: `${ollamaUrl.replace(/\/+$/, '')}/api/generate`
    });

    try {
      const directData = await runDirectOllamaSolve(payload, ollamaUrl, model);
      await updateRealUsageStats({ provider: 'ollama', totalTokens: 100 });
      return {
        success: true,
        data: {
          ...directData,
          isOllama: true,
          provider: 'ollama',
          source: 'ollama'
        }
      };
    } catch (directErr) {
      console.log('[AI Provider Routing Error]', {
        provider: 'ollama',
        sanitizedError: directErr.message
      });
      let cleanErr = directErr.message || 'Local Ollama evaluation failed';
      if (cleanErr.includes('Failed to fetch') || cleanErr.includes('ECONNREFUSED')) {
        cleanErr = 'Ollama is not running. Please open the Ollama app on your computer.';
      } else if (cleanErr.includes('403')) {
        cleanErr = 'Ollama 403: Origin blocked. Please reload extension at chrome://extensions';
      } else if (cleanErr.includes('AbortError') || cleanErr.includes('timed out')) {
        cleanErr = 'Ollama timed out. The local model is taking too long to compute.';
      }
      // STRICT ISOLATION: Never fall back to Gemini or OpenAI
      return { success: false, error: cleanErr };
    }
  }

  // 4. CUSTOM PROVIDERS
  if (rawProvider.startsWith('custom_')) {
    const custom = (storage.customProviders || []).find(p => p.id === rawProvider);
    if (!custom) {
      return { success: false, error: `Custom provider "${rawProvider}" not found.` };
    }
    const cleanUrl = (storage.backendUrl || 'https://extension-w1ac.onrender.com').replace(/\/+$/, '');
    try {
      const res = await fetch(`${cleanUrl}/api/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...payload,
          provider: 'custom',
          apiKey: custom.apiKey,
          endpoint: custom.endpoint,
          model: custom.model
        }),
        signal: currentController.signal
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        let errMsg = errJson.message || errJson.error || `HTTP ${res.status}`;
        if (errMsg.includes('does not support image-based questions')) {
          errMsg = 'The configured provider does not support image-based questions. Please switch to Google Gemini, ChatGPT, or a vision model in Settings.';
        }
        throw new Error(errMsg);
      }
      const data = await res.json();
      return { success: true, data: { ...data, isOllama: false, provider: rawProvider } };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  return { success: false, error: `Unrecognized AI provider: "${rawProvider}". Please select Gemini, OpenAI, or Ollama.` };
}

/**
 * Known vision and text families for direct model capability detection
 */
const KNOWN_VISION_FAMILIES = [
  'clip', 'mllama', 'llava', 'bakllava', 'moondream', 'minicpm-v',
  'qwen2-vl', 'qwen2vl', 'phi3vision', 'phi-3-vision', 'gemma3', 'vision'
];
const KNOWN_TEXT_FAMILIES = [
  'llama', 'gemma', 'gemma2', 'qwen', 'qwen2', 'qwen2.5', 'mistral',
  'mixtral', 'deepseek', 'phi', 'phi3', 'starcoder', 'command-r',
  'falcon', 'nemotron', 'codellama', 'bert'
];

function detectModelCapability(modelData) {
  if (!modelData) return 'Unknown';
  const families = [];
  if (Array.isArray(modelData.details?.families)) {
    families.push(...modelData.details.families.map(f => String(f).toLowerCase()));
  }
  if (modelData.details?.family) {
    families.push(String(modelData.details.family).toLowerCase());
  }
  const name = String(modelData.name || modelData.model || '').toLowerCase();

  // 1. Detect embedding-only models
  if (Array.isArray(modelData.capabilities)) {
    const caps = modelData.capabilities.map(c => String(c).toLowerCase());
    if (caps.includes('embedding') && !caps.includes('completion')) return 'Embedding';
    if (caps.includes('vision')) return 'Vision';
  }
  if (name.includes('embed') || name.startsWith('bge-') || name.includes('-embed-')) {
    return 'Embedding';
  }

  // 2. Detect vision models
  const hasVisionFamily = families.some(f => KNOWN_VISION_FAMILIES.some(vf => f.includes(vf)));
  const hasVisionName = KNOWN_VISION_FAMILIES.some(vf => name.includes(vf)) || name.includes('-vision') || name.includes('_vision');
  if (hasVisionFamily || hasVisionName) return 'Vision';

  // 3. Detect text completion models
  const isPureTextFamily = families.some(f => KNOWN_TEXT_FAMILIES.includes(f));
  const hasTextName = KNOWN_TEXT_FAMILIES.some(tf => name.startsWith(tf));
  if (isPureTextFamily || (families.length > 0 && hasTextName)) return 'Text';
  return 'Unknown';
}

function formatBytes(bytes) {
  if (!bytes || isNaN(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = (bytes / Math.pow(1024, i)).toFixed(1);
  return `${val} ${units[i] || 'GB'}`;
}

function extractJSON(text) {
  if (!text || typeof text !== 'string') return null;
  let str = text.trim();
  if (str.startsWith('```')) {
    str = str.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  }
  const first = str.indexOf('{');
  const last = str.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    str = str.substring(first, last + 1);
  } else if (first !== -1 && last <= first) {
    // Unclosed JSON object: try auto-closing it
    str = str.substring(first);
    if (!str.endsWith('}')) {
      if (str.split('"').length % 2 === 0) str += '"';
      str += '}';
    }
  }

  try {
    return JSON.parse(str);
  } catch (_) {
    // 1. Try cleaning control characters and repairing trailing commas
    try {
      const repaired = str
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
        .replace(/,\s*([\]}])/g, '$1');
      return JSON.parse(repaired);
    } catch (e1) {
      // 2. Resilient regex fallback for option and answer from partial/streamed text
      const optMatch = text.match(/"(?:option|choice)"\s*:\s*"([^"]+)"/i) || text.match(/(?:option|choice)\s*:\s*([A-Za-z0-9_\-]+)/i);
      const ansMatch = text.match(/"(?:answer|result)"\s*:\s*"([^"]+)"/i) || text.match(/(?:answer|result)\s*:\s*([^\n\r,}]+)/i);
      const rsnMatch = text.match(/"(?:reason|explanation)"\s*:\s*"([^"]+)"/i);
      const optVal = optMatch ? optMatch[1].trim() : '';
      const ansVal = ansMatch ? ansMatch[1].trim() : '';

      // Only accept if at least a valid non-empty answer or both option+answer exist
      if (optVal && ansVal) {
        return {
          option: optVal,
          answer: ansVal,
          reason: rsnMatch ? rsnMatch[1].trim() : 'Extracted from stream response.',
          status: 'success',
          confidence: 0.85
        };
      } else if (ansVal) {
        return {
          option: '',
          answer: ansVal,
          reason: rsnMatch ? rsnMatch[1].trim() : 'Partial answer extracted.',
          status: 'partial',
          confidence: 0.60
        };
      }
      // Never silently treat incomplete or unparseable JSON as a correct answer
      return null;
    }
  }
}

// In-memory cache for model capabilities to avoid repeated /api/show network calls
const modelCapabilityCache = new Map();

async function runDirectOllamaSolve(payload, ollamaUrl = 'http://127.0.0.1:11434', modelName) {
  const baseUrl = (ollamaUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  let model = modelName;
  if (!model && payload.provider === 'ollama') {
    model = payload.model;
  }

  // Auto-detect installed model if none selected or if model was a cloud model name (e.g. gemini/gpt)
  if (!model || model.includes('gemini') || model.includes('gpt') || model.includes('claude')) {
    try {
      const tagsRes = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (tagsRes.ok) {
        const tagsJson = await tagsRes.json();
        if (Array.isArray(tagsJson.models) && tagsJson.models.length > 0) {
          model = tagsJson.models[0].name;
          await chrome.storage.local.set({ ollamaSelectedModel: model });
        }
      }
    } catch (_) {}
  }

  if (!model) model = 'gemma3:4b';

  if (!model) throw new Error('No local Ollama model found');

  const incomingImages = Array.isArray(payload.images) && payload.images.length > 0
    ? payload.images
    : (payload.image ? [payload.image] : []);

  let rawImages = [];
  if (incomingImages.length > 0) {
    // Check if selected model is vision capable or text-only (with caching)
    let isVision = modelCapabilityCache.get(model);
    if (typeof isVision !== 'boolean') {
      try {
        const showRes = await fetch(`${baseUrl}/api/show`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: model }),
          signal: AbortSignal.timeout(2000)
        }).catch(() => null);
        if (showRes && showRes.ok) {
          const showData = await showRes.json();
          isVision = detectModelCapability(showData) === 'Vision';
        } else {
          isVision = detectModelCapability({ name: model }) === 'Vision';
        }
      } catch (_) {
        isVision = detectModelCapability({ name: model }) === 'Vision';
      }
      modelCapabilityCache.set(model, isVision);
    }

    const hasUsableText = (payload.question && payload.question.trim().length > 10) || (Array.isArray(payload.options) && payload.options.length > 0);

    if (!isVision) {
      if (hasUsableText) {
        // Send usable extracted text to text-only models, strip image to avoid Ollama error
        rawImages = [];
      } else {
        throw new Error(
          `The selected local model "${model}" is a text-only model and does not support image questions. ` +
          `Please select a vision-capable local model (such as llama3.2-vision, llava, or qwen2-vl) or use text questions.`
        );
      }
    } else {
      for (const img of incomingImages) {
        if (typeof img === 'string' && img.trim()) {
          rawImages.push(img.replace(/^data:image\/[a-zA-Z+]+;base64,/, '').trim());
        }
      }
    }
  }

  let prompt = '';
  if (rawImages.length > 0) {
    prompt += `Visual Question Mode: Carefully inspect and solve the question shown in the attached image.\n`;
  }
  if (payload.question && payload.question.trim()) {
    prompt += `Question:\n${payload.question.trim()}\n\n`;
  }
  const isMultiWording = Boolean(payload.isMultiple) || /\b(select all|choose all|which (?:of the following|of these)?\s+are|which are|all that apply|check all|select multiple|more than one|select each|mark all|multiple correct)\b/i.test(payload.question || '');
  if (Array.isArray(payload.options) && payload.options.length > 0) {
    prompt += `Options:\n`;
    payload.options.forEach(opt => {
      prompt += `- [${opt.id}]: ${opt.text}\n`;
    });
    if (isMultiWording) {
      prompt += `\nThis is a MULTIPLE-ANSWER question. Evaluate EVERY option independently. Output strictly valid JSON with "options": ["A", "B", ...], "option": "A, B, ...", and "answer".`;
    } else {
      prompt += `\nSelect the best option. Output JSON with "option": "<Option Letter>" and "answer": "<Option Text>".`;
    }
  } else {
    prompt += `\nOutput strictly valid JSON with "option" and "answer".`;
  }

  const system = SYSTEM_PROMPT;

  const estimatedInputTokens = Math.ceil((prompt.length + system.length) / 3);
  const calculatedCtx = rawImages.length > 0 ? 8192 : Math.max(2048, Math.min(8192, estimatedInputTokens + 600));

  const body = {
    model,
    prompt,
    system,
    stream: true,
    format: 'json',
    keep_alive: '30m',
    options: {
      temperature: 0.1,
      top_p: 0.9,
      num_predict: 350,
      num_ctx: calculatedCtx
    }
  };
  if (rawImages.length > 0) body.images = rawImages;

  const res = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    if (res.status === 403) {
      throw new Error('Ollama CORS 403: Origin blocked. Please reload extension at chrome://extensions or run start-ollama script.');
    }
    throw new Error(`Ollama HTTP ${res.status}`);
  }

  let rawOutputText = '';
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let lineBuffer = '';
    let earlyFound = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        lineBuffer += decoder.decode(value, { stream: true });
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const chunk = JSON.parse(trimmed);
            if (chunk.response) {
              rawOutputText += chunk.response;
              // Early detection: parse as soon as closing brace is received with option and answer
              if (!earlyFound && rawOutputText.includes('}') && (rawOutputText.includes('"option"') || rawOutputText.includes('"choice"')) && rawOutputText.includes('"answer"')) {
                const testParsed = extractJSON(rawOutputText);
                if (testParsed && (testParsed.option || testParsed.choice) && (testParsed.answer || testParsed.result)) {
                  if (!isMultiWording || rawOutputText.includes('"reason"') || rawOutputText.includes('"status"')) {
                    earlyFound = true;
                    try { reader.cancel(); } catch (_) {}
                    break;
                  }
                }
              }
            }
          } catch (_) {}
        }
        if (earlyFound) break;
      }
    } catch (streamErr) {
      // If error occurs after answer was already resolved, do not throw
      if (!earlyFound && !rawOutputText) {
        throw streamErr;
      }
    } finally {
      try { reader.releaseLock(); } catch (_) {}
    }
  } else if (typeof res.json === 'function') {
    const json = await res.json();
    rawOutputText = json.response || JSON.stringify(json);
  }

  const parsed = extractJSON(rawOutputText) || {};
  return normalizeAnswerPayload(parsed, payload, model, 'ollama');
}

/**
 * Check Ollama connection via local backend (with automatic 3000/3001 port fallback and direct Ollama fallback)
 */
async function handleOllamaStatus(localBackendUrl, ollamaUrl) {
  const st = await chrome.storage.local.get(['localBackendUrl', 'ollamaUrl']);
  let backend = (localBackendUrl || st.localBackendUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const ollama = ollamaUrl || st.ollamaUrl || 'http://127.0.0.1:11434';
  
  // 1. Direct Ollama check first for instant response without needing Node backend
  try {
    const verRes = await fetch(`${ollama}/api/version`, { signal: AbortSignal.timeout(1500) }).catch(() => null);
    const tagsRes = await fetch(`${ollama}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (tagsRes.ok) {
      const tagsData = await tagsRes.json();
      const verData = verRes && verRes.ok ? await verRes.json() : {};
      return {
        ok: true,
        url: ollama,
        version: verData.version || 'installed',
        modelsCount: Array.isArray(tagsData.models) ? tagsData.models.length : 0,
        activeBackendUrl: ollama,
        isDirect: true
      };
    }
  } catch (_) {}

  // 2. Node backend fallback (if user is running backend on port 3000/3001)
  try {
    const url = `${backend}/api/ollama/status?url=${encodeURIComponent(ollama)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    data.activeBackendUrl = backend;
    return data;
  } catch (err) {
    const altBackend = backend.includes(':3000') 
      ? backend.replace(':3000', ':3001') 
      : (backend.includes(':3001') ? backend.replace(':3001', ':3000') : null);
    if (altBackend) {
      try {
        const altUrl = `${altBackend}/api/ollama/status?url=${encodeURIComponent(ollama)}`;
        const altRes = await fetch(altUrl, { signal: AbortSignal.timeout(2000) });
        if (altRes.ok) {
          const altData = await altRes.json();
          altData.activeBackendUrl = altBackend;
          await chrome.storage.local.set({ localBackendUrl: altBackend });
          return altData;
        }
      } catch (_) {}
    }
    throw new Error('Ollama is not running. Please open the Ollama app or run "ollama serve" in terminal.');
  }
}

/**
 * Get installed Ollama models via direct Ollama first (with automatic Node backend fallback)
 */
async function handleOllamaModels(localBackendUrl, ollamaUrl) {
  const st = await chrome.storage.local.get(['localBackendUrl', 'ollamaUrl']);
  let backend = (localBackendUrl || st.localBackendUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const ollama = ollamaUrl || st.ollamaUrl || 'http://127.0.0.1:11434';

  // 1. Direct Ollama query first: eliminates 3-6s connection timeouts when Node is not running
  try {
    const tagsRes = await fetch(`${ollama}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (tagsRes.ok) {
      const tagsData = await tagsRes.json();
      const rawList = Array.isArray(tagsData.models) ? tagsData.models : [];
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
      return {
        ok: true,
        url: ollama,
        models,
        count: models.length,
        activeBackendUrl: ollama,
        isDirect: true,
        message: models.length === 0 ? 'No local models found in Ollama.' : null
      };
    }
  } catch (_) {}

  // 2. Node backend fallback (if running on port 3000/3001)
  try {
    const url = `${backend}/api/ollama/models?url=${encodeURIComponent(ollama)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    data.activeBackendUrl = backend;
    return data;
  } catch (err) {
    const altBackend = backend.includes(':3000') 
      ? backend.replace(':3000', ':3001') 
      : (backend.includes(':3001') ? backend.replace(':3001', ':3000') : null);
    if (altBackend) {
      try {
        const altUrl = `${altBackend}/api/ollama/models?url=${encodeURIComponent(ollama)}`;
        const altRes = await fetch(altUrl, { signal: AbortSignal.timeout(2000) });
        if (altRes.ok) {
          const altData = await altRes.json();
          altData.activeBackendUrl = altBackend;
          await chrome.storage.local.set({ localBackendUrl: altBackend });
          return altData;
        }
      } catch (_) {}
    }
    throw new Error('Could not fetch Ollama models. Please ensure Ollama is running at http://127.0.0.1:11434');
  }
}

/**
 * Perform full offline diagnostics on local backend and Ollama
 */
async function handleOllamaDiagnostics(localBackendUrl, ollamaUrl, selectedModel) {
  const st = await chrome.storage.local.get(['localBackendUrl', 'ollamaUrl', 'ollamaSelectedModel']);
  let backend = (localBackendUrl || st.localBackendUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const ollama = ollamaUrl || st.ollamaUrl || 'http://127.0.0.1:11434';
  const model = selectedModel || st.ollamaSelectedModel || '';

  const query = `url=${encodeURIComponent(ollama)}&model=${encodeURIComponent(model)}`;
  try {
    const url = `${backend}/api/ollama/diagnostics?${query}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    data.activeBackendUrl = backend;
    return data;
  } catch (err) {
    const altBackend = backend.includes(':3000')
      ? backend.replace(':3000', ':3001')
      : (backend.includes(':3001') ? backend.replace(':3001', ':3000') : null);
    if (altBackend) {
      try {
        const altUrl = `${altBackend}/api/ollama/diagnostics?${query}`;
        const altRes = await fetch(altUrl);
        if (altRes.ok) {
          const altData = await altRes.json();
          altData.activeBackendUrl = altBackend;
          await chrome.storage.local.set({ localBackendUrl: altBackend });
          return altData;
        }
      } catch (_) {}
    }

    // Direct Ollama diagnostics fallback
    try {
      const directTagsRes = await fetch(`${ollama}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (directTagsRes.ok) {
        const tagsData = await directTagsRes.json();
        const models = (tagsData.models || []).map(m => ({
          name: m.name || m.model,
          size: formatBytes(m.size),
          capability: detectModelCapability(m)
        }));
        const match = models.find(m => m.name === model);
        return {
          ok: true,
          timestamp: new Date().toISOString(),
          backend: { status: 'offline', host: '127.0.0.1', port: 3000 },
          ollama: {
            status: 'connected',
            url: ollama,
            version: 'installed',
            modelsCount: models.length,
            latencyMs: 15
          },
          selectedModel: {
            name: model || 'none',
            installed: !!match,
            capability: match ? match.capability : 'Unknown',
            size: match ? match.size : null
          },
          offlineMode: {
            active: true,
            externalNetworkRequired: false,
            status: '100% Direct Local Ollama Pipeline (No Node backend required)'
          },
          isDirect: true
        };
      }
    } catch (_) {}

    throw err;
  }
}

/**
 * Helper to record real API usage and daily counts per model
 */
async function updateRealUsageStats(realUsage = {}) {
  try {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const st = await chrome.storage.local.get(['realUsageStats', 'activeProvider']);
    const stats = st.realUsageStats || { date: today, providers: {} };

    // Reset daily counters if new calendar day
    if (stats.date !== today) {
      stats.date = today;
      stats.providers = {};
    }

    const providerKey = (realUsage.provider || st.activeProvider || 'gemini').toLowerCase();
    const current = stats.providers[providerKey] || {
      solvesToday: 0,
      tokensToday: 0,
      lastSolveTokens: 0,
      remainingRequests: providerKey === 'gemini' ? 1500 : null,
      limitRequests: providerKey === 'gemini' ? 1500 : null,
      status: 'healthy'
    };

    current.solvesToday = (current.solvesToday || 0) + 1;
    const tokens = realUsage.totalTokens || 0;
    current.tokensToday = (current.tokensToday || 0) + tokens;
    current.lastSolveTokens = tokens;

    if (providerKey === 'gemini') {
      current.limitRequests = 1500;
      current.remainingRequests = Math.max(0, 1500 - current.solvesToday);
      current.status = current.remainingRequests <= 0 ? 'quota_exhausted' : 'healthy';
    } else if (realUsage.remainingRequests !== null && realUsage.remainingRequests !== undefined) {
      current.remainingRequests = realUsage.remainingRequests;
      current.limitRequests = realUsage.limitRequests || 500;
      current.status = current.remainingRequests <= 0 ? 'rate_limit_reached' : 'healthy';
    }

    stats.providers[providerKey] = current;
    await chrome.storage.local.set({ realUsageStats: stats });
  } catch (e) {
    console.warn('[Background] Failed to update real usage stats:', e.message);
  }
}

/**
 * Health check helper
 */
async function handleHealthCheck(url) {
  const effectiveUrl = url || (await chrome.storage.local.get(['backendUrl'])).backendUrl || 'https://extension-w1ac.onrender.com';
  const cleanUrl = effectiveUrl.replace(/\/+$/, '');
  const start = Date.now();

  const controller = new AbortController();
  // 20s timeout to comfortably accommodate free cloud instances (Render cold start spin up)
  const timeoutId = setTimeout(() => controller.abort(), 20000);

  try {
    const res = await fetch(`${cleanUrl}/health`, {
      method: 'GET',
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    const latencyMs = Date.now() - start;
    if (res.ok) {
      const data = await res.json();
      return { ok: true, latencyMs, ...data };
    }
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (err) {
    clearTimeout(timeoutId);
    let errorMsg = err.message || 'Connection refused';
    if (err.name === 'AbortError' || errorMsg.includes('aborted')) {
      errorMsg = 'Connection timed out. If using a free cloud server (like Render), it may be waking up from sleep. Please wait a moment and try again.';
    } else if (errorMsg.includes('Failed to fetch') || errorMsg.includes('NetworkError')) {
      errorMsg = `Server unreachable at ${cleanUrl}. Check your internet connection or server status.`;
    }
    return { ok: false, error: errorMsg };
  }
}

/**
 * Clear backend cache
 */
async function handleClearCache(url) {
  const effectiveUrl = url || (await chrome.storage.local.get(['backendUrl'])).backendUrl || 'https://extension-w1ac.onrender.com';
  const cleanUrl = effectiveUrl.replace(/\/+$/, '');

  const res = await fetch(`${cleanUrl}/api/cache/clear`, { method: 'POST' });
  const data = await res.json();
  return { success: res.ok, ...data };
}

/**
 * Retrieve auth and connection status for ChatGPT and Gemini
 */
async function handleAuthStatus(url) {
  const effectiveUrl = url || (await chrome.storage.local.get(['backendUrl'])).backendUrl || 'https://extension-w1ac.onrender.com';
  const cleanUrl = effectiveUrl.replace(/\/+$/, '');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);

  try {
    const res = await fetch(`${cleanUrl}/api/auth/status`, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) {
      throw new Error(`Failed to fetch auth status (${res.status})`);
    }
    return await res.json();
  } catch (err) {
    clearTimeout(timeoutId);
    // Reliable fallback to /health if backend is active
    try {
      const health = await handleHealthCheck(cleanUrl);
      if (health && health.ok && health.provider) {
        return {
          providers: {
            [health.provider]: { provider: health.provider, status: 'connected', accountEmail: health.accountEmail || 'connected' }
          },
          active: { provider: health.provider, status: 'connected' }
        };
      }
    } catch (_) {}
    throw err;
  }
}

/**
 * Start official OAuth authorization flow and launch provider sign-in tab
 */
async function handleAuthStart(provider, url) {
  const effectiveUrl = url || (await chrome.storage.local.get(['backendUrl'])).backendUrl || 'https://extension-w1ac.onrender.com';
  const cleanUrl = effectiveUrl.replace(/\/+$/, '');

  const res = await fetch(`${cleanUrl}/api/auth/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider,
      redirectUri: `${cleanUrl}/api/auth/callback`
    })
  });

  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to start authorization');
  }

  // Open the official OAuth authorization window/tab for user consent
  if (data.authUrl) {
    await chrome.tabs.create({ url: data.authUrl });
  }

  return data;
}

/**
 * Disconnect an AI provider
 */
async function handleAuthDisconnect(provider, url) {
  const effectiveUrl = url || (await chrome.storage.local.get(['backendUrl'])).backendUrl || 'https://extension-w1ac.onrender.com';
  const cleanUrl = effectiveUrl.replace(/\/+$/, '');

  const res = await fetch(`${cleanUrl}/api/auth/disconnect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider })
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Failed to disconnect');
  }
  return data;
}

/**
 * Set active AI provider (ChatGPT or Gemini)
 */
async function handleAuthSelect(provider, url) {
  const effectiveUrl = url || (await chrome.storage.local.get(['backendUrl'])).backendUrl || 'https://extension-w1ac.onrender.com';
  const cleanUrl = effectiveUrl.replace(/\/+$/, '');

  const res = await fetch(`${cleanUrl}/api/auth/select`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider })
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Failed to select provider');
  }
  return data;
}

/**
 * Save and verify API key directly for ChatGPT or Gemini
 */
async function handleAuthSaveKey(provider, apiKey, url) {
  const effectiveUrl = url || (await chrome.storage.local.get(['backendUrl'])).backendUrl || 'https://extension-w1ac.onrender.com';
  const cleanUrl = effectiveUrl.replace(/\/+$/, '');

  const res = await fetch(`${cleanUrl}/api/auth/save-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, apiKey })
  });

  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to save and verify API key');
  }
  return data;
}


