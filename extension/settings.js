/**
 * Moodle AI Quick Answer - Settings Controller
 */

document.addEventListener('DOMContentLoaded', async () => {
  const selectPosition = document.getElementById('select-position');
  const selectDuration = document.getElementById('select-duration');
  const inputBackendUrl = document.getElementById('input-backend-url');
  const btnTestConnection = document.getElementById('btn-test-connection');
  const btnClearCache = document.getElementById('btn-clear-cache');
  const btnSave = document.getElementById('btn-save-settings');
  const statusBox = document.getElementById('connection-status-box');
  const linkShortcuts = document.getElementById('link-shortcuts-page');
  const toast = document.getElementById('toast');

  // Load preferences
  const settings = await chrome.storage.local.get([
    'notificationPosition',
    'notificationDuration',
    'backendUrl'
  ]);

  if (settings.notificationPosition) {
    selectPosition.value = settings.notificationPosition;
  }
  if (settings.notificationDuration !== undefined) {
    selectDuration.value = String(settings.notificationDuration);
  } else {
    selectDuration.value = '500';
  }
  let currentBackendUrl = settings.backendUrl || 'https://extension-w1ac.onrender.com';
  if (currentBackendUrl.includes('localhost') || currentBackendUrl.includes('127.0.0.1')) {
    currentBackendUrl = 'https://extension-w1ac.onrender.com';
    chrome.storage.local.set({ backendUrl: currentBackendUrl });
  }
  inputBackendUrl.value = currentBackendUrl;

  // Test connection button
  btnTestConnection.addEventListener('click', async () => {
    const testUrl = inputBackendUrl.value.trim() || 'https://extension-w1ac.onrender.com';
    statusBox.className = 'status-box';
    statusBox.style.display = 'block';
    statusBox.textContent = 'Testing connection...';

    const wakeNoticeTimer = setTimeout(() => {
      if (statusBox.textContent === 'Testing connection...') {
        statusBox.textContent = 'Connecting... (If using free cloud like Render, instance may be waking up from sleep)';
      }
    }, 2500);

    const st = await chrome.storage.local.get(['activeProvider', 'customProviders']);
    const activeKey = st.activeProvider || 'gemini_1';

    const PROVIDER_NAMES = {
      gemini_1: 'Gemini (Key 1)',
      gemini_2: 'Gemini (Key 2)',
      gemini_3: 'Gemini (Key 3)',
      gemini_4: 'Gemini (Key 4)',
      gemini: 'Gemini',
      chatgpt: 'ChatGPT',
      openai: 'ChatGPT'
    };

    const MODEL_NAMES = {
      gemini_1: 'gemini-3.5-flash',
      gemini_2: 'gemini-3.5-flash',
      gemini_3: 'gemini-3.5-flash',
      gemini_4: 'gemini-3.5-flash',
      gemini: 'gemini-3.5-flash',
      chatgpt: 'gpt-4o-mini',
      openai: 'gpt-4o-mini'
    };

    const isCustom = activeKey.startsWith('custom_');
    const customObj = isCustom ? (st.customProviders || []).find(p => p.id === activeKey) : null;
    const activeDisplayName = isCustom ? (customObj?.name || 'Custom AI') : (PROVIDER_NAMES[activeKey] || 'AI');
    const activeModelName = isCustom ? (customObj?.model || 'custom') : (MODEL_NAMES[activeKey] || 'gemini-3.5-flash');

    // Sync selected provider with backend
    const backendProvider = activeKey.startsWith('gemini') ? 'gemini' : (activeKey === 'chatgpt' || activeKey === 'openai' ? 'chatgpt' : activeKey);
    chrome.runtime.sendMessage({
      action: 'AUTH_SELECT_PROVIDER',
      provider: backendProvider,
      backendUrl: testUrl
    });

    chrome.runtime.sendMessage({ action: 'CHECK_BACKEND_STATUS', backendUrl: testUrl }, (res) => {
      clearTimeout(wakeNoticeTimer);
      if (res && res.ok) {
        statusBox.className = 'status-box success';
        statusBox.innerHTML = `
          <strong>✅ Connected Successfully!</strong><br>
          Latency: <strong>${res.latencyMs}ms</strong> • Active AI: <strong>${activeDisplayName}</strong> • Model: <strong>${activeModelName}</strong> • Uptime: ${res.uptimeSeconds}s
        `;
      } else {
        statusBox.className = 'status-box error';
        statusBox.innerHTML = `
          <strong>❌ Connection Failed:</strong><br>
          ${res ? res.error : 'Backend unreachable'}.<br>
          Make sure your backend server is online at <code>${testUrl}</code>.
        `;
      }
    });
  });

  // Clear cache button
  btnClearCache.addEventListener('click', () => {
    const testUrl = inputBackendUrl.value.trim() || 'https://extension-w1ac.onrender.com';
    chrome.runtime.sendMessage({ action: 'CLEAR_CACHE', backendUrl: testUrl }, (res) => {
      if (res && res.success) {
        showToast('AI response cache cleared successfully!');
      } else {
        showToast('Failed to clear cache');
      }
    });
  });

  // Save settings
  btnSave.addEventListener('click', async () => {
    const updated = {
      notificationPosition: selectPosition.value,
      notificationDuration: parseInt(selectDuration.value, 10),
      backendUrl: inputBackendUrl.value.trim() || 'https://extension-w1ac.onrender.com'
    };

    await chrome.storage.local.set(updated);

    // Broadcast to open tabs
    const tabs = await chrome.tabs.query({});
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, { action: 'SETTINGS_UPDATED', ...updated }, () => {
        void chrome.runtime.lastError;
      });
    });

    showToast('Settings saved successfully!');
  });

  linkShortcuts.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => {
      toast.classList.remove('show');
    }, 2200);
  }
});
