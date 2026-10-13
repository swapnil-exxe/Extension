/**
 * Moodle AI Quick Answer - Popup Controller
 * Manages provider connections, OAuth authorization, active AI selection, and shortcuts.
 */

document.addEventListener('DOMContentLoaded', async () => {
  // Elements
  const toggleEnabled = document.getElementById('toggle-enabled');
  const serverDot = document.getElementById('server-dot');
  const serverText = document.getElementById('server-text');
  const linkSettings = document.getElementById('link-settings');

  // Hero Screenshot Button
  const btnHeroVision = document.getElementById('btn-hero-vision');

  // Gemini Elements
  const cardGemini = document.getElementById('card-gemini');
  const badgeGemini = document.getElementById('badge-gemini');
  const statusGemini = document.getElementById('status-gemini');
  const actionsGemini = document.getElementById('actions-gemini');
  const radioGemini = document.getElementById('radio-gemini');
  const btnDisconnectGemini = document.getElementById('btn-disconnect-gemini');
  const connectBlockGemini = document.getElementById('connect-block-gemini');
  const btnConnectGemini = document.getElementById('btn-connect-gemini');
  const feedbackGemini = document.getElementById('feedback-gemini');
  const toggleKeyGemini = document.getElementById('toggle-key-gemini');
  const keyRowGemini = document.getElementById('key-row-gemini');
  const keyInputGemini = document.getElementById('key-input-gemini');
  const btnSaveGemini = document.getElementById('btn-save-gemini');

  // ChatGPT Elements
  const cardChatgpt = document.getElementById('card-chatgpt');
  const badgeChatgpt = document.getElementById('badge-chatgpt');
  const statusChatgpt = document.getElementById('status-chatgpt');
  const actionsChatgpt = document.getElementById('actions-chatgpt');
  const radioChatgpt = document.getElementById('radio-chatgpt');
  const btnDisconnectChatgpt = document.getElementById('btn-disconnect-chatgpt');
  const connectBlockChatgpt = document.getElementById('connect-block-chatgpt');
  const btnConnectChatgpt = document.getElementById('btn-connect-chatgpt');
  const feedbackChatgpt = document.getElementById('feedback-chatgpt');
  const toggleKeyChatgpt = document.getElementById('toggle-key-chatgpt');
  const keyRowChatgpt = document.getElementById('key-row-chatgpt');
  const keyInputChatgpt = document.getElementById('key-input-chatgpt');
  const btnSaveChatgpt = document.getElementById('btn-save-chatgpt');

  // Shortcut action buttons
  const btnSolve = document.getElementById('btn-trigger-solve');
  const btnRepeat = document.getElementById('btn-trigger-repeat');

  // Load extension preferences
  const settings = await chrome.storage.local.get(['enabled', 'backendUrl']);
  const effectiveBackendUrl = settings.backendUrl || 'http://localhost:3001';
  toggleEnabled.checked = settings.enabled !== false;

  // Initial loads
  await refreshServerHealth(effectiveBackendUrl);
  await refreshAuthStatus(effectiveBackendUrl);

  // Poll status periodically while popup is open (to update when user completes OAuth in tab)
  const pollInterval = setInterval(() => {
    refreshAuthStatus(effectiveBackendUrl);
  }, 2000);

  window.addEventListener('unload', () => {
    clearInterval(pollInterval);
  });

  /**
   * Fetch and render connection status for both ChatGPT and Gemini
   */
  async function refreshAuthStatus(backendUrl) {
    try {
      chrome.runtime.sendMessage({ action: 'AUTH_GET_STATUS', backendUrl }, (res) => {
        if (!res || !res.providers) return;

        renderProviderCard('gemini', res.providers.gemini, res.active);
        renderProviderCard('chatgpt', res.providers.chatgpt, res.active);
      });
    } catch (e) {
      console.warn('[Popup] Auth status query failed:', e.message);
    }
  }

  /**
   * Render a provider's card according to its state
   */
  function renderProviderCard(provider, info, activeInfo) {
    const isGpt = provider === 'chatgpt';
    const card = isGpt ? cardChatgpt : cardGemini;
    const badge = isGpt ? badgeChatgpt : badgeGemini;
    const statusText = isGpt ? statusChatgpt : statusGemini;
    const actions = isGpt ? actionsChatgpt : actionsGemini;
    const radio = isGpt ? radioChatgpt : radioGemini;
    const connectBlock = isGpt ? connectBlockChatgpt : connectBlockGemini;
    const btnConnect = isGpt ? btnConnectChatgpt : btnConnectGemini;
    const feedback = isGpt ? feedbackChatgpt : feedbackGemini;

    const rawStatus = (info?.status || 'not_connected').toLowerCase();
    const isActive = activeInfo && (activeInfo.provider === provider || (isGpt && activeInfo.provider === 'openai'));

    // Highlight active card
    if (isActive) {
      card.classList.add('active-card');
      radio.checked = true;
    } else {
      card.classList.remove('active-card');
      radio.checked = false;
    }

    // Reset badge classes
    badge.className = 'status-badge';

    // Reset button disabled state & text cleanly
    if (rawStatus !== 'connecting') {
      btnConnect.disabled = false;
      btnConnect.querySelector('span').textContent = `Connect ${isGpt ? 'ChatGPT' : 'Gemini'}`;
    }

    switch (rawStatus) {
      case 'connected':
        badge.classList.add('connected');
        statusText.textContent = 'Connected';
        actions.style.display = 'flex';
        connectBlock.style.display = 'none';
        feedback.style.display = 'none';
        break;

      case 'connecting':
        badge.classList.add('connecting');
        statusText.textContent = 'Connecting...';
        actions.style.display = 'none';
        connectBlock.style.display = 'block';
        btnConnect.disabled = true;
        btnConnect.querySelector('span').textContent = 'Connecting...';
        break;

      case 'expired':
        badge.classList.add('expired');
        statusText.textContent = 'Expired';
        actions.style.display = 'none';
        connectBlock.style.display = 'block';
        btnConnect.disabled = false;
        btnConnect.querySelector('span').textContent = `Reconnect ${isGpt ? 'ChatGPT' : 'Gemini'}`;
        feedback.className = 'key-feedback error';
        feedback.textContent = 'Session expired. Please reconnect.';
        break;

      case 'error':
        badge.classList.add('error');
        statusText.textContent = 'Error';
        actions.style.display = 'none';
        connectBlock.style.display = 'block';
        btnConnect.disabled = false;
        btnConnect.querySelector('span').textContent = `Connect ${isGpt ? 'ChatGPT' : 'Gemini'}`;
        if (info?.error) {
          feedback.className = 'key-feedback error';
          feedback.textContent = info.error;
        }
        break;

      case 'not_connected':
      default:
        statusText.textContent = 'Not connected';
        actions.style.display = 'none';
        connectBlock.style.display = 'block';
        btnConnect.disabled = false;
        btnConnect.querySelector('span').textContent = `Connect ${isGpt ? 'ChatGPT' : 'Gemini'}`;
        feedback.style.display = 'none';
        break;
    }
  }

  /**
   * OAuth Connect button handlers
   */
  btnConnectGemini.addEventListener('click', () => {
    btnConnectGemini.disabled = true;
    btnConnectGemini.querySelector('span').textContent = 'Connecting...';
    badgeGemini.className = 'status-badge connecting';
    statusGemini.textContent = 'Connecting';

    chrome.runtime.sendMessage({ action: 'AUTH_START', provider: 'gemini', backendUrl: effectiveBackendUrl }, (res) => {
      btnConnectGemini.disabled = false;
      btnConnectGemini.querySelector('span').textContent = 'Connect Gemini';

      if (res && res.error) {
        feedbackGemini.className = 'key-feedback error';
        feedbackGemini.textContent = res.error;
      }
      refreshAuthStatus(effectiveBackendUrl);
      refreshServerHealth(effectiveBackendUrl);
    });
  });

  btnConnectChatgpt.addEventListener('click', () => {
    btnConnectChatgpt.disabled = true;
    btnConnectChatgpt.querySelector('span').textContent = 'Connecting...';
    badgeChatgpt.className = 'status-badge connecting';
    statusChatgpt.textContent = 'Connecting';

    chrome.runtime.sendMessage({ action: 'AUTH_START', provider: 'chatgpt', backendUrl: effectiveBackendUrl }, (res) => {
      btnConnectChatgpt.disabled = false;
      btnConnectChatgpt.querySelector('span').textContent = 'Connect ChatGPT';

      if (res && res.error) {
        feedbackChatgpt.className = 'key-feedback error';
        feedbackChatgpt.textContent = res.error;
      }
      refreshAuthStatus(effectiveBackendUrl);
      refreshServerHealth(effectiveBackendUrl);
    });
  });

  /**
   * Disconnect button handlers
   */
  btnDisconnectGemini.addEventListener('click', () => {
    btnDisconnectGemini.disabled = true;
    chrome.runtime.sendMessage({ action: 'AUTH_DISCONNECT', provider: 'gemini', backendUrl: effectiveBackendUrl }, () => {
      refreshAuthStatus(effectiveBackendUrl);
      refreshServerHealth(effectiveBackendUrl);
    });
  });

  btnDisconnectChatgpt.addEventListener('click', () => {
    btnDisconnectChatgpt.disabled = true;
    chrome.runtime.sendMessage({ action: 'AUTH_DISCONNECT', provider: 'chatgpt', backendUrl: effectiveBackendUrl }, () => {
      refreshAuthStatus(effectiveBackendUrl);
      refreshServerHealth(effectiveBackendUrl);
    });
  });

  /**
   * Save API Key Handler (Supported fallback)
   */
  async function saveKey(provider, inputElem, btnElem, feedbackElem) {
    const key = inputElem.value.trim();
    if (!key) {
      feedbackElem.className = 'key-feedback error';
      feedbackElem.textContent = 'Please enter a valid key.';
      return;
    }

    btnElem.disabled = true;
    btnElem.textContent = 'Testing...';
    feedbackElem.className = 'key-feedback info';
    feedbackElem.textContent = 'Testing key with server...';

    chrome.runtime.sendMessage(
      { action: 'AUTH_SAVE_KEY', provider, apiKey: key, backendUrl: effectiveBackendUrl },
      (res) => {
        btnElem.disabled = false;
        btnElem.textContent = 'Save';

        if (!res || !res.success) {
          feedbackElem.className = 'key-feedback error';
          feedbackElem.textContent = res?.error || 'Invalid API key or network error.';
        } else {
          inputElem.value = '';
          feedbackElem.style.display = 'none';
          refreshAuthStatus(effectiveBackendUrl);
          refreshServerHealth(effectiveBackendUrl);
        }
      }
    );
  }

  btnSaveGemini.addEventListener('click', () => {
    saveKey('gemini', keyInputGemini, btnSaveGemini, feedbackGemini);
  });
  btnSaveChatgpt.addEventListener('click', () => {
    saveKey('chatgpt', keyInputChatgpt, btnSaveChatgpt, feedbackChatgpt);
  });

  toggleKeyGemini.addEventListener('click', () => {
    keyRowGemini.style.display = keyRowGemini.style.display === 'none' ? 'flex' : 'none';
  });
  toggleKeyChatgpt.addEventListener('click', () => {
    keyRowChatgpt.style.display = keyRowChatgpt.style.display === 'none' ? 'flex' : 'none';
  });

  /**
   * Switch active provider via radio selection
   */
  radioChatgpt.addEventListener('change', () => {
    if (radioChatgpt.checked) {
      chrome.runtime.sendMessage({ action: 'AUTH_SELECT_PROVIDER', provider: 'chatgpt', backendUrl: effectiveBackendUrl }, () => {
        refreshAuthStatus(effectiveBackendUrl);
        refreshServerHealth(effectiveBackendUrl);
      });
    }
  });

  radioGemini.addEventListener('change', () => {
    if (radioGemini.checked) {
      chrome.runtime.sendMessage({ action: 'AUTH_SELECT_PROVIDER', provider: 'gemini', backendUrl: effectiveBackendUrl }, () => {
        refreshAuthStatus(effectiveBackendUrl);
        refreshServerHealth(effectiveBackendUrl);
      });
    }
  });

  /**
   * Check backend health
   */
  async function refreshServerHealth(backendUrl) {
    chrome.runtime.sendMessage({ action: 'CHECK_BACKEND_STATUS', backendUrl }, (res) => {
      if (res && res.ok) {
        serverDot.className = 'status-dot online';
        serverText.textContent = `Online (${res.provider || 'AI'} • ${res.latencyMs || 10}ms)`;
      } else {
        serverDot.className = 'status-dot offline';
        serverText.textContent = 'Backend Offline';
      }
    });
  }

  // Toggle extension enabled state
  toggleEnabled.addEventListener('change', async () => {
    const isNowEnabled = toggleEnabled.checked;
    await chrome.storage.local.set({ enabled: isNowEnabled });
    broadcastSettings({ enabled: isNowEnabled });
  });

  // Shortcut triggers from popup
  async function sendActionToActiveTab(actionName) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return;

    try {
      await chrome.tabs.sendMessage(tab.id, { action: actionName });
    } catch (err) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['notification.js', 'screenshot-handler.js', 'moodle-content.js']
        });
        await new Promise(r => setTimeout(r, 150));
        await chrome.tabs.sendMessage(tab.id, { action: actionName });
      } catch (injectErr) {
        console.warn('[Popup] Could not forward message:', injectErr.message);
      }
    }
  }

  btnHeroVision.addEventListener('click', async () => {
    btnHeroVision.style.opacity = '0.7';
    await sendActionToActiveTab('TRIGGER_SOLVE_SCREENSHOT');
    setTimeout(() => window.close(), 250);
  });

  btnSolve.addEventListener('click', async () => {
    btnSolve.style.opacity = '0.6';
    await sendActionToActiveTab('TRIGGER_SOLVE_QUESTION');
    setTimeout(() => window.close(), 250);
  });

  btnRepeat.addEventListener('click', async () => {
    btnRepeat.style.opacity = '0.6';
    await sendActionToActiveTab('TRIGGER_SHOW_LAST_ANSWER');
    setTimeout(() => window.close(), 250);
  });

  linkSettings.addEventListener('click', () => {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(chrome.runtime.getURL('settings.html'));
    }
  });

  async function broadcastSettings(updated) {
    const tabs = await chrome.tabs.query({});
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, { action: 'SETTINGS_UPDATED', ...updated }, () => {
        void chrome.runtime.lastError;
      });
    });
  }
});
