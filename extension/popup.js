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


  // Shortcut action buttons
  const btnSolve = document.getElementById('btn-trigger-solve');
  const btnRepeat = document.getElementById('btn-trigger-repeat');

  // Add Provider Elements
  const btnShowAddProvider = document.getElementById('btn-show-add-provider');
  const addProviderForm = document.getElementById('add-provider-form');
  const newProviderSelect = document.getElementById('new-provider-select');
  const newProviderName = document.getElementById('new-provider-name');
  const newProviderEndpoint = document.getElementById('new-provider-endpoint');
  const newProviderKey = document.getElementById('new-provider-key');
  const btnCancelAddProvider = document.getElementById('btn-cancel-add-provider');
  const btnSaveNewProvider = document.getElementById('btn-save-new-provider');
  const customProvidersList = document.getElementById('custom-providers-list');

  // Load extension preferences & tokens
  const settings = await chrome.storage.local.get([
    'enabled',
    'backendUrl',
    'totalTokens',
    'usedTokens',
    'tokensGeminiTotal',
    'tokensGeminiUsed',
    'tokensChatgptTotal',
    'tokensChatgptUsed',
    'activeProvider',
    'customProviders'
  ]);
  let effectiveBackendUrl = settings.backendUrl || 'https://extension-w1ac.onrender.com';
  // If user had old localhost saved in browser storage, auto-migrate to live cloud backend
  if (!settings.backendUrl || settings.backendUrl.includes('localhost') || settings.backendUrl.includes('127.0.0.1')) {
    effectiveBackendUrl = 'https://extension-w1ac.onrender.com';
    chrome.storage.local.set({ backendUrl: effectiveBackendUrl });
  }
  toggleEnabled.checked = settings.enabled !== false;

  let currentActiveModelName = 'Gemini';
  let customProviders = settings.customProviders || [];

  // Toggle Add Provider form
  if (btnShowAddProvider) {
    btnShowAddProvider.addEventListener('click', () => {
      const isVisible = addProviderForm.style.display === 'flex';
      addProviderForm.style.display = isVisible ? 'none' : 'flex';
      if (!isVisible) {
        newProviderKey.focus();
      }
    });
  }

  if (btnCancelAddProvider) {
    btnCancelAddProvider.addEventListener('click', () => {
      addProviderForm.style.display = 'none';
      newProviderKey.value = '';
    });
  }

  if (newProviderSelect) {
    newProviderSelect.addEventListener('change', () => {
      const val = newProviderSelect.value;
      if (val === 'custom') {
        newProviderName.style.display = 'block';
        newProviderEndpoint.style.display = 'block';
        newProviderName.placeholder = 'Provider Name (e.g. My LLM)';
        newProviderEndpoint.placeholder = 'https://api.example.com/v1';
      } else {
        newProviderName.style.display = 'none';
        newProviderEndpoint.style.display = 'none';
      }
    });
  }

  // Preset dictionary for easy setup
  const PRESET_PROVIDERS = {
    claude: { name: 'Claude 3.5 Sonnet', logo: '🟣', endpoint: 'https://api.anthropic.com/v1' },
    deepseek: { name: 'DeepSeek V3', logo: '🐋', endpoint: 'https://api.deepseek.com/v1' },
    groq: { name: 'Groq (Llama 3.3)', logo: '⚡', endpoint: 'https://api.groq.com/openai/v1' },
    openrouter: { name: 'OpenRouter', logo: '🌐', endpoint: 'https://openrouter.ai/api/v1' },
    mistral: { name: 'Mistral AI', logo: '🌪️', endpoint: 'https://api.mistral.ai/v1' }
  };

  // Save new custom provider
  if (btnSaveNewProvider) {
    btnSaveNewProvider.addEventListener('click', async () => {
      const type = newProviderSelect.value;
      const key = newProviderKey.value.trim();

      if (!key) {
        alert('Please enter an API key for this provider.');
        return;
      }

      let name = '';
      let logo = '🤖';
      let endpoint = '';

      if (type === 'custom') {
        name = newProviderName.value.trim() || 'Custom AI';
        endpoint = newProviderEndpoint.value.trim() || 'https://api.openai.com/v1';
        logo = '🛠️';
      } else {
        const preset = PRESET_PROVIDERS[type] || { name: type, logo: '🤖', endpoint: '' };
        name = preset.name;
        logo = preset.logo;
        endpoint = preset.endpoint;
      }

      const newId = `custom_${type}_${Date.now()}`;
      const newProviderObj = {
        id: newId,
        type,
        name,
        logo,
        apiKey: key,
        endpoint,
        totalTokens: 100,
        usedTokens: 0,
        status: 'connected',
        createdAt: Date.now()
      };

      customProviders.push(newProviderObj);
      await chrome.storage.local.set({
        customProviders,
        activeProvider: newId,
        [`tokens_${newId}_total`]: 100,
        [`tokens_${newId}_used`]: 0
      });

      // Reset & hide form
      newProviderKey.value = '';
      addProviderForm.style.display = 'none';

      renderCustomProviders();
      refreshAuthStatus(effectiveBackendUrl);
    });
  }

  // Render dynamic custom providers
  async function renderCustomProviders(activeProviderId) {
    if (!customProvidersList) return;
    customProvidersList.innerHTML = '';

    const st = await chrome.storage.local.get(null);
    const currentActive = activeProviderId || st.activeProvider;

    customProviders.forEach(p => {
      const isActive = currentActive === p.id;
      const pStats = (st.realUsageStats?.providers || {})[p.id.toLowerCase()] || {};
      const solvesToday = pStats.solvesToday || 0;
      const tokensToday = pStats.tokensToday || 0;

      const card = document.createElement('div');
      card.className = `provider-card custom-card ${isActive ? 'active-card' : ''}`;
      card.id = `card-${p.id}`;

      card.innerHTML = `
        <div class="provider-top">
          <div class="provider-identity">
            <span class="provider-logo">${p.logo || '🤖'}</span>
            <span class="provider-name">${p.name}</span>
          </div>
          <div class="status-badge connected">
            <span class="dot"></span>
            <span class="badge-text">Connected</span>
          </div>
        </div>

        <div class="provider-actions">
          <label class="provider-selection">
            <input type="radio" name="active-provider" class="custom-radio-provider" value="${p.id}" ${isActive ? 'checked' : ''}>
            <span>Active Provider</span>
          </label>
          <div class="provider-btn-group">
            <button class="btn-change-key btn-key-custom" data-id="${p.id}" title="Add or update API key">+ Key</button>
            <button class="btn-remove-custom" data-id="${p.id}" title="Remove this provider">✕</button>
          </div>
        </div>

        <div class="key-input-row" id="key-row-${p.id}" style="display: none; margin-top: 8px;">
          <input type="password" class="key-input" id="key-input-${p.id}" placeholder="Enter new API key...">
          <button class="btn-save-key btn-save-key-custom" data-id="${p.id}">Save</button>
        </div>
      `;

      // Event handlers for this custom card
      const radio = card.querySelector('.custom-radio-provider');
      radio.addEventListener('change', async () => {
        if (radio.checked) {
          await chrome.storage.local.set({ activeProvider: p.id });
          currentActiveModelName = p.name;
          highlightActiveProvider(p.id);
        }
      });

      const btnKey = card.querySelector('.btn-key-custom');
      const keyRow = card.querySelector(`#key-row-${p.id}`);
      const keyInput = card.querySelector(`#key-input-${p.id}`);
      const btnSave = card.querySelector(`.btn-save-key-custom`);

      btnKey.addEventListener('click', () => {
        keyRow.style.display = keyRow.style.display === 'none' ? 'flex' : 'none';
        if (keyRow.style.display === 'flex') keyInput.focus();
      });

      btnSave.addEventListener('click', async () => {
        const val = keyInput.value.trim();
        if (val) {
          p.apiKey = val;
          await chrome.storage.local.set({ customProviders });
          keyInput.value = '';
          keyRow.style.display = 'none';
          alert(`Updated API key for ${p.name}!`);
        }
      });

      const btnRemove = card.querySelector('.btn-remove-custom');
      btnRemove.addEventListener('click', async () => {
        if (confirm(`Remove ${p.name} provider?`)) {
          customProviders = customProviders.filter(item => item.id !== p.id);
          await chrome.storage.local.set({ customProviders });
          if (currentActive === p.id) {
            await chrome.storage.local.set({ activeProvider: 'gemini' });
          }
          renderCustomProviders();
          refreshAuthStatus(effectiveBackendUrl);
        }
      });

      customProvidersList.appendChild(card);
    });

    if (currentActive && currentActive.startsWith('custom_')) {
      const activeObj = customProviders.find(p => p.id === currentActive);
      if (activeObj) {
        const total = st[`tokens_${activeObj.id}_total`] || activeObj.totalTokens || 100;
        const used = st[`tokens_${activeObj.id}_used`] || activeObj.usedTokens || 0;
        currentActiveModelName = activeObj.name;
      }
    }
  }

  const PROVIDER_DISPLAY_NAMES = {
    gemini_1: 'Gemini (Key 1)',
    gemini_2: 'Gemini (Key 2)',
    gemini_3: 'Gemini (Key 3)',
    gemini_4: 'Gemini (Key 4)',
    gemini: 'Gemini',
    chatgpt: 'ChatGPT',
    openai: 'ChatGPT',
    ollama: 'Ollama Local'
  };

  // Update Ollama tag and status
  const tagOllamaModel = document.getElementById('tag-ollama-model');
  const badgeOllama = document.getElementById('badge-ollama');
  const statusOllama = document.getElementById('status-ollama');

  async function updateOllamaPopupInfo() {
    const st = await chrome.storage.local.get(['ollamaSelectedModel', 'localBackendUrl', 'ollamaUrl']);
    if (tagOllamaModel) {
      tagOllamaModel.textContent = st.ollamaSelectedModel || 'Select in Settings ⚙';
    }
    chrome.runtime.sendMessage({
      action: 'OLLAMA_GET_STATUS',
      localBackendUrl: st.localBackendUrl || 'http://127.0.0.1:3000',
      ollamaUrl: st.ollamaUrl || 'http://127.0.0.1:11434'
    }, (res) => {
      if (res && res.ok) {
        if (badgeOllama) badgeOllama.className = 'status-badge connected';
        if (statusOllama) statusOllama.textContent = 'Connected';
        // Auto-select first available model if user hasn't chosen one yet
        if (!st.ollamaSelectedModel) {
          chrome.runtime.sendMessage({ action: 'OLLAMA_GET_MODELS' }, (mRes) => {
            if (mRes && mRes.ok && Array.isArray(mRes.models) && mRes.models.length > 0) {
              const best = mRes.models.find(m => m.capability === 'Vision') ||
                           mRes.models.find(m => m.capability !== 'Embedding') ||
                           mRes.models[0];
              const autoModel = best.name;
              chrome.storage.local.set({ ollamaSelectedModel: autoModel });
              if (tagOllamaModel) tagOllamaModel.textContent = autoModel;
            }
          });
        }
      } else {
        if (badgeOllama) badgeOllama.className = 'status-badge';
        if (statusOllama) statusOllama.textContent = 'Offline';
      }
    });
  }
  updateOllamaPopupInfo();

  let lastReportedLatency = 80;

  function updateFooterProviderStatus(providerId, latency) {
    if (latency !== undefined && latency !== null) {
      lastReportedLatency = latency;
    }
    const displayName = PROVIDER_DISPLAY_NAMES[providerId] || providerId || 'AI';
    if (serverText) {
      serverText.textContent = `Online (${displayName} • ${lastReportedLatency}ms)`;
    }
  }

  function highlightActiveProvider(val) {
    const allCards = document.querySelectorAll('.provider-card');
    allCards.forEach(c => c.classList.remove('active-card'));
    const targetCard = document.getElementById(`card-${val}`);
    if (targetCard) targetCard.classList.add('active-card');
    const targetRadio = document.querySelector(`input[name="active-provider"][value="${val}"]`);
    if (targetRadio) targetRadio.checked = true;
    updateFooterProviderStatus(val);
  }

  // Handle all provider radio selections (all 4 Gemini keys, ChatGPT, and custom providers)
  document.addEventListener('change', async (e) => {
    if (e.target && e.target.name === 'active-provider' && e.target.checked) {
      const selected = e.target.value;
      await chrome.storage.local.set({ activeProvider: selected });
      highlightActiveProvider(selected);

      // Notify backend server of the switch only if not offline Ollama
      if (selected !== 'ollama') {
        const backendProvider = selected.startsWith('gemini') ? 'gemini' : selected;
        chrome.runtime.sendMessage({
          action: 'AUTH_SELECT_PROVIDER',
          provider: backendProvider,
          backendUrl: effectiveBackendUrl
        });
      }
    }
  });

  // Highlight saved active provider initially
  const initialActive = settings.activeProvider || 'gemini_1';
  highlightActiveProvider(initialActive);

  // Render dynamic custom providers initially
  renderCustomProviders(settings.activeProvider);

  // Listen for provider changes
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.customProviders || changes.activeProvider) {
      renderCustomProviders();
      if (changes.activeProvider) {
        highlightActiveProvider(changes.activeProvider.newValue);
      }
    }
  });

  // Allow clicking anywhere on a provider card to select it
  document.addEventListener('click', (e) => {
    const card = e.target.closest('.provider-card');
    if (!card) return;
    if (e.target.closest('button') || e.target.tagName === 'INPUT' || e.target.closest('a') || e.target.closest('.key-tag')) return;
    const radio = card.querySelector('input[name="active-provider"]');
    if (radio && !radio.checked) {
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });

  // Initial loads
  await refreshServerHealth(effectiveBackendUrl);

  // Poll server health periodically while popup is open
  const pollInterval = setInterval(() => {
    refreshServerHealth(effectiveBackendUrl);
  }, 4000);

  window.addEventListener('unload', () => {
    clearInterval(pollInterval);
  });

  /**
   * Check backend health and latency without overriding user's active provider selection
   */
  async function refreshServerHealth(backendUrl) {
    chrome.runtime.sendMessage({ action: 'CHECK_BACKEND_STATUS', backendUrl }, async (res) => {
      const storageState = await chrome.storage.local.get(['activeProvider']);
      const currentActive = storageState.activeProvider || 'gemini_1';

      if (res && res.ok) {
        if (serverDot) serverDot.className = 'status-dot online';
        updateFooterProviderStatus(currentActive, res.latencyMs || 10);
      } else {
        if (serverDot) serverDot.className = 'status-dot offline';
        if (serverText) serverText.textContent = 'Backend Offline';
      }
    });
  }

  // Toggle extension enabled state
  if (toggleEnabled) {
    toggleEnabled.addEventListener('change', async () => {
      const isNowEnabled = toggleEnabled.checked;
      await chrome.storage.local.set({ enabled: isNowEnabled });
      broadcastSettings({ enabled: isNowEnabled });
    });
  }

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

  if (btnHeroVision) {
    btnHeroVision.addEventListener('click', async () => {
      btnHeroVision.style.opacity = '0.7';
      await sendActionToActiveTab('TRIGGER_SOLVE_SCREENSHOT');
      setTimeout(() => window.close(), 250);
    });
  }

  if (btnSolve) {
    btnSolve.addEventListener('click', async () => {
      btnSolve.style.opacity = '0.6';
      await sendActionToActiveTab('TRIGGER_SOLVE_QUESTION');
      setTimeout(() => window.close(), 250);
    });
  }

  if (btnRepeat) {
    btnRepeat.addEventListener('click', async () => {
      btnRepeat.style.opacity = '0.6';
      await sendActionToActiveTab('TRIGGER_SHOW_LAST_ANSWER');
      setTimeout(() => window.close(), 250);
    });
  }

  // Settings button: opens settings.html reliably in a new tab
  if (linkSettings) {
    linkSettings.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
    });
  }

  async function broadcastSettings(updated) {
    const tabs = await chrome.tabs.query({});
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, { action: 'SETTINGS_UPDATED', ...updated }, () => {
        void chrome.runtime.lastError;
      });
    });
  }
});
