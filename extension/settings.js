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
  if (settings.notificationDuration) {
    selectDuration.value = String(settings.notificationDuration);
  }
  let currentBackendUrl = settings.backendUrl || 'https://extension-w1ac.onrender.com';
  if (currentBackendUrl.includes('localhost') || currentBackendUrl.includes('127.0.0.1')) {
    currentBackendUrl = 'https://extension-w1ac.onrender.com';
    chrome.storage.local.set({ backendUrl: currentBackendUrl });
  }
  inputBackendUrl.value = currentBackendUrl;

  // Test connection button
  btnTestConnection.addEventListener('click', () => {
    const testUrl = inputBackendUrl.value.trim() || 'http://localhost:3001';
    statusBox.className = 'status-box';
    statusBox.style.display = 'block';
    statusBox.textContent = 'Testing connection...';

    chrome.runtime.sendMessage({ action: 'CHECK_BACKEND_STATUS', backendUrl: testUrl }, (res) => {
      if (res && res.ok) {
        statusBox.className = 'status-box success';
        statusBox.innerHTML = `
          <strong>✅ Connected Successfully!</strong><br>
          Latency: <strong>${res.latencyMs}ms</strong> • Provider: <strong>${res.provider || 'AI'}</strong> • Uptime: ${res.uptimeSeconds}s
        `;
      } else {
        statusBox.className = 'status-box error';
        statusBox.innerHTML = `
          <strong>❌ Connection Failed:</strong><br>
          ${res ? res.error : 'Backend unreachable'}.<br>
          Make sure your backend is running with <code>npm start</code> at ${testUrl}.
        `;
      }
    });
  });

  // Clear cache button
  btnClearCache.addEventListener('click', () => {
    const testUrl = inputBackendUrl.value.trim() || 'http://localhost:3001';
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
      backendUrl: inputBackendUrl.value.trim() || 'http://localhost:3001'
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
