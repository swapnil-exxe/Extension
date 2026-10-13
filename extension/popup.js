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

  // Token / Coins Counter Elements (if present)
  const usageRemaining = document.getElementById('usage-remaining');
  const usagePercentLeft = document.getElementById('usage-percent-left');
  const usageBarFill = document.getElementById('usage-bar-fill');
  const usageStatusDesc = document.getElementById('usage-status-desc');
  const btnRefillTokens = document.getElementById('btn-refill-tokens');

  // Individual Model Tokens / Coins Elements
  const tokensLeftGemini = document.getElementById('tokens-left-gemini');
  const tokensPctGemini = document.getElementById('tokens-pct-gemini');
  const quotaBarGemini = document.getElementById('quota-bar-gemini');

  const tokensLeftChatgpt = document.getElementById('tokens-left-chatgpt');
  const tokensPctChatgpt = document.getElementById('tokens-pct-chatgpt');
  const quotaBarChatgpt = document.getElementById('quota-bar-chatgpt');

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

  // Render per-model quota line
  function renderModelQuotaLine(model, total = 100, used = 0) {
    const left = Math.max(0, total - used);
    const leftPct = Math.min(100, Math.max(0, Math.round((left / total) * 100)));
    const isGemini = model === 'gemini';

    const tokensLeftEl = isGemini ? tokensLeftGemini : tokensLeftChatgpt;
    const tokensPctEl = isGemini ? tokensPctGemini : tokensPctChatgpt;
    const barEl = isGemini ? quotaBarGemini : quotaBarChatgpt;

    if (tokensLeftEl) tokensLeftEl.textContent = left;
    if (tokensPctEl) tokensPctEl.textContent = `${leftPct}% remaining`;
    if (barEl) {
      barEl.style.width = `${leftPct}%`;
      if (leftPct <= 0) {
        barEl.style.background = '#ef4444';
      } else if (leftPct <= 20) {
        barEl.style.background = '#f59e0b';
      } else {
        barEl.style.background = isGemini 
          ? 'linear-gradient(90deg, #10b981, #06b6d4)' 
          : 'linear-gradient(90deg, #3b82f6, #8b5cf6)';
      }
    }
  }

  // Render dynamic custom providers
  async function renderCustomProviders(activeProviderId) {
    if (!customProvidersList) return;
    customProvidersList.innerHTML = '';

    const st = await chrome.storage.local.get(null);
    const currentActive = activeProviderId || st.activeProvider;

    customProviders.forEach(p => {
      const total = st[`tokens_${p.id}_total`] || p.totalTokens || 100;
      const used = st[`tokens_${p.id}_used`] || p.usedTokens || 0;
      const left = Math.max(0, total - used);
      const leftPct = Math.min(100, Math.max(0, Math.round((left / total) * 100)));
      const isActive = currentActive === p.id;

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

        <!-- Dedicated stock / quota line for this custom provider -->
        <div class="provider-quota-row">
          <div class="provider-quota-meta">
            <span>${p.name} Stock: <strong class="provider-quota-tokens">${left}</strong> left</span>
            <span>${leftPct}% remaining</span>
          </div>
          <div class="provider-quota-bar">
            <div class="provider-quota-fill custom" style="width: ${leftPct}%; ${leftPct <= 0 ? 'background: #ef4444;' : leftPct <= 20 ? 'background: #f59e0b;' : ''}"></div>
          </div>
        </div>
      `;

      // Event handlers for this custom card
      const radio = card.querySelector('.custom-radio-provider');
      radio.addEventListener('change', async () => {
        if (radio.checked) {
          await chrome.storage.local.set({ activeProvider: p.id });
          currentActiveModelName = p.name;
          renderTokenQuota(total, used, p.name);
          renderCustomProviders(p.id);
          // uncheck native radios
          radioGemini.checked = false;
          radioChatgpt.checked = false;
          cardGemini.classList.remove('active-card');
          cardChatgpt.classList.remove('active-card');
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
        renderTokenQuota(total, used, activeObj.name);
      }
    }
  }

  // Render tokens / credit stock with percentage used and remaining
  function renderTokenQuota(total = 100, used = 0, modelName = currentActiveModelName) {
    if (!usageRemaining || !usageBarFill) return;

    const left = Math.max(0, total - used);
    const leftPct = Math.min(100, Math.max(0, Math.round((left / total) * 100)));
    const usedPct = 100 - leftPct;

    usageRemaining.textContent = left;
    if (usagePercentLeft) {
      usagePercentLeft.textContent = `(${leftPct}% left)`;
    }
    usageBarFill.style.width = `${leftPct}%`;

    if (usageStatusDesc) {
      if (leftPct <= 0) {
        usageBarFill.style.background = '#ef4444';
        usageStatusDesc.textContent = `❌ Out of tokens (100% used) • Refill required for ${modelName}`;
        usageStatusDesc.style.color = '#f87171';
      } else if (leftPct <= 20) {
        usageBarFill.style.background = '#f59e0b';
        usageStatusDesc.textContent = `⚠️ Low: ${usedPct}% used (${leftPct}% left) • Model: ${modelName}`;
        usageStatusDesc.style.color = '#fbbf24';
      } else {
        usageBarFill.style.background = 'linear-gradient(90deg, #10b981, #3b82f6)';
        usageStatusDesc.textContent = `⚡ ${usedPct}% used • ${leftPct}% left • Active Model: ${modelName}`;
        usageStatusDesc.style.color = '#94a3b8';
      }
    }
  }

  const initialTotal = settings.totalTokens || 100;
  const initialUsed = settings.usedTokens || 0;
  renderTokenQuota(initialTotal, initialUsed);

  // Render per-model lines initially
  renderModelQuotaLine('gemini', settings.tokensGeminiTotal || 100, settings.tokensGeminiUsed || 0);
  renderModelQuotaLine('chatgpt', settings.tokensChatgptTotal || 100, settings.tokensChatgptUsed || 0);
  renderCustomProviders(settings.activeProvider);

  // Refill tokens button (refills all model stocks to 100)
  if (btnRefillTokens) {
    btnRefillTokens.addEventListener('click', async () => {
      const refillData = {
        totalTokens: 100,
        usedTokens: 0,
        tokensGeminiTotal: 100,
        tokensGeminiUsed: 0,
        tokensChatgptTotal: 100,
        tokensChatgptUsed: 0
      };
      customProviders.forEach(p => {
        refillData[`tokens_${p.id}_total`] = 100;
        refillData[`tokens_${p.id}_used`] = 0;
      });

      await chrome.storage.local.set(refillData);
      renderTokenQuota(100, 0);
      renderModelQuotaLine('gemini', 100, 0);
      renderModelQuotaLine('chatgpt', 100, 0);
      renderCustomProviders();
      if (usageStatusDesc) {
        usageStatusDesc.textContent = '🎉 All AI model packs refilled to 100 tokens (100% full)!';
      }
    });
  }

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
      const storageState = await chrome.storage.local.get(['activeProvider']);
      chrome.runtime.sendMessage({ action: 'AUTH_GET_STATUS', backendUrl }, (res) => {
        if (!res || !res.providers) return;

        const effectiveActive = storageState.activeProvider 
          ? { provider: storageState.activeProvider } 
          : res.active;

        renderProviderCard('gemini', res.providers.gemini, effectiveActive);
        renderProviderCard('chatgpt', res.providers.chatgpt, effectiveActive);
        renderCustomProviders(effectiveActive?.provider);
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
      currentActiveModelName = isGpt ? 'ChatGPT (GPT-4o-mini)' : 'Gemini (Flash-Lite)';
      chrome.storage.local.get(['totalTokens', 'usedTokens'], (st) => {
        renderTokenQuota(st.totalTokens || 100, st.usedTokens || 0, currentActiveModelName);
      });
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
          feedback.style.display = 'block';
        } else {
          feedback.style.display = 'none';
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

  // Connected Key change buttons & inputs
  const btnToggleKeyConnectedGemini = document.getElementById('btn-toggle-key-connected-gemini');
  const keyRowConnectedGemini = document.getElementById('key-row-connected-gemini');
  const keyInputConnectedGemini = document.getElementById('key-input-connected-gemini');
  const btnSaveConnectedGemini = document.getElementById('btn-save-connected-gemini');

  const btnToggleKeyConnectedChatgpt = document.getElementById('btn-toggle-key-connected-chatgpt');
  const keyRowConnectedChatgpt = document.getElementById('key-row-connected-chatgpt');
  const keyInputConnectedChatgpt = document.getElementById('key-input-connected-chatgpt');
  const btnSaveConnectedChatgpt = document.getElementById('btn-save-connected-chatgpt');

  if (btnToggleKeyConnectedGemini) {
    btnToggleKeyConnectedGemini.addEventListener('click', () => {
      keyRowConnectedGemini.style.display = keyRowConnectedGemini.style.display === 'none' ? 'flex' : 'none';
      if (keyRowConnectedGemini.style.display === 'flex') keyInputConnectedGemini.focus();
    });
  }

  if (btnSaveConnectedGemini) {
    btnSaveConnectedGemini.addEventListener('click', () => {
      saveKey('gemini', keyInputConnectedGemini, btnSaveConnectedGemini, feedbackGemini);
    });
  }

  if (btnToggleKeyConnectedChatgpt) {
    btnToggleKeyConnectedChatgpt.addEventListener('click', () => {
      keyRowConnectedChatgpt.style.display = keyRowConnectedChatgpt.style.display === 'none' ? 'flex' : 'none';
      if (keyRowConnectedChatgpt.style.display === 'flex') keyInputConnectedChatgpt.focus();
    });
  }

  if (btnSaveConnectedChatgpt) {
    btnSaveConnectedChatgpt.addEventListener('click', () => {
      saveKey('chatgpt', keyInputConnectedChatgpt, btnSaveConnectedChatgpt, feedbackChatgpt);
    });
  }

  toggleKeyGemini.addEventListener('click', () => {
    keyRowGemini.style.display = keyRowGemini.style.display === 'none' ? 'flex' : 'none';
  });
  toggleKeyChatgpt.addEventListener('click', () => {
    keyRowChatgpt.style.display = keyRowChatgpt.style.display === 'none' ? 'flex' : 'none';
  });

  /**
   * Switch active provider via radio selection
   */
  radioChatgpt.addEventListener('change', async () => {
    if (radioChatgpt.checked) {
      await chrome.storage.local.set({ activeProvider: 'chatgpt' });
      document.querySelectorAll('.custom-radio-provider').forEach(r => r.checked = false);
      document.querySelectorAll('.custom-card').forEach(c => c.classList.remove('active-card'));
      chrome.runtime.sendMessage({ action: 'AUTH_SELECT_PROVIDER', provider: 'chatgpt', backendUrl: effectiveBackendUrl }, () => {
        refreshAuthStatus(effectiveBackendUrl);
        refreshServerHealth(effectiveBackendUrl);
      });
    }
  });

  radioGemini.addEventListener('change', async () => {
    if (radioGemini.checked) {
      await chrome.storage.local.set({ activeProvider: 'gemini' });
      document.querySelectorAll('.custom-radio-provider').forEach(r => r.checked = false);
      document.querySelectorAll('.custom-card').forEach(c => c.classList.remove('active-card'));
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
