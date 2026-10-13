/**
 * Moodle AI Quick Answer - Background Service Worker (Manifest V3)
 * Handles Chrome commands, screenshot captures, script injection, and secure backend proxying.
 */

const DEFAULT_SETTINGS = {
  enabled: true,
  notificationPosition: 'top-right',
  notificationDuration: 1000,
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



/**
 * Proxy question payload to Express backend
 */
async function handleAnalyzeQuestion(payload) {
  const { backendUrl = 'https://extension-w1ac.onrender.com' } = await chrome.storage.local.get(['backendUrl']);
  const cleanUrl = backendUrl.replace(/\/+$/, '');
  const targetEndpoint = `${cleanUrl}/api/answer`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(targetEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errJson = await response.json().catch(() => ({}));
      throw new Error(errJson.message || errJson.error || `HTTP ${response.status}`);
    }

    const data = await response.json();

    // Deduct 1 credit/token upon successful solve
    const allStore = await chrome.storage.local.get(null);
    const currentUsed = allStore.usedTokens || 0;
    const activeProvider = allStore.activeProvider || (data.provider || '').toLowerCase();

    if (activeProvider && activeProvider.startsWith('custom_')) {
      const customUsedKey = `tokens_${activeProvider}_used`;
      const prevCustomUsed = allStore[customUsedKey] || 0;
      await chrome.storage.local.set({
        usedTokens: currentUsed + 1,
        [customUsedKey]: prevCustomUsed + 1
      });
    } else {
      const isGpt = (data.provider || '').toLowerCase().includes('chatgpt') || (data.provider || '').toLowerCase().includes('openai') || activeProvider === 'chatgpt';
      if (isGpt) {
        const gptUsed = allStore.tokensChatgptUsed || 0;
        await chrome.storage.local.set({
          usedTokens: currentUsed + 1,
          tokensChatgptUsed: gptUsed + 1
        });
      } else {
        const geminiUsed = allStore.tokensGeminiUsed || 0;
        await chrome.storage.local.set({
          usedTokens: currentUsed + 1,
          tokensGeminiUsed: geminiUsed + 1
        });
      }
    }

    return { success: true, data };
  } catch (error) {
    clearTimeout(timeoutId);
    let msg = error.message;
    if (error.name === 'AbortError') {
      msg = 'Request timed out.';
    } else if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
      msg = `Backend unreachable at ${cleanUrl}`;
    }
    return { success: false, error: msg };
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
  const timeoutId = setTimeout(() => controller.abort(), 4000);

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
    return { ok: false, error: err.message || 'Connection refused' };
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

  const res = await fetch(`${cleanUrl}/api/auth/status`);
  if (!res.ok) {
    throw new Error(`Failed to fetch auth status (${res.status})`);
  }
  return await res.json();
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


