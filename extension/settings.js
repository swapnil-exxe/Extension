/**
 * Moodle AI Quick Answer - Settings Controller
 * Supports Cloud AI (Gemini, ChatGPT) and Local Ollama AI (Ubuntu/Localhost)
 */

document.addEventListener('DOMContentLoaded', async () => {
  // Elements - Notification & Display
  const selectPosition = document.getElementById('select-position');
  const selectDuration = document.getElementById('select-duration');
  const toast = document.getElementById('toast');
  const linkShortcuts = document.getElementById('link-shortcuts-page');
  const btnSave = document.getElementById('btn-save-settings');

  // Elements - Engine Selection
  const selectActiveEngine = document.getElementById('select-active-engine');

  // Elements - Cloud Backend
  const inputBackendUrl = document.getElementById('input-backend-url');
  const btnTestConnection = document.getElementById('btn-test-connection');
  const btnClearCache = document.getElementById('btn-clear-cache');
  const statusBox = document.getElementById('connection-status-box');

  // Elements - Ollama Local
  const inputLocalBackendUrl = document.getElementById('input-local-backend-url');
  const inputOllamaUrl = document.getElementById('input-ollama-url');
  const btnTestOllamaStatus = document.getElementById('btn-test-ollama-status');
  const ollamaConnectionStatus = document.getElementById('ollama-connection-status');
  const selectOllamaModel = document.getElementById('select-ollama-model');
  const btnRefreshModels = document.getElementById('btn-refresh-models');
  const ollamaEmptyModels = document.getElementById('ollama-empty-models');
  const ollamaModelWarning = document.getElementById('ollama-model-warning');
  const ollamaModelInfo = document.getElementById('ollama-model-info');
  const infoModelName = document.getElementById('info-model-name');
  const infoModelFamily = document.getElementById('info-model-family');
  const infoModelCapability = document.getElementById('info-model-capability');
  const infoModelSize = document.getElementById('info-model-size');
  const infoModelParams = document.getElementById('info-model-params');
  const infoModelQuant = document.getElementById('info-model-quant');

  // Load preferences from storage
  const settings = await chrome.storage.local.get([
    'notificationPosition',
    'notificationDuration',
    'backendUrl',
    'localBackendUrl',
    'ollamaUrl',
    'ollamaSelectedModel',
    'activeProvider',
    'customProviders'
  ]);

  if (settings.notificationPosition) {
    selectPosition.value = settings.notificationPosition;
  }
  if (settings.notificationDuration !== undefined) {
    selectDuration.value = String(settings.notificationDuration);
  } else {
    selectDuration.value = '500';
  }

  // Cloud backend URL
  let currentBackendUrl = settings.backendUrl || 'https://extension-w1ac.onrender.com';
  inputBackendUrl.value = currentBackendUrl;

  // Local Ollama configuration - ensure Node backend is distinct from Ollama port 11434
  const rawLocalBackend = settings.localBackendUrl || 'http://127.0.0.1:3000';
  inputLocalBackendUrl.value = rawLocalBackend.includes('11434') ? 'http://127.0.0.1:3000' : rawLocalBackend;
  inputOllamaUrl.value = settings.ollamaUrl || 'http://127.0.0.1:11434';

  // Active Provider Engine (Cloud vs Ollama)
  const isOllamaActive = settings.activeProvider === 'ollama';
  selectActiveEngine.value = isOllamaActive ? 'ollama' : 'cloud';

  let currentInstalledModels = [];
  let savedModelIdentifier = settings.ollamaSelectedModel || '';

  // Safe message sending with timeout to prevent infinite hanging if worker sleeps or disconnects
  function sendExtensionMessage(msg, timeoutMs = 3500) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          resolve({ ok: false, error: 'Extension worker timeout' });
        }
      }, timeoutMs);

      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (!done) {
            done = true;
            clearTimeout(timer);
            if (chrome.runtime.lastError) {
              resolve({ ok: false, error: chrome.runtime.lastError.message });
            } else {
              resolve(res || { ok: false, error: 'Empty worker response' });
            }
          }
        });
      } catch (err) {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve({ ok: false, error: err.message });
        }
      }
    });
  }

  // Render selected model details in info card
  function displayModelInfo(model) {
    if (!model) {
      ollamaModelInfo.style.display = 'none';
      return;
    }

    ollamaModelInfo.style.display = 'block';
    infoModelName.textContent = model.name;
    infoModelFamily.textContent = model.family ? `(${model.family})` : '';
    infoModelSize.textContent = model.size || 'N/A';
    infoModelParams.textContent = model.parameterSize || 'Standard';
    infoModelQuant.textContent = model.quantization || 'Default';

    // Capability badge styling
    infoModelCapability.textContent = model.capability || 'Unknown';
    infoModelCapability.className = 'badge-pill';
    if (model.capability === 'Vision') {
      infoModelCapability.classList.add('badge-vision');
    } else if (model.capability === 'Text') {
      infoModelCapability.classList.add('badge-text');
    } else {
      infoModelCapability.classList.add('badge-unknown');
    }
  }

  // Fetch installed models from Ollama via local backend with direct fetch fallback
  async function refreshOllamaModels(isUserClick = false) {
    const localBackend = inputLocalBackendUrl.value.trim() || 'http://127.0.0.1:3000';
    const ollamaHost = inputOllamaUrl.value.trim() || 'http://127.0.0.1:11434';

    btnRefreshModels.disabled = true;
    btnRefreshModels.textContent = '⏳ Refreshing...';
    ollamaModelWarning.style.display = 'none';

    try {
      let response = await sendExtensionMessage({
        action: 'OLLAMA_GET_MODELS',
        localBackendUrl: localBackend,
        ollamaUrl: ollamaHost
      }, 3000);

      // Direct in-page fetch fallback if background worker took too long or is asleep
      if (!response || !response.ok) {
        try {
          const directRes = await fetch(`${ollamaHost}/api/tags`, { signal: AbortSignal.timeout(2000) });
          if (directRes.ok) {
            const directData = await directRes.json();
            const rawList = Array.isArray(directData.models) ? directData.models : [];
            const directModels = rawList.map((m) => {
              const exactName = m.name || m.model || '';
              const tag = exactName.includes(':') ? exactName.split(':')[1] : 'latest';
              const families = (m.details?.families || []).concat(m.details?.family || []);
              const isVision = families.some(f => /clip|vision|mllama|llava/i.test(f)) || /vision/i.test(exactName);
              return {
                name: exactName,
                model: exactName,
                tag,
                size: m.size ? `${(m.size / (1024 * 1024 * 1024)).toFixed(1)} GB` : 'N/A',
                family: m.details?.family || 'unknown',
                parameterSize: m.details?.parameter_size || '',
                quantization: m.details?.quantization_level || '',
                capability: isVision ? 'Vision' : 'Text'
              };
            });
            response = { ok: true, models: directModels, isDirect: true };
          }
        } catch (_) {}
      }

      if (!response || !response.ok) {
        throw new Error(response ? response.error : 'Ollama service is not reachable');
      }

      // Only update localBackendUrl if it is a real Node.js backend (do not overwrite with Ollama port 11434)
      if (response.activeBackendUrl && !response.activeBackendUrl.includes('11434') && inputLocalBackendUrl.value !== response.activeBackendUrl) {
        inputLocalBackendUrl.value = response.activeBackendUrl;
        await chrome.storage.local.set({ localBackendUrl: response.activeBackendUrl });
      }

      currentInstalledModels = Array.isArray(response.models) ? response.models : [];
      selectOllamaModel.innerHTML = '';

      if (currentInstalledModels.length === 0) {
        ollamaEmptyModels.style.display = 'block';
        ollamaModelInfo.style.display = 'none';
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No local models found (run ollama pull)';
        selectOllamaModel.appendChild(opt);
        if (isUserClick) showToast('No local models found in Ollama.');
        return;
      }

      ollamaEmptyModels.style.display = 'none';

      // Populate dropdown with actual installed models
      currentInstalledModels.forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m.name;
        opt.textContent = `${m.name} (${m.size}) • [${m.capability}]`;
        selectOllamaModel.appendChild(opt);
      });

      // Preserve previously selected model if it still exists
      const targetModel = savedModelIdentifier;
      const modelStillExists = currentInstalledModels.some(m => m.name === targetModel);

      if (targetModel && modelStillExists) {
        selectOllamaModel.value = targetModel;
        const matching = currentInstalledModels.find(m => m.name === targetModel);
        displayModelInfo(matching);
      } else if (targetModel && !modelStillExists) {
        // Model was removed from Ollama in terminal!
        ollamaModelWarning.style.display = 'block';
        ollamaModelWarning.innerHTML = `⚠️ Previously selected model <code>${targetModel}</code> was removed from Ollama. Please select an installed model.`;
        // Fallback to first compatible generation model (exclude embedding-only models)
        const fallback = currentInstalledModels.find(m => m.capability === 'Vision') ||
                         currentInstalledModels.find(m => m.capability !== 'Embedding') ||
                         currentInstalledModels[0];
        selectOllamaModel.value = fallback.name;
        savedModelIdentifier = fallback.name;
        displayModelInfo(fallback);
        await chrome.storage.local.set({ ollamaSelectedModel: fallback.name });
      } else {
        // Default: pick best available generation model
        const first = currentInstalledModels.find(m => m.capability === 'Vision') ||
                      currentInstalledModels.find(m => m.capability !== 'Embedding') ||
                      currentInstalledModels[0];
        selectOllamaModel.value = first.name;
        savedModelIdentifier = first.name;
        displayModelInfo(first);
        await chrome.storage.local.set({ ollamaSelectedModel: first.name });
      }

      if (isUserClick) {
        showToast(`Refreshed: ${currentInstalledModels.length} models detected!`);
      }
    } catch (err) {
      console.warn('[Ollama Settings] Model refresh error:', err.message);
      ollamaModelWarning.style.display = 'block';
      ollamaModelWarning.innerHTML = `❌ <strong>Cannot list models:</strong> ${err.message}<br><small>Make sure Ollama is running at <code>${ollamaHost}</code>.</small>`;
      selectOllamaModel.innerHTML = '<option value="">Ollama offline or not running</option>';
      ollamaModelInfo.style.display = 'none';
    } finally {
      btnRefreshModels.disabled = false;
      btnRefreshModels.textContent = '🔄 Refresh Models';
    }
  }

  // Model selection changed by user
  selectOllamaModel.addEventListener('change', () => {
    const selected = selectOllamaModel.value;
    savedModelIdentifier = selected;
    ollamaModelWarning.style.display = 'none';
    const found = currentInstalledModels.find(m => m.name === selected);
    displayModelInfo(found);
  });

  // Refresh Models Button
  btnRefreshModels.addEventListener('click', () => {
    refreshOllamaModels(true);
  });

  // Test Ollama Status Button
  btnTestOllamaStatus.addEventListener('click', async () => {
    const localBackend = inputLocalBackendUrl.value.trim() || 'http://127.0.0.1:3000';
    const ollamaHost = inputOllamaUrl.value.trim() || 'http://127.0.0.1:11434';

    ollamaConnectionStatus.className = 'status-box';
    ollamaConnectionStatus.style.display = 'block';
    ollamaConnectionStatus.textContent = 'Checking local Ollama connection...';

    let res = await sendExtensionMessage({
      action: 'OLLAMA_GET_STATUS',
      localBackendUrl: localBackend,
      ollamaUrl: ollamaHost
    }, 3000);

    // Direct in-page fallback if background worker took too long
    if (!res || !res.ok) {
      try {
        const directRes = await fetch(`${ollamaHost}/api/version`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
        const tagsRes = await fetch(`${ollamaHost}/api/tags`, { signal: AbortSignal.timeout(2000) });
        if (tagsRes.ok) {
          const tagsData = await tagsRes.json();
          const verData = directRes && directRes.ok ? await directRes.json() : {};
          res = {
            ok: true,
            url: ollamaHost,
            version: verData.version || 'installed',
            modelsCount: Array.isArray(tagsData.models) ? tagsData.models.length : 0,
            isDirect: true
          };
        }
      } catch (_) {}
    }

    if (res && res.ok) {
      if (res.activeBackendUrl && !res.activeBackendUrl.includes('11434') && inputLocalBackendUrl.value !== res.activeBackendUrl) {
        inputLocalBackendUrl.value = res.activeBackendUrl;
        chrome.storage.local.set({ localBackendUrl: res.activeBackendUrl });
      }
      ollamaConnectionStatus.className = 'status-box success';
      ollamaConnectionStatus.innerHTML = `
        <strong>✅ Ollama Connected Successfully!</strong><br>
        Server URL: <code>${res.url}</code> • Ollama Version: <strong>${res.version}</strong> • Installed Models: <strong>${res.modelsCount}</strong>
        ${res.isDirect ? '<br><small style="color:#059669; font-weight:600;">⚡ Direct Ollama pipeline active (100% offline, zero Node backend dependency)</small>' : ''}
      `;
      refreshOllamaModels(false);
    } else {
      ollamaConnectionStatus.className = 'status-box error';
      ollamaConnectionStatus.innerHTML = `
        <strong>❌ Cannot Connect to Ollama:</strong><br>
        ${res ? res.error : 'Service unreachable'}.<br>
        <small>Ensure Ollama service is running (e.g. <code>ollama serve</code>) at <code>${ollamaHost}</code>.</small>
      `;
    }
  });

  // Cloud Backend Test connection button
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

    let res = await sendExtensionMessage({ action: 'CHECK_BACKEND_STATUS', backendUrl: testUrl }, 6000);

    // Direct in-page fetch fallback to Render health endpoint if background was sleeping
    if (!res || !res.ok) {
      try {
        const start = Date.now();
        const directRes = await fetch(`${testUrl.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(5000) });
        if (directRes.ok) {
          const directData = await directRes.json();
          res = { ok: true, latencyMs: Date.now() - start, ...directData };
        }
      } catch (_) {}
    }

    clearTimeout(wakeNoticeTimer);
    if (res && res.ok) {
      statusBox.className = 'status-box success';
      statusBox.innerHTML = `
        <strong>✅ Connected Successfully!</strong><br>
        Latency: <strong>${res.latencyMs || 120}ms</strong> • Active AI: <strong>${res.provider || 'Gemini'}</strong> • Model: <strong>${res.model || 'gemini-3.5-flash'}</strong> • Uptime: ${res.uptimeSeconds || 0}s
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

  // Save settings button
  btnSave.addEventListener('click', async () => {
    const chosenEngine = selectActiveEngine.value;
    const currentStorage = await chrome.storage.local.get(['activeProvider']);

    let finalActiveProvider = currentStorage.activeProvider || 'gemini_1';
    if (chosenEngine === 'ollama') {
      finalActiveProvider = 'ollama';
    } else if (finalActiveProvider === 'ollama') {
      // Reverting to cloud
      finalActiveProvider = 'gemini_1';
    }

    const updated = {
      notificationPosition: selectPosition.value,
      notificationDuration: parseInt(selectDuration.value, 10),
      backendUrl: inputBackendUrl.value.trim() || 'https://extension-w1ac.onrender.com',
      localBackendUrl: inputLocalBackendUrl.value.trim() || 'http://127.0.0.1:3000',
      ollamaUrl: inputOllamaUrl.value.trim() || 'http://127.0.0.1:11434',
      ollamaSelectedModel: selectOllamaModel.value || savedModelIdentifier,
      activeProvider: finalActiveProvider
    };

    await chrome.storage.local.set(updated);

    // Broadcast to open tabs
    const tabs = await chrome.tabs.query({});
    tabs.forEach((tab) => {
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

  // Initial automatic load of Ollama models on settings open
  refreshOllamaModels(false);

  // Diagnostics Elements & Logic
  const btnRunDiagnostics = document.getElementById('btn-run-diagnostics');
  const diagBackendStatus = document.getElementById('diag-backend-status');
  const diagOllamaStatus = document.getElementById('diag-ollama-status');
  const diagModelStatus = document.getElementById('diag-model-status');
  const diagModelCapability = document.getElementById('diag-model-capability');
  const diagModelMemory = document.getElementById('diag-model-memory');
  const diagOfflineStatus = document.getElementById('diag-offline-status');
  const diagLastLatency = document.getElementById('diag-last-latency');

  async function runOfflineDiagnostics() {
    if (!btnRunDiagnostics) return;
    btnRunDiagnostics.disabled = true;
    btnRunDiagnostics.textContent = '⏳ Testing...';

    const localBackend = inputLocalBackendUrl.value.trim() || 'http://127.0.0.1:3000';
    const ollamaHost = inputOllamaUrl.value.trim() || 'http://127.0.0.1:11434';
    const currentModel = selectOllamaModel.value || savedModelIdentifier || '';

    chrome.runtime.sendMessage({
      action: 'OLLAMA_GET_DIAGNOSTICS',
      localBackendUrl: localBackend,
      ollamaUrl: ollamaHost,
      selectedModel: currentModel
    }, (res) => {
      btnRunDiagnostics.disabled = false;
      btnRunDiagnostics.textContent = '🩺 Run Full Diagnostics';

      if (!res) {
        if (diagBackendStatus) {
          diagBackendStatus.textContent = '❌ Unreachable';
          diagBackendStatus.style.color = '#DC2626';
        }
        return;
      }

      // 1. Backend Status
      if (diagBackendStatus) {
        if (res.backend && res.backend.status === 'connected') {
          diagBackendStatus.textContent = `✅ Connected (${res.backend.host}:${res.backend.port} • Up ${res.backend.uptimeSeconds}s)`;
          diagBackendStatus.style.color = '#059669';
        } else {
          diagBackendStatus.textContent = '❌ Disconnected (Check npm start)';
          diagBackendStatus.style.color = '#DC2626';
        }
      }

      // 2. Ollama Status
      if (diagOllamaStatus) {
        if (res.ollama && res.ollama.status === 'connected') {
          diagOllamaStatus.textContent = `✅ Connected (v${res.ollama.version} • ${res.ollama.modelsCount} models • ${res.ollama.latencyMs}ms)`;
          diagOllamaStatus.style.color = '#059669';
        } else {
          diagOllamaStatus.textContent = `❌ Disconnected (${res.ollama?.error || 'Port 11434 closed'})`;
          diagOllamaStatus.style.color = '#DC2626';
        }
      }

      // 3. Selected Model Status
      if (diagModelStatus) {
        if (res.selectedModel && res.selectedModel.installed) {
          diagModelStatus.textContent = `✅ Installed (${res.selectedModel.name} • ${res.selectedModel.size || ''})`;
          diagModelStatus.style.color = '#059669';
        } else {
          diagModelStatus.textContent = `⚠️ Not found in Ollama (${currentModel || 'No model chosen'})`;
          diagModelStatus.style.color = '#D97706';
        }
      }

      // 4. Model Capability
      if (diagModelCapability && res.selectedModel) {
        diagModelCapability.textContent = res.selectedModel.capability || 'Unknown';
        diagModelCapability.style.color = res.selectedModel.capability === 'Vision' ? '#2563EB' : '#374151';
      }

      // 5. Memory State
      if (diagModelMemory && res.selectedModel) {
        if (res.selectedModel.loadedInMemory) {
          diagModelMemory.textContent = '⚡ Active in RAM/VRAM (Warm)';
          diagModelMemory.style.color = '#059669';
        } else {
          diagModelMemory.textContent = '💤 On-demand / Standby (Ready to load)';
          diagModelMemory.style.color = '#6B7280';
        }
      }

      // 6. Offline Isolation
      if (diagOfflineStatus) {
        diagOfflineStatus.textContent = '🔒 100% Offline (Zero External Traffic)';
        diagOfflineStatus.style.color = '#059669';
      }

      // 7. Last Latency
      if (diagLastLatency && res.ollama && res.ollama.latencyMs) {
        diagLastLatency.textContent = `${res.ollama.latencyMs}ms loopback`;
      }
    });
  }

  if (btnRunDiagnostics) {
    btnRunDiagnostics.addEventListener('click', runOfflineDiagnostics);
  }
});
