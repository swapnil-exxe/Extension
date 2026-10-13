/**
 * Moodle AI Quick Answer - Temporary Answer Notification
 * Renders a tiny, high-contrast corner notification that automatically disappears.
 */

(function () {
  'use strict';

  if (window.MoodleQuickNotification) return;

  class QuickNotification {
    constructor() {
      this.container = null;
      this.timerId = null;
      this.currentDurationMs = 2000; // 2 seconds default for comfortable readability
      this.currentPosition = 'top-right';

      this.init();
    }

    async init() {
      try {
        const settings = await chrome.storage.local.get(['notificationPosition', 'notificationDuration']);
        if (settings.notificationPosition) {
          this.currentPosition = settings.notificationPosition;
        }
        if (settings.notificationDuration !== undefined) {
          this.currentDurationMs = parseInt(settings.notificationDuration, 10) || 2000;
        }
      } catch (err) {}

      this.createDOM();
    }

    createDOM() {
      if (this.container && document.body && document.body.contains(this.container)) {
        return;
      }

      const host = document.createElement('div');
      host.id = 'moodle-quick-notify-host';
      host.style.position = 'fixed';
      host.style.zIndex = '2147483647';
      host.style.pointerEvents = 'none';
      this.applyPositionStyles(host, this.currentPosition);

      // Shadow DOM for complete CSS isolation
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = `
        :host {
          all: initial;
        }
        .quick-notify-box {
          display: none;
          background: #09090b;
          color: #f4f4f5;
          border: 1px solid rgba(255, 255, 255, 0.2);
          box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
          border-radius: 8px;
          padding: 8px 16px;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          font-size: 14px;
          font-weight: 700;
          letter-spacing: 0.3px;
          line-height: 1.4;
          white-space: pre-wrap;
          max-width: 480px;
          pointer-events: auto;
          cursor: pointer;
          user-select: none;
          transition: all 0.15s ease;
        }
        .more-dots-btn {
          display: inline-block;
          margin-left: 6px;
          padding: 1px 7px;
          background: #27272a;
          color: #38bdf8;
          border: 1px solid rgba(56, 189, 248, 0.4);
          border-radius: 4px;
          font-size: 13px;
          font-weight: 800;
          letter-spacing: 1px;
          cursor: pointer;
          vertical-align: baseline;
          transition: background 0.15s, color 0.15s;
        }
        .more-dots-btn:hover {
          background: #38bdf8;
          color: #09090b;
        }
        .quick-notify-box.visible {
          display: inline-block;
        }
        .quick-notify-box.status {
          background: #18181b;
          color: #a1a1aa;
          font-weight: 500;
          font-size: 13px;
        }
        .quick-notify-box.error {
          background: #450a0a;
          color: #fecaca;
          border-color: #991b1b;
          font-weight: 600;
          font-size: 13px;
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
      }
      this.container = host;
      this.shadow = shadow;
      this.box = box;
    }

    applyPositionStyles(el, pos) {
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
      this.currentDurationMs = Math.max(500, parseInt(ms, 10) || 2000);
    }

    /**
     * Split long answer text into word-boundary chunks
     */
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
    showAnswer({ option, answer }) {
      this.createDOM();
      this.clearTimer();

      let text = '';
      if (option && option.trim() && answer && answer.trim()) {
        text = `${option.trim()} — ${answer.trim()}`;
      } else if (answer && answer.trim()) {
        text = answer.trim();
      } else if (option && option.trim()) {
        text = option.trim();
      } else {
        text = 'No answer found';
      }

      this.fullText = text;
      this.chunks = this.splitIntoChunks(text, 42);
      this.currentChunkIndex = 0;
      this.renderCurrentChunk();
    }

    /**
     * Render the current chunk with clickable 3-dot expansion if more content remains
     */
    renderCurrentChunk() {
      this.clearTimer();
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

      // Display accumulated text up to current chunk
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

        // 4.5 seconds per chunk so user can comfortably tap '···'
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

    /**
     * Advance to the next chunk of answer text
     */
    advanceChunk() {
      if (this.chunks && this.currentChunkIndex < this.chunks.length - 1) {
        this.currentChunkIndex++;
        this.renderCurrentChunk();
      } else {
        this.hide();
      }
    }

    /**
     * Show subtle status notification while processing
     */
    showStatus(msg) {
      this.createDOM();
      this.clearTimer();

      this.box.className = 'quick-notify-box visible status';
      this.box.textContent = msg || 'Analyzing...';
    }

    /**
     * Show error notification
     */
    showError(msg) {
      this.createDOM();
      this.clearTimer();

      this.box.className = 'quick-notify-box visible error';
      this.box.textContent = msg || 'Could not detect question';

      this.timerId = setTimeout(() => {
        this.hide();
      }, Math.max(2500, this.currentDurationMs));
    }

    hide() {
      this.clearTimer();
      if (this.box) {
        this.box.className = 'quick-notify-box';
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
})();
