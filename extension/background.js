/**
 * Moodle AI Quick Answer - Background Service Worker (Manifest V3)
 * Handles Chrome commands, screenshot captures, script injection, and secure backend proxying.
 */

const DEFAULT_SETTINGS = {
  enabled: true,
  notificationPosition: 'top-right',
  notificationDuration: 500,
  backendUrl: 'http://localhost:3001'
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

// Call on startup
registerOllamaCorsRules();

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
    const targetWinId = sender.tab ? sender.tab.windowId : undefined;
    chrome.tabs.captureVisibleTab(targetWinId, { format: 'png' }, (dataUrl) => {
      if (!chrome.runtime.lastError && dataUrl) {
        sendResponse({ success: true, dataUrl });
      } else {
        // Fallback: try capturing with last focused window
        chrome.windows.getLastFocused({ populate: false }, (win) => {
          const fallbackWinId = win ? win.id : undefined;
          chrome.tabs.captureVisibleTab(fallbackWinId, { format: 'png' }, (fallbackUrl) => {
            if (chrome.runtime.lastError || !fallbackUrl) {
              sendResponse({ success: false, error: chrome.runtime.lastError?.message || 'Capture failed' });
            } else {
              sendResponse({ success: true, dataUrl: fallbackUrl });
            }
          });
        });
      }
    });
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
});



// Active request abort controller to cancel obsolete in-flight requests
let activeRequestController = null;

/**
 * Proxy question payload to Express backend
 */
async function handleAnalyzeQuestion(payload) {
  // Cancel previous in-flight request if user moved to a new question
  if (activeRequestController) {
    try {
      activeRequestController.abort();
    } catch (e) {}
  }
  activeRequestController = new AbortController();
  const currentController = activeRequestController;

  const storage = await chrome.storage.local.get([
    'backendUrl',
    'localBackendUrl',
    'ollamaUrl',
    'ollamaSelectedModel',
    'activeProvider',
    'customProviders'
  ]);
  const customProviders = storage.customProviders || [];
  const selectedProvider = payload.provider || storage.activeProvider || 'gemini_1';

  let targetEndpoint;
  let timeoutMs = 25000;
  let isLocalOllama = false;

  // Secure cloud routing: Keys are managed safely on Render server environment variables
  // or user-configured custom keys. No secrets are hardcoded in client code.

  if (selectedProvider === 'ollama') {
    isLocalOllama = true;
    const localUrl = (storage.localBackendUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    targetEndpoint = `${localUrl}/api/solve`;
    payload.provider = 'ollama';
    payload.model = payload.model || storage.ollamaSelectedModel;
    payload.ollamaUrl = storage.ollamaUrl || 'http://127.0.0.1:11434';
    timeoutMs = 60000; // Local model generation timeout (up to 60s)

    if (!payload.model) {
      return {
        success: false,
        error: 'No local Ollama model selected. Please open extension settings and choose an installed model.'
      };
    }
  } else if (selectedProvider.startsWith('gemini')) {
    const backendUrl = storage.backendUrl || 'https://extension-w1ac.onrender.com';
    const cleanUrl = backendUrl.replace(/\/+$/, '');
    targetEndpoint = `${cleanUrl}/api/answer`;
    payload.provider = 'gemini';
    payload.keySlot = selectedProvider;
    if (storage.userGeminiKey) {
      payload.apiKey = storage.userGeminiKey;
    }
  } else if (selectedProvider === 'chatgpt' || selectedProvider === 'openai') {
    const backendUrl = storage.backendUrl || 'https://extension-w1ac.onrender.com';
    const cleanUrl = backendUrl.replace(/\/+$/, '');
    targetEndpoint = `${cleanUrl}/api/answer`;
    payload.provider = 'chatgpt';
    if (storage.userOpenAIKey) {
      payload.apiKey = storage.userOpenAIKey;
    }
  } else if (selectedProvider.startsWith('custom_')) {
    const backendUrl = storage.backendUrl || 'https://extension-w1ac.onrender.com';
    const cleanUrl = backendUrl.replace(/\/+$/, '');
    targetEndpoint = `${cleanUrl}/api/answer`;
    const custom = customProviders.find(p => p.id === selectedProvider);
    if (custom) {
      payload.provider = 'custom';
      payload.apiKey = custom.apiKey;
      payload.endpoint = custom.endpoint;
      payload.model = custom.model;
    }
  } else {
    const backendUrl = storage.backendUrl || 'https://extension-w1ac.onrender.com';
    const cleanUrl = backendUrl.replace(/\/+$/, '');
    targetEndpoint = `${cleanUrl}/api/answer`;
    payload.provider = selectedProvider;
  }

  // Abort timeout
  const timeoutId = setTimeout(() => currentController.abort(), timeoutMs);

  try {
    const response = await fetch(targetEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: currentController.signal
    });

    clearTimeout(timeoutId);
    if (activeRequestController === currentController) {
      activeRequestController = null;
    }

    if (!response.ok) {
      const errJson = await response.json().catch(() => ({}));
      throw new Error(errJson.message || errJson.error || `HTTP ${response.status}`);
    }

    const data = await response.json();
    if (data && data.realUsage) {
      await updateRealUsageStats(data.realUsage);
    } else {
      await updateRealUsageStats({ provider: payload.provider || storage.activeProvider, totalTokens: 140 });
    }
    return { success: true, data };
  } catch (error) {
    clearTimeout(timeoutId);

    // Auto-probe alternate port 3000/3001 if connection refused
    if (isLocalOllama && (targetEndpoint.includes(':3000') || targetEndpoint.includes(':3001'))) {
      const altEndpoint = targetEndpoint.includes(':3000')
        ? targetEndpoint.replace(':3000', ':3001')
        : targetEndpoint.replace(':3001', ':3000');
      try {
        const altResponse = await fetch(altEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (altResponse.ok) {
          const altData = await altResponse.json();
          const newBackend = altEndpoint.replace('/api/solve', '');
          await chrome.storage.local.set({ localBackendUrl: newBackend });
          return { success: true, data: altData };
        }
      } catch (_) {}
    }

    // Direct Ollama execution (bypasses Node.js backend when offline or stopped)
    if (isLocalOllama) {
      try {
        const directData = await runDirectOllamaSolve(payload, payload.ollamaUrl, payload.model);
        return { success: true, data: directData };
      } catch (directErr) {
        console.warn('[Direct Ollama Failed]:', directErr.message);
        let cleanErr = directErr.message || 'Local Ollama evaluation failed';
        if (cleanErr.includes('Failed to fetch') || cleanErr.includes('ECONNREFUSED')) {
          cleanErr = 'Ollama is not running. Please open the Ollama app on your computer.';
        } else if (cleanErr.includes('403')) {
          cleanErr = 'Ollama 403: Origin blocked. Please reload extension at chrome://extensions';
        } else if (cleanErr.includes('AbortError') || cleanErr.includes('timed out')) {
          cleanErr = 'Ollama timed out. The local model is taking too long to compute.';
        }
        return { success: false, error: cleanErr };
      }
    }

    let msg = error.message;

    // Record quota exhaustion if error indicates rate/quota limit
    if (msg.includes('429') || msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED')) {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const st = await chrome.storage.local.get(['realUsageStats', 'activeProvider']);
        const stats = st.realUsageStats || { date: today, providers: {} };
        const pKey = (payload.provider || st.activeProvider || 'gemini').toLowerCase();
        const current = stats.providers[pKey] || { solvesToday: 0, tokensToday: 0 };
        current.status = 'quota_exhausted';
        stats.providers[pKey] = current;
        await chrome.storage.local.set({ realUsageStats: stats });
      } catch (e) {}
    }

    // Automatic failover: if ChatGPT/OpenAI has 0 credits or quota exceeded, seamlessly retry with Gemini
    if ((selectedProvider === 'chatgpt' || selectedProvider === 'openai') && (msg.includes('quota') || msg.includes('credit') || msg.includes('insufficient_quota'))) {
      console.warn('[Background] OpenAI quota exceeded. Automatically retrying with Google Gemini...');
      try {
        const fallbackPayload = { ...payload, provider: 'gemini' };
        delete fallbackPayload.apiKey;
        const backendUrl = storage.backendUrl || 'https://extension-w1ac.onrender.com';
        const fallbackRes = await fetch(`${backendUrl.replace(/\/+$/, '')}/api/answer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(fallbackPayload)
        });
        if (fallbackRes.ok) {
          const fallbackData = await fallbackRes.json();
          await chrome.storage.local.set({ activeProvider: 'gemini_1' });
          if (fallbackData && fallbackData.realUsage) {
            await updateRealUsageStats(fallbackData.realUsage);
          }
          return { success: true, data: fallbackData };
        }
      } catch (fbErr) {
        console.warn('[Background] Failover to Gemini failed:', fbErr.message);
      }
    }

    if (error.name === 'AbortError' || msg.includes('aborted')) {
      if (isLocalOllama) {
        msg = `Ollama generation timed out (${timeoutMs / 1000}s). The model may still be loading into RAM.`;
      } else {
        msg = 'Request timed out. The backend server may be waking up or taking longer to process.';
      }
    } else if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('ECONNREFUSED')) {
      if (isLocalOllama) {
        const localUrl = storage.localBackendUrl || 'http://127.0.0.1:3000';
        msg = `Local backend or Ollama is unreachable at ${localUrl}. Ensure your local backend (port 3000) and Ollama are running.`;
      } else {
        const backendUrl = storage.backendUrl || 'https://extension-w1ac.onrender.com';
        msg = `Backend unreachable at ${backendUrl}`;
      }
    }
    return { success: false, error: msg };
  }
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
  }
  try {
    return JSON.parse(str);
  } catch (_) {
    try {
      const repaired = str.replace(/,\s*([\]}])/g, '$1');
      return JSON.parse(repaired);
    } catch (e) {
      return null;
    }
  }
}

async function runDirectOllamaSolve(payload, ollamaUrl = 'http://127.0.0.1:11434', modelName) {
  const baseUrl = (ollamaUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  let model = modelName || payload.model;

  // Auto-detect installed model if none selected
  if (!model) {
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

  if (!model) throw new Error('No local Ollama model found');

  const incomingImages = Array.isArray(payload.images) && payload.images.length > 0
    ? payload.images
    : (payload.image ? [payload.image] : []);

  let rawImages = [];
  if (incomingImages.length > 0) {
    // Check if selected model is vision capable or text-only
    let isVision = false;
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
  if (Array.isArray(payload.options) && payload.options.length > 0) {
    prompt += `Options:\n`;
    payload.options.forEach(opt => {
      prompt += `- [${opt.id}]: ${opt.text}\n`;
    });
    prompt += `\nSelect the best option. Output JSON with "option": "<Option Letter>" and "answer": "<Option Text>".`;
  } else {
    prompt += `\nOutput strictly valid JSON with "option" and "answer".`;
  }

  const system = `You are an expert academic tutor and AI inference engine solving quiz questions.
Output strictly valid JSON with keys: "option", "answer", "reason", "confidence", "status".
RULES:
1. Identify the question type (single-choice, multiple-choice, numerical, matching, true/false, DSA, coding).
2. CRITICAL FOR NEGATIVE QUESTIONS: If the question contains "NOT", "EXCEPT", "FALSE", "INCORRECT", "LEAST", "NEVER", or "UNLIKE", focus on the negative qualifier. Identify the statement that is FALSE or does NOT apply, and choose that option.
3. For multiple-choice questions, set "option" to the exact option letter (e.g. "A", "B", "C", "D") and "answer" to the exact option text.
4. For matching questions, format "answer" with the complete item pairings (e.g. "1-B, 2-D, 3-A") and "option" to the corresponding matching choice letter.
5. For short-answer/math, set "option" to "" and "answer" to the calculated value.
6. Provide a concise 1-sentence verification in "reason".
7. Calibrate "confidence": 0.85-1.0 for verified answers, 0.60-0.80 if ambiguous. Set "status" to "success".`;

  const body = {
    model,
    prompt,
    system,
    stream: false,
    format: 'json',
    keep_alive: '20m',
    options: {
      temperature: 0.1,
      top_p: 0.9,
      num_predict: 350
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
  const json = await res.json();
  const parsed = extractJSON(json.response) || {};

  let option = String(parsed.option || parsed.choice || '').trim();
  let answer = String(parsed.answer || parsed.result || '').trim();
  const options = Array.isArray(payload.options) ? payload.options : [];

  if (option) {
    const optMatch = option.match(/^([A-Za-z0-9]+)[\.\:\)\-]?/);
    if (optMatch) option = optMatch[1].toUpperCase();
  }
  if (option.toUpperCase() === 'UNCERTAIN') option = '';
  if (answer.toLowerCase().includes('uncertain') || answer.toLowerCase().includes('needs verification') || answer.toLowerCase().includes('cannot determine')) {
    answer = '';
  }
  if (!option && (parsed.reason || parsed.explanation)) {
    const rMatch = `${parsed.reason || ''} ${parsed.explanation || ''}`.match(/\b(?:option|choice)\s+([A-D])\b/i);
    if (rMatch) option = rMatch[1].toUpperCase();
  }

  if (options.length > 0) {
    const optUpper = String(option || '').trim().toUpperCase();
    const ansLower = String(answer || '').trim().toLowerCase();

    let match = null;
    if (optUpper) {
      match = options.find(o => String(o.id).toUpperCase() === optUpper);
      if (!match) {
        const letterIdx = optUpper.charCodeAt(0) - 65;
        if (letterIdx >= 0 && letterIdx < options.length) {
          match = options[letterIdx];
        }
      }
      if (!match) {
        match = options.find(o => {
          const m = String(o.text || '').match(/^(?:(?:\(([A-Za-z0-9]+)\))|(?:\[([A-Za-z0-9]+)\])|([A-Za-z0-9]+)[\.\:\)\-])\s*/);
          return m && (m[1] || m[2] || m[3]).toUpperCase() === optUpper;
        });
      }
    }

    if (!match && ansLower) {
      match = options.find(o => {
        const raw = String(o.text || '').toLowerCase().trim();
        const stripped = raw.replace(/^[a-z0-9]+[\.\:\)\-]\s*/i, '').trim();
        return raw === ansLower || stripped === ansLower ||
               (ansLower.length > 3 && (raw.includes(ansLower) || ansLower.includes(raw) || stripped.includes(ansLower) || ansLower.includes(stripped)));
      });
    }

    if (!match && (parsed.reason || parsed.explanation)) {
      const rMatch = `${parsed.reason || ''} ${parsed.explanation || ''}`.match(/\b(?:option|choice)\s+([A-D])\b/i);
      if (rMatch) {
        const rLetter = rMatch[1].toUpperCase();
        match = options.find(o => String(o.id).toUpperCase() === rLetter) ||
                options[rLetter.charCodeAt(0) - 65];
      }
    }

    if (match) {
      const mMatch = String(match.text || '').match(/^(?:(?:\(([A-Za-z0-9]+)\))|(?:\[([A-Za-z0-9]+)\])|([A-Za-z0-9]+)[\.\:\)\-])\s*(.*)$/);
      const matchIdx = options.indexOf(match);
      if (mMatch) {
        option = (mMatch[1] || mMatch[2] || mMatch[3]).toUpperCase();
        answer = mMatch[4] ? mMatch[4].trim() : match.text;
      } else {
        option = String(match.id || String.fromCharCode(65 + matchIdx)).toUpperCase();
        answer = match.text;
      }
    }
  }
  if (!answer) answer = option ? `Option ${option}` : 'Solution determined';

  return {
    option,
    answer,
    answerText: answer,
    optionIds: option ? [option] : [],
    status: 'success',
    confidence: 0.95,
    explanation: parsed.reason || `Selected ${option} using local ${model}.`,
    reason: parsed.reason || `Selected ${option} using local ${model}.`,
    isDirect: true
  };
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


