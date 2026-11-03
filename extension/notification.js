/**
 * Moodle AI Quick Answer - Centralized Notification Manager
 * Enforces a single active notification on screen. Never stacks or overlaps.
 */

(function () {
  'use strict';

  if (window.MoodleQuickNotificationManager) {
    window.MoodleQuickNotification = window.MoodleQuickNotificationManager;
    return;
  }

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

      this.init();

      // In top frame: listen for cross-frame notification requests
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
        this.createDOM();
      }
    }

    createDOM() {
      // In child frames, we do NOT inject DOM into the child frame body.
      // We delegate to window.top so that only ONE notification element exists on the page.
      if (!isTopFrame) return;

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
        if (this.box) return;
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
        line-height: 0 !important;
        font-size: 0 !important;
        width: auto !important;
        height: auto !important;
        overflow: visible !important;
      `;
      this.applyPositionStyles(host, this.currentPosition);

      // Shadow DOM for complete CSS isolation
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = `
        :host {
          all: initial !important;
          display: block !important;
          border: none !important;
          outline: none !important;
          background: transparent !important;
          box-shadow: none !important;
          margin: 0 !important;
          padding: 0 !important;
        }
        .quick-notify-box {
          display: none;
          background: #FFFFFF;
          color: #000000;
          border: 1px solid #E5E5E5;
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.08);
          border-radius: 6px;
          padding: 6px 12px;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          font-size: 13px;
          font-weight: 700;
          letter-spacing: 0.2px;
          line-height: 1.35;
          white-space: pre-wrap;
          max-width: min(460px, 92vw);
          box-sizing: border-box;
          pointer-events: auto;
          cursor: pointer;
          user-select: none;
          transition: opacity 0.15s ease, transform 0.15s ease;
        }
        .quick-notify-box.visible {
          display: inline-block;
        }
        .quick-notify-box.status {
          background: #FFFFFF;
          color: #555555;
          border: 1px solid #E5E5E5;
          font-weight: 500;
          font-size: 12px;
        }
        .quick-notify-box.error {
          background: #FFFFFF;
          color: #991B1B;
          border: 1px solid #E5E5E5;
          font-weight: 600;
          font-size: 12px;
        }
        .more-dots-btn {
          display: inline-block;
          margin-left: 6px;
          padding: 1px 6px;
          background: #F5F5F5;
          color: #000000;
          border: 1px solid #E5E5E5;
          border-radius: 4px;
          font-size: 12px;
          font-weight: 800;
          letter-spacing: 1px;
          cursor: pointer;
          vertical-align: baseline;
          transition: background 0.15s, color 0.15s;
        }
        .more-dots-btn:hover {
          background: #E5E5E5;
          color: #000000;
        }
        @media (prefers-color-scheme: dark) {
          .quick-notify-box {
            background: #1E1E1E !important;
            color: #F9FAFB !important;
            border-color: #374151 !important;
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45) !important;
          }
          .quick-notify-box.status {
            background: #1E1E1E !important;
            color: #9CA3AF !important;
            border-color: #374151 !important;
          }
          .quick-notify-box.error {
            background: #1E1E1E !important;
            color: #F87171 !important;
            border-color: #7F1D1D !important;
          }
          .more-dots-btn {
            background: #2D3748 !important;
            color: #F9FAFB !important;
            border-color: #4B5563 !important;
          }
        }
      `;
      shadow.appendChild(style);

      const box = document.createElement('div');
      box.className = 'quick-notify-box';
      box.id = 'notify-box';
      box.title = 'Click to dismiss';
      box.addEventListener('click', () => {
        if (this.chunks && this.currentChunkIndex < this.chunks.length - 1) {
          this.advanceChunk();
        } else {
          this.hide();
        }
      });
      shadow.appendChild(box);

      if (document.body) {
        document.body.appendChild(host);
      } else if (document.documentElement) {
        document.documentElement.appendChild(host);
      }

      this.host = host;
      this.container = host;
      this.shadow = shadow;
      this.box = box;
    }

    applyPositionStyles(el, pos) {
      if (!el) return;
      el.style.top = 'auto';
      el.style.bottom = 'auto';
      el.style.left = 'auto';
      el.style.right = 'auto';

      switch (pos) {
        case 'bottom-right':
          el.style.bottom = '16px';
          el.style.right = '16px';
          break;
        case 'top-left':
          el.style.top = '16px';
          el.style.left = '16px';
          break;
        case 'bottom-left':
          el.style.bottom = '16px';
          el.style.left = '16px';
          break;
        case 'top-right':
        default:
          el.style.top = '16px';
          el.style.right = '16px';
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
     * Show answer notification with progressive 3-dot chunk expansion
     */
    showAnswer(payload) {
      if (!isTopFrame) {
        try {
          window.top.postMessage({ type: 'MOODLE_SHOW_NOTIFICATION', action: 'showAnswer', payload }, '*');
          return;
        } catch (_) {}
      }

      this.createDOM();
      this.clearTimer();

      const { option, answer } = payload || {};
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
      this.chunks = this.splitIntoChunks(text, 42);
      this.currentChunkIndex = 0;
      this.renderCurrentChunk();
    }

    showImagePreview(dataUrl, statusText = 'Evaluating...') {
      this.showStatus(statusText || 'Evaluating...');
    }

    renderCurrentChunk() {
      this.clearTimer();
      if (!this.box) return;
      if (this.host) this.host.style.setProperty('display', 'block', 'important');

      this.box.className = 'quick-notify-box visible';
      this.box.innerHTML = '';

      if (!this.chunks || this.chunks.length <= 1) {
        this.box.textContent = this.fullText;
        this.box.title = 'Click to dismiss';
        this.timerId = setTimeout(() => {
          this.hide();
        }, this.currentDurationMs);
        return;
      }

      const displayed = this.chunks.slice(0, this.currentChunkIndex + 1).join(' ');
      const textSpan = document.createElement('span');
      textSpan.textContent = displayed;
      this.box.appendChild(textSpan);

      const hasMore = this.currentChunkIndex < this.chunks.length - 1;
      if (hasMore) {
        const dots = document.createElement('span');
        dots.className = 'more-dots-btn';
        dots.textContent = '···';
        dots.title = `Click to show more (${this.currentChunkIndex + 1}/${this.chunks.length})`;
        dots.addEventListener('click', (e) => {
          e.stopPropagation();
          this.advanceChunk();
        });
        this.box.appendChild(dots);
        this.box.title = 'Click to show more';

        this.timerId = setTimeout(() => {
          this.hide();
        }, 4500);
      } else {
        this.box.title = 'Click to dismiss';
        this.timerId = setTimeout(() => {
          this.hide();
        }, this.currentDurationMs + 1000);
      }
    }

    advanceChunk() {
      if (this.chunks && this.currentChunkIndex < this.chunks.length - 1) {
        this.currentChunkIndex++;
        this.renderCurrentChunk();
      } else {
        this.hide();
      }
    }

    showStatus(msg) {
      if (!isTopFrame) {
        try {
          window.top.postMessage({ type: 'MOODLE_SHOW_NOTIFICATION', action: 'showStatus', payload: msg }, '*');
          return;
        } catch (_) {}
      }

      this.createDOM();
      this.clearTimer();

      if (this.host) this.host.style.setProperty('display', 'block', 'important');
      if (this.box) {
        this.box.className = 'quick-notify-box visible status';
        this.box.textContent = msg || 'Analyzing...';
        this.box.title = 'Processing question';
        this.timerId = setTimeout(() => this.hide(), 3500);
      }
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
        return 'Ollama is offline. Please launch the Ollama app.';
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
          window.top.postMessage({ type: 'MOODLE_SHOW_NOTIFICATION', action: 'showError', payload: msg }, '*');
          return;
        } catch (_) {}
      }

      this.createDOM();
      this.clearTimer();

      if (this.host) this.host.style.setProperty('display', 'block', 'important');
      if (this.box) {
        this.box.className = 'quick-notify-box visible error';
        this.box.textContent = this.formatErrorMessage(msg);
        this.box.title = 'Click to dismiss';

        this.timerId = setTimeout(() => {
          this.hide();
        }, Math.max(2500, this.currentDurationMs));
      }
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
