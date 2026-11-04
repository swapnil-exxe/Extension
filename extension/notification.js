/**
 * Moodle AI Quick Answer - Centralized Notification Manager
 * Enforces a single active notification on screen. Never stacks or overlaps.
 */

(function () {
  'use strict';

  const isTopFrame = (window === window.top);

  class QuickNotification {
    constructor() {
      this.container = null;
      this.host = null;
      this.shadow = null;
      this.box = null;
      this.timerId = null;
      this.currentDurationMs = 500; // 0.5s default for ultra-fast glance
      this.currentPosition = 'top-right';
      this.chunks = [];
      this.currentChunkIndex = 0;
      this.fullText = '';
      this.explanationText = '';
      this.isExpanded = false;
      this.isOllama = false;

      this.init();

      // Listen for cross-frame notification requests if applicable
      if (isTopFrame) {
        window.addEventListener('message', (e) => {
          if (e.data && e.data.type === 'MOODLE_SHOW_NOTIFICATION') {
            const { action, payload } = e.data;
            if (action === 'showAnswer') this.showAnswer(payload);
            else if (action === 'showStatus') this.showStatus(payload);
            else if (action === 'showError') this.showError(payload);
          }
        });
      }
    }

    async init() {
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          const settings = await chrome.storage.local.get(['notificationPosition', 'notificationDuration']);
          if (settings.notificationPosition) {
            this.currentPosition = settings.notificationPosition;
          }
          if (settings.notificationDuration !== undefined) {
            this.currentDurationMs = parseInt(settings.notificationDuration, 10) || 500;
          }
        }
      } catch (_) {}

      if (isTopFrame) {
        this.ensureDOM();
      }

      console.log('[Moodle AI] NOTIFICATION_INITIALIZED:', {
        position: this.currentPosition,
        durationMs: this.currentDurationMs,
        isTopFrame
      });
    }

    ensureDOM() {
      if (!isTopFrame) {
        try {
          if (window.top && window.top !== window) {
            return;
          }
        } catch (_) {}
      }

      const targetParent = document.fullscreenElement || document.documentElement || document.body;
      if (!targetParent) return;

      // If host is already attached and has box, ensure positioned and return
      if (this.host && this.box) {
        if (this.host.parentNode !== targetParent) {
          targetParent.appendChild(this.host);
        }
        this.applyPositionStyles(this.host, this.currentPosition);
        return;
      }

      // Check for existing host in DOM
      const existingHost = document.getElementById('moodle-quick-notify-host');
      if (existingHost && existingHost.shadowRoot && existingHost.shadowRoot.getElementById('notify-box')) {
        this.host = existingHost;
        this.container = existingHost;
        this.shadow = existingHost.shadowRoot;
        this.box = this.shadow.getElementById('notify-box');
        if (this.host.parentNode !== targetParent) {
          targetParent.appendChild(this.host);
        }
        this.applyPositionStyles(this.host, this.currentPosition);
        return;
      }

      if (existingHost) {
        existingHost.remove();
      }

      this.createDOM();
    }

    createDOM() {
      if (!isTopFrame) {
        try {
          if (window.top && window.top !== window) {
            return;
          }
        } catch (_) {}
      }

      const targetParent = document.fullscreenElement || document.documentElement || document.body;
      if (!targetParent) return;

      // Purge any stale or duplicate host elements
      const existingHosts = document.querySelectorAll('#moodle-quick-notify-host');
      if (existingHosts.length > 0) {
        existingHosts.forEach((h, idx) => {
          if (idx > 0) h.remove();
        });
        this.host = existingHosts[0];
        this.container = this.host;
        this.shadow = this.host.shadowRoot;
        this.box = this.shadow ? this.shadow.getElementById('notify-box') : null;
        if (this.box) {
          if (this.host.parentNode !== targetParent) {
            targetParent.appendChild(this.host);
          }
          this.applyPositionStyles(this.host, this.currentPosition);
          return;
        }
        this.host.remove();
      }

      const host = document.createElement('div');
      host.id = 'moodle-quick-notify-host';
      host.style.cssText = `
        position: fixed !important;
        z-index: 2147483647 !important;
        pointer-events: none !important;
        display: none !important;
        border: none !important;
        outline: none !important;
        background: transparent !important;
        box-shadow: none !important;
        margin: 0 !important;
        padding: 0 !important;
        line-height: normal !important;
        width: auto !important;
        height: auto !important;
        max-width: min(460px, 92vw) !important;
        overflow: visible !important;
      `;
      this.applyPositionStyles(host, this.currentPosition);

      // Shadow DOM for complete CSS isolation
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = `
        :host {
          display: block !important;
          position: fixed !important;
          z-index: 2147483647 !important;
          pointer-events: none !important;
          border: none !important;
          outline: none !important;
          background: transparent !important;
          box-shadow: none !important;
          margin: 0 !important;
          padding: 0 !important;
          line-height: normal !important;
        }
        .quick-notify-box {
          display: none !important;
          background: #FFFFFF !important;
          color: #000000 !important;
          border: 1px solid #E5E5E5 !important;
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12) !important;
          border-radius: 6px !important;
          padding: 6px 10px !important;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
          font-size: 13px !important;
          font-weight: 700 !important;
          letter-spacing: 0.2px !important;
          line-height: 1.35 !important;
          max-width: min(440px, 92vw) !important;
          box-sizing: border-box !important;
          pointer-events: auto !important;
          cursor: pointer !important;
          user-select: none !important;
          opacity: 1 !important;
          visibility: visible !important;
          transition: opacity 0.15s ease, transform 0.15s ease !important;
        }
        .quick-notify-box.visible {
          display: inline-block !important;
          opacity: 1 !important;
          visibility: visible !important;
        }
        .quick-notify-box.status {
          background: #FFFFFF !important;
          color: #000000 !important;
          border: 1px solid #E5E5E5 !important;
          font-weight: 500 !important;
          font-size: 13px !important;
          padding: 6px 12px !important;
        }
        .quick-notify-box.error {
          background: #FFFFFF !important;
          color: #991B1B !important;
          border: 1px solid #E5E5E5 !important;
          font-weight: 600 !important;
          font-size: 12px !important;
        }
        .loading-dot {
          display: inline-block !important;
          font-size: 14px !important;
          line-height: 1 !important;
          color: #000000 !important;
          padding: 1px 4px !important;
          user-select: none !important;
          vertical-align: middle !important;
        }
        .answer-row {
          display: inline-flex !important;
          align-items: center !important;
          white-space: pre-wrap !important;
          word-break: break-word !important;
          line-height: 1.35 !important;
        }
        .answer-text {
          display: inline !important;
          font-weight: 700 !important;
          color: #000000 !important;
        }
        .ollama-badge {
          display: inline-flex !important;
          align-items: center !important;
          justify-content: center !important;
          margin-left: 6px !important;
          font-size: 13px !important;
          line-height: 1 !important;
          cursor: help !important;
          user-select: none !important;
          vertical-align: middle !important;
        }
        .more-dots-btn {
          display: inline-flex !important;
          align-items: center !important;
          justify-content: center !important;
          margin-left: 6px !important;
          padding: 0 4px !important;
          background: #F3F4F6 !important;
          color: #4B5563 !important;
          border: 1px solid #E5E5E5 !important;
          border-radius: 4px !important;
          font-size: 13px !important;
          font-weight: 800 !important;
          line-height: 18px !important;
          height: 18px !important;
          min-width: 14px !important;
          cursor: pointer !important;
          vertical-align: middle !important;
          transition: background 0.15s, color 0.15s, border-color 0.15s !important;
          user-select: none !important;
        }
        .more-dots-btn:hover {
          background: #E5E7EB !important;
          color: #111827 !important;
          border-color: #D1D5DB !important;
        }
        .answer-explanation {
          display: block !important;
          margin-top: 6px !important;
          padding-top: 5px !important;
          border-top: 1px solid #E5E5E5 !important;
          font-size: 11.5px !important;
          font-weight: 500 !important;
          color: #4B5563 !important;
          line-height: 1.4 !important;
          white-space: pre-wrap !important;
          word-break: break-word !important;
          cursor: text !important;
          user-select: text !important;
        }
      `;
      shadow.appendChild(style);

      const box = document.createElement('div');
      box.className = 'quick-notify-box';
      box.id = 'notify-box';
      box.title = 'Click to dismiss';
      box.addEventListener('click', (e) => {
        if (e.target && e.target.closest && e.target.closest('.more-dots-btn')) {
          return;
        }
        if (e.target && e.target.closest && e.target.closest('.answer-explanation')) {
          return;
        }
        this.hide();
      });
      shadow.appendChild(box);

      targetParent.appendChild(host);

      this.host = host;
      this.container = host;
      this.shadow = shadow;
      this.box = box;
      console.log('[Moodle AI] NOTIFICATION_HOST_CREATED:', {
        hostId: host.id,
        parentTag: targetParent.tagName,
        isTopFrame
      });
    }

    applyPositionStyles(el, pos) {
      if (!el) return;
      el.style.setProperty('position', 'fixed', 'important');
      el.style.setProperty('z-index', '2147483647', 'important');
      el.style.setProperty('pointer-events', 'none', 'important');
      el.style.setProperty('border', 'none', 'important');
      el.style.setProperty('outline', 'none', 'important');
      el.style.setProperty('background', 'transparent', 'important');
      el.style.setProperty('box-shadow', 'none', 'important');
      el.style.setProperty('margin', '0', 'important');
      el.style.setProperty('padding', '0', 'important');
      el.style.setProperty('line-height', 'normal', 'important');
      el.style.setProperty('width', 'auto', 'important');
      el.style.setProperty('height', 'auto', 'important');
      el.style.setProperty('max-width', 'min(460px, 92vw)', 'important');
      el.style.setProperty('overflow', 'visible', 'important');

      el.style.setProperty('top', 'auto', 'important');
      el.style.setProperty('bottom', 'auto', 'important');
      el.style.setProperty('left', 'auto', 'important');
      el.style.setProperty('right', 'auto', 'important');

      switch (pos) {
        case 'bottom-right':
          el.style.setProperty('bottom', '16px', 'important');
          el.style.setProperty('right', '16px', 'important');
          break;
        case 'top-left':
          el.style.setProperty('top', '16px', 'important');
          el.style.setProperty('left', '16px', 'important');
          break;
        case 'bottom-left':
          el.style.setProperty('bottom', '16px', 'important');
          el.style.setProperty('left', '16px', 'important');
          break;
        case 'top-right':
        default:
          el.style.setProperty('top', '16px', 'important');
          el.style.setProperty('right', '16px', 'important');
          break;
      }
    }

    setPosition(pos) {
      this.currentPosition = pos;
      if (this.container) {
        this.applyPositionStyles(this.container, pos);
      }
    }

    setDuration(ms) {
      this.currentDurationMs = Math.max(250, parseInt(ms, 10) || 500);
    }

    splitIntoChunks(text, targetChunkLen = 42) {
      if (!text || text.length <= targetChunkLen) return [text];
      const words = text.split(/\s+/).filter(Boolean);
      const chunks = [];
      let current = '';

      for (const word of words) {
        if (!current) {
          current = word;
        } else if ((current + ' ' + word).length <= targetChunkLen) {
          current += ' ' + word;
        } else {
          chunks.push(current);
          current = word;
        }
      }
      if (current) chunks.push(current);
      return chunks.length > 0 ? chunks : [text];
    }

    /**
     * Show compact answer notification:
     * Collapsed: [Option — Answer Text] [🦙] [⋮]
     * Expanded: Above line + [Explanation: ...]
     */
    showAnswer(payload) {
      if (!isTopFrame) {
        try {
          if (window.top && typeof window.top.postMessage === 'function') {
            window.top.postMessage({ type: 'MOODLE_SHOW_NOTIFICATION', action: 'showAnswer', payload }, '*');
            return;
          }
        } catch (_) {}
      }

      this.ensureDOM();
      this.clearTimer();

      const { option, answer, reason, explanation, isOllama, provider, source, model } = payload || {};
      let text = '';
      const hasRealOption = option && String(option).trim() && String(option).toUpperCase() !== 'UNCERTAIN';
      const hasRealAnswer = answer && String(answer).trim() && !String(answer).toUpperCase().startsWith('UNCERTAIN');

      if (hasRealOption && hasRealAnswer) {
        const optLetter = String(option).trim();
        let cleanAnswer = String(answer).trim();
        const prefixRegex = new RegExp(`^${optLetter}[\\.\\:\\)\\-]\\s*`, 'i');
        if (prefixRegex.test(cleanAnswer)) {
          cleanAnswer = cleanAnswer.replace(prefixRegex, '').trim();
        }
        text = `${optLetter} — ${cleanAnswer}`;
      } else if (hasRealAnswer) {
        text = String(answer).trim();
      } else if (hasRealOption) {
        text = String(option).trim();
      } else {
        text = 'Verified Solution Determined';
      }

      this.fullText = text;
      this.explanationText = (reason || explanation || '').trim();
      this.isOllama = Boolean(
        isOllama ||
        provider === 'ollama' ||
        source === 'ollama_fallback' ||
        (model && (String(model).includes('gemma') || String(model).includes('llama') || String(model).includes('mistral') || String(model).includes('qwen')))
      );
      this.isExpanded = false;
      this.chunks = this.splitIntoChunks(text, 42);
      this.currentChunkIndex = 0;
      this.render();
    }

    showImagePreview(dataUrl, statusText = 'Evaluating...') {
      this.showStatus(statusText || 'Evaluating...');
    }

    toggleExpanded() {
      this.isExpanded = !this.isExpanded;
      this.render();
    }

    advanceChunk() {
      this.toggleExpanded();
    }

    renderCurrentChunk() {
      this.render();
    }

    render() {
      this.clearTimer();
      this.ensureDOM();
      if (!this.box) return;
      if (this.host) {
        this.host.style.setProperty('display', 'block', 'important');
        this.applyPositionStyles(this.host, this.currentPosition);
      }

      console.log('[Moodle AI] NOTIFICATION_RENDER_CALLED:', {
        type: 'answer',
        isExpanded: this.isExpanded,
        isOllama: this.isOllama,
        textPreview: this.fullText?.slice(0, 35)
      });

      this.box.className = 'quick-notify-box visible';
      this.box.innerHTML = '';

      // 1. Answer row: compact line [Option — Answer Text] [🦙] [⋮]
      const row = document.createElement('div');
      row.className = 'answer-row';

      const answerSpan = document.createElement('span');
      answerSpan.className = 'answer-text';
      answerSpan.textContent = this.fullText;
      row.appendChild(answerSpan);

      // 2. Ollama 🦙 badge: rendered only when local Ollama provided the answer
      if (this.isOllama) {
        const badge = document.createElement('span');
        badge.className = 'ollama-badge';
        badge.textContent = '🦙';
        badge.title = 'Answered by local Ollama';
        badge.setAttribute('aria-label', 'Answered by local Ollama');
        row.appendChild(badge);
      }

      // 3. Three-dot (⋮) menu button
      const dotsBtn = document.createElement('button');
      dotsBtn.className = 'more-dots-btn menu-toggle-btn';
      dotsBtn.type = 'button';
      dotsBtn.tabIndex = -1; // Never steal keyboard navigation or Enter key from quiz form
      dotsBtn.textContent = '⋮';
      dotsBtn.title = this.isExpanded ? 'Click to collapse explanation' : 'Click to view explanation';
      dotsBtn.setAttribute('aria-label', dotsBtn.title);
      dotsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleExpanded();
      });
      row.appendChild(dotsBtn);

      this.box.appendChild(row);

      // 4. Expanded explanation block
      if (this.isExpanded) {
        const explDiv = document.createElement('div');
        explDiv.className = 'answer-explanation';
        let rawExpl = this.explanationText || 'Verified solution determined.';
        if (!/^explanation\s*:/i.test(rawExpl)) {
          rawExpl = `Explanation: ${rawExpl}`;
        }
        explDiv.textContent = rawExpl;
        this.box.appendChild(explDiv);

        this.box.title = 'Click outside to dismiss';
        this.timerId = setTimeout(() => {
          this.hide();
        }, Math.max(25000, this.currentDurationMs));
      } else {
        this.box.title = 'Click to dismiss';
        this.timerId = setTimeout(() => {
          this.hide();
        }, Math.max(4000, this.currentDurationMs));
      }

      console.log('[Moodle AI] NOTIFICATION_VISIBLE:', {
        hostDisplay: this.host?.style?.display,
        boxClass: this.box?.className,
        text: this.box?.textContent?.slice(0, 40)
      });
    }

    showStatus(msg) {
      if (!isTopFrame) {
        try {
          if (window.top && typeof window.top.postMessage === 'function') {
            window.top.postMessage({ type: 'MOODLE_SHOW_NOTIFICATION', action: 'showStatus', payload: msg }, '*');
            return;
          }
        } catch (_) {}
      }

      this.ensureDOM();
      this.clearTimer();

      if (this.host) {
        this.host.style.setProperty('display', 'block', 'important');
        this.applyPositionStyles(this.host, this.currentPosition);
      }
      if (this.box) {
        this.box.className = 'quick-notify-box visible status';
        this.box.title = 'Processing question';

        const isSolving = !msg || /solving|quick\s*ai/i.test(msg) || msg === '•' || msg === '•••';
        if (isSolving) {
          this.box.innerHTML = '<span class="loading-dot" aria-label="Loading">•</span>';
        } else {
          this.box.textContent = msg;
        }

        this.timerId = setTimeout(() => this.hide(), 45000);
      }

      console.log('[Moodle AI] NOTIFICATION_RENDER_CALLED:', { type: 'status', msg });
      console.log('[Moodle AI] NOTIFICATION_VISIBLE:', {
        hostDisplay: this.host?.style?.display,
        boxClass: this.box?.className,
        text: this.box?.textContent
      });
    }

    formatErrorMessage(raw) {
      if (!raw || typeof raw !== 'string') return 'Could not solve question';
      let text = raw.trim();
      if (text.includes('Extension context invalidated') || text.includes('context invalidated')) {
        return 'Please refresh this page (Cmd+R or F5)';
      }
      if (text.includes('403')) {
        return 'Ollama 403: Click Reload in chrome://extensions';
      }
      if (text.includes('Failed to fetch') || text.includes('ECONNREFUSED')) {
        return 'Local backend or Ollama is offline. Launch Ollama app.';
      }
      if (text.includes('No local Ollama model') || text.includes('not installed in Ollama')) {
        return 'No Ollama model chosen. Select a model in Settings.';
      }
      if (text.includes('{') && text.includes('}')) {
        try {
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed?.error?.message) {
              return `Error: ${parsed.error.message}`;
            }
            if (parsed?.message) {
              return `Error: ${parsed.message}`;
            }
          }
        } catch (_) {}
      }
      return text;
    }

    showError(msg) {
      if (!isTopFrame) {
        try {
          if (window.top && typeof window.top.postMessage === 'function') {
            window.top.postMessage({ type: 'MOODLE_SHOW_NOTIFICATION', action: 'showError', payload: msg }, '*');
            return;
          }
        } catch (_) {}
      }

      this.ensureDOM();
      this.clearTimer();

      if (this.host) {
        this.host.style.setProperty('display', 'block', 'important');
        this.applyPositionStyles(this.host, this.currentPosition);
      }
      if (this.box) {
        this.box.className = 'quick-notify-box visible error';
        this.box.textContent = this.formatErrorMessage(msg);
        this.box.title = 'Click to dismiss';

        this.timerId = setTimeout(() => {
          this.hide();
        }, Math.max(5000, this.currentDurationMs));
      }

      console.log('[Moodle AI] NOTIFICATION_RENDER_CALLED:', { type: 'error', msg });
      console.log('[Moodle AI] NOTIFICATION_VISIBLE:', {
        hostDisplay: this.host?.style?.display,
        boxClass: this.box?.className,
        text: this.box?.textContent
      });
    }

    hide() {
      this.clearTimer();
      if (this.box) {
        this.box.className = 'quick-notify-box';
        this.box.textContent = '';
      }
      if (this.host) {
        this.host.style.setProperty('display', 'none', 'important');
      }
    }

    clearTimer() {
      if (this.timerId) {
        clearTimeout(this.timerId);
        this.timerId = null;
      }
    }
  }

  window.MoodleQuickNotification = QuickNotification;
  window.MoodleQuickNotificationManager = QuickNotification;
})();
