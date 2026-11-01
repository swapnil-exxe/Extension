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

// Initialize settings on installation
chrome.runtime.onInstalled.addListener(async () => {
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
          target: { tabId },
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
    chrome.windows.getCurrent((currentWindow) => {
      const windowId = currentWindow ? currentWindow.id : undefined;
      chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
        if (chrome.runtime.lastError || !dataUrl) {
          sendResponse({ success: false, error: chrome.runtime.lastError?.message || 'Capture failed' });
        } else {
          sendResponse({ success: true, dataUrl });
        }
      });
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

  const storage = await chrome.storage.local.get(['backendUrl', 'activeProvider', 'customProviders']);
  const customProviders = storage.customProviders || [];
  const backendUrl = storage.backendUrl || 'https://extension-w1ac.onrender.com';
  const cleanUrl = backendUrl.replace(/\/+$/, '');
  const targetEndpoint = `${cleanUrl}/api/answer`;

  const GEMINI_KEYS = {
    gemini_1: 'AQ.Ab8RN6KFANrgYQ9jNdxrKrvFgSTK29zX5LlklGYKiJ_NMQEIbw',
    gemini_2: 'AQ.Ab8RN6L5SzwMkdACJLrfDhTITMLagzjNqIN4DLR_-lN-fBjzxg',
    gemini_3: 'AQ.Ab8RN6JLyJ-DRRQkkQ8hsYe_X5NRUdNsT_sQtv7XjAoI2Qn3vw',
    gemini_4: 'AQ.Ab8RN6Kr25hFpdJ7q7Q4PDOZV_cERl0ARAJdr0v7KMMED3fkUg'
  };

  const CHATGPT_KEY = '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';

  // Attach active provider and specific key if selected
  const selectedProvider = payload.provider || storage.activeProvider || 'gemini_1';
  if (selectedProvider.startsWith('gemini')) {
    payload.provider = 'gemini';
    if (GEMINI_KEYS[selectedProvider]) {
      payload.apiKey = GEMINI_KEYS[selectedProvider];
    }
  } else if (selectedProvider === 'chatgpt' || selectedProvider === 'openai') {
    payload.provider = 'chatgpt';
    payload.apiKey = CHATGPT_KEY;
  } else if (selectedProvider.startsWith('custom_')) {
    const custom = customProviders.find(p => p.id === selectedProvider);
    if (custom) {
      payload.provider = 'custom';
      payload.apiKey = custom.apiKey;
      payload.endpoint = custom.endpoint;
      payload.model = custom.model;
    }
  } else {
    payload.provider = selectedProvider;
  }

  // 25s timeout to allow cloud instances (Render cold start) & provider inference to complete
  const timeoutId = setTimeout(() => currentController.abort(), 25000);

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

    if (error.name === 'AbortError' || msg.includes('aborted')) {
      msg = 'Request timed out. The backend server may be waking up or taking longer to process.';
    } else if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
      msg = `Backend unreachable at ${cleanUrl}`;
    }
    return { success: false, error: msg };
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


