/**
 * Moodle AI Quick Answer - Dedicated Content Script Adapter
 * Supports text selection, standard Moodle (3.x, 4.x), custom web quizzes, and vision screenshot fallback.
 * Intercepts Shift+Z, Shift+X, and Shift+A shortcuts with zero visual interference.
 */

(function () {
  'use strict';

  if (window.__moodleQuickAIInitialized) return;
  window.__moodleQuickAIInitialized = true;

  // In-memory state
  let notification = null;
  let elementUnderMouse = null;
  let activeQuestionElement = null;
  let lastAnswer = null; // Temporary in-memory storage for Shift+A
  let isExtensionEnabled = true;

  /**
   * Initialize content script adapter
   */
  async function init() {
    if (window.MoodleQuickNotification) {
      notification = new window.MoodleQuickNotification();
    }

    try {
      const settings = await chrome.storage.local.get(['enabled', 'notificationPosition', 'notificationDuration']);
      isExtensionEnabled = settings.enabled !== false;
      if (notification && settings.notificationPosition) {
        notification.setPosition(settings.notificationPosition);
      }
      if (notification && settings.notificationDuration) {
        notification.setDuration(settings.notificationDuration);
      }
    } catch (err) {}

    attachMouseAndFocusTracking();
    attachKeyboardShortcuts();
    attachMessageListener();

    console.log('[Moodle Quick AI] Ready. Shortcuts: Shift+Z, Shift+X, Shift+A.');
  }

  /**
   * Track mouse position and focus to detect active question under cursor
   */
  function attachMouseAndFocusTracking() {
    document.addEventListener('mousemove', (e) => {
      elementUnderMouse = e.target;
    }, { passive: true });

    document.addEventListener('mouseover', (e) => {
      elementUnderMouse = e.target;
    }, { passive: true });

    document.addEventListener('focusin', (e) => {
      const container = findQuestionContainerFromElement(e.target);
      if (container) activeQuestionElement = container;
    }, true);

    document.addEventListener('click', (e) => {
      const container = findQuestionContainerFromElement(e.target);
      if (container) activeQuestionElement = container;
    }, true);
  }

  /**
   * Extract question and options directly from user's highlighted text selection ONLY
   */
  function extractFromSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return null;

    const rawText = selection.toString().trim();
    if (!rawText || rawText.length < 2) return null;

    // Send strictly what the user selected with their mouse!
    // Check if selected text contains option lines
    function isOptionLine(line) {
      return /^(?:[A-Za-z][\.\:\)\-]|(?:\([A-Za-z0-9]\))|(?:\[[A-Za-z0-9]\])|\d+[\.\:\)\-])\s+/i.test(line) ||
             /^(?:True|False)$/i.test(line);
    }

    // Case A: User selected BOTH question and options lines
    if (lines.length >= 2) {
      const firstOptIndex = lines.findIndex((l, i) => i > 0 && isOptionLine(l));
      if (firstOptIndex > 0) {
        const questionText = lines.slice(0, firstOptIndex).join(' ');
        const optionLines = lines.slice(firstOptIndex);
        const options = optionLines.map((optText, idx) => {
          let text = optText;
          const letterMatch = optText.match(/^([A-Za-z])[\.\:\)\-]\s*(.*)$/);
          if (letterMatch) {
            text = `${letterMatch[1].toUpperCase()}. ${letterMatch[2]}`;
          } else {
            const letter = String.fromCharCode(65 + idx);
            text = `${letter}. ${optText}`;
          }
          return {
            id: `opt_${idx}`,
            text
          };
        });

        return {
          platform: 'moodle',
          questionNumber: (questionText.match(/^\d+/) || ['1'])[0],
          questionType: 'single_choice',
          question: questionText,
          options
        };
      }
    }

    // Case B: User selected only the question text
    // Check if the enclosing question container on the page contains options!
    let pageOptions = [];
    try {
      const anchorEl = selection.anchorNode
        ? (selection.anchorNode.nodeType === Node.ELEMENT_NODE ? selection.anchorNode : selection.anchorNode.parentElement)
        : null;
      const container = findQuestionContainerFromElement(anchorEl) || activeQuestionElement;
      if (container) {
        const extracted = extractQuestionData(container);
        if (extracted && extracted.options && extracted.options.length >= 2) {
          pageOptions = extracted.options;
        }
      }
    } catch (e) {}

    return {
      platform: 'moodle',
      questionNumber: (rawText.match(/^\d+/) || ['1'])[0],
      questionType: pageOptions.length > 0 ? 'single_choice' : 'short_answer',
      question: rawText,
      options: pageOptions
    };
  }


  /**
   * Find lowest common ancestor element for a list of nodes
   */
  function findLowestCommonAncestor(elements) {
    if (!elements || elements.length === 0) return null;
    if (elements.length === 1) return elements[0].parentElement;

    let ancestors = [];
    let curr = elements[0].parentElement;
    while (curr && curr !== document.body) {
      ancestors.push(curr);
      curr = curr.parentElement;
    }

    for (const anc of ancestors) {
      const containsAll = elements.every(el => anc.contains(el));
      if (containsAll) return anc;
    }

    return elements[0].parentElement || document.body;
  }

  /**
   * Find question container from any element (input, label, heading, or card)
   */
  function findQuestionContainerFromElement(el) {
    if (!el || el === document.body || el === document.documentElement) return null;

    // 1. Standard Moodle & LMS container match
    const moodleQue = el.closest('.que, [data-question-id], .formulation, .question, [class*="question-container"], [class*="quiz-question"], [class*="quiz-card"], [class*="question-card"], [class*="Question"]');
    if (moodleQue) return moodleQue.closest('.que') || moodleQue;

    // 2. Climb up parent chain looking for any container containing options
    let curr = el;
    let bestContainer = null;
    let depth = 0;

    while (curr && curr !== document.body && depth < 8) {
      depth++;
      const inputs = curr.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]');
      if (inputs.length >= 2 && inputs.length <= 25) {
        bestContainer = curr;
        const hasPrompt = curr.querySelector('h1, h2, h3, h4, h5, h6, [class*="title"], [class*="prompt"], [class*="text"], p, legend');
        if (hasPrompt) {
          return curr;
        }
      }

      const className = typeof curr.className === 'string' ? curr.className : '';
      if (/card|box|item|block|form-group|fieldset/i.test(className) && inputs.length >= 1) {
        return curr;
      }

      curr = curr.parentElement;
    }

    if (bestContainer) return bestContainer;

    // 3. Check siblings or parent's siblings if el was a heading
    if (el.parentElement) {
      const parentInputs = el.parentElement.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"]');
      if (parentInputs.length >= 2) return el.parentElement;

      if (el.parentElement.parentElement) {
        const gpInputs = el.parentElement.parentElement.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"]');
        if (gpInputs.length >= 2 && gpInputs.length <= 25) return el.parentElement.parentElement;
      }
    }

    return el.closest('fieldset, form > div, li') || null;
  }

  /**
   * Get all question containers on the page
   */
  function getQuestionContainers() {
    let list = Array.from(document.querySelectorAll('.que'));
    if (list.length > 0) return list;

    list = Array.from(document.querySelectorAll('[data-question-id], .question-container, .formulation, [class*="quiz-question"], [class*="question-card"], fieldset, .quiz-card'));
    if (list.length > 0) {
      return Array.from(new Set(list.map(el => el.closest('.que') || el)));
    }

    // Dynamic grouping by radio inputs
    const radios = Array.from(document.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"]'));
    const nameGroups = new Map();
    for (const r of radios) {
      const name = r.name || r.getAttribute('name') || 'group_default';
      if (!nameGroups.has(name)) nameGroups.set(name, []);
      nameGroups.get(name).push(r);
    }

    const containers = [];
    for (const group of nameGroups.values()) {
      if (group.length >= 2) {
        let container = findLowestCommonAncestor(group);
        if (container) {
          if (container.parentElement && container.parentElement !== document.body) {
            const hasHeading = container.parentElement.querySelector('h1, h2, h3, h4, h5, h6, [class*="title"], p');
            if (hasHeading) container = container.parentElement;
          }
          containers.push(container);
        }
      }
    }

    if (containers.length > 0) {
      return Array.from(new Set(containers));
    }

    // Fallback: Check elements with numbers like "1. ", "8. "
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6, p, div')).filter(el => {
      const text = el.textContent.trim();
      return /^\d+[\.\:\)]\s+\S+/.test(text) && text.length < 300 && el.children.length < 3;
    });

    const headingContainers = headings.map(h => findQuestionContainerFromElement(h) || h.parentElement).filter(Boolean);
    return Array.from(new Set(headingContainers));
  }

  /**
   * Determine target question (selected text, under cursor, focused, or visible in viewport)
   */
  function getTargetQuestionElement() {
    // 1. Check user text selection anchor
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.anchorNode) {
      const anchorEl = selection.anchorNode.nodeType === Node.ELEMENT_NODE
        ? selection.anchorNode
        : selection.anchorNode.parentElement;
      const q = findQuestionContainerFromElement(anchorEl);
      if (q) return q;
    }

    // 2. Check under cursor
    if (elementUnderMouse) {
      const q = findQuestionContainerFromElement(elementUnderMouse);
      if (q) return q;
    }

    // 3. Check focused / clicked question
    if (activeQuestionElement && document.body.contains(activeQuestionElement)) {
      return activeQuestionElement;
    }

    // 4. Check viewport center
    const questions = getQuestionContainers();
    if (questions.length === 0) return null;

    const viewportCenter = window.innerHeight / 2;
    let closest = null;
    let minDistance = Infinity;

    for (const q of questions) {
      const rect = q.getBoundingClientRect();
      if (rect.bottom > 30 && rect.top < window.innerHeight - 30) {
        const dist = Math.abs(rect.top + rect.height / 2 - viewportCenter);
        if (dist < minDistance) {
          minDistance = dist;
          closest = q;
        }
      }
    }

    return closest || questions[0];
  }

  /**
   * Cleanly format text preserving math and code
   */
  function extractFormattedText(element) {
    if (!element) return '';
    const clone = element.cloneNode(true);
    clone.querySelectorAll('.outcome, .feedback, script, noscript, style').forEach(el => el.remove());

    // MathJax
    clone.querySelectorAll('script[type^="math/tex"]').forEach(script => {
      const span = document.createElement('span');
      span.textContent = ` \\(${script.textContent}\\) `;
      script.replaceWith(span);
    });

    clone.querySelectorAll('math').forEach(math => {
      const alt = math.getAttribute('alttext') || math.textContent;
      const span = document.createElement('span');
      span.textContent = ` [Math: ${alt}] `;
      math.replaceWith(span);
    });

    // KaTeX
    clone.querySelectorAll('.katex-mathml').forEach(katex => {
      katex.replaceWith(document.createTextNode(` \\(${katex.textContent}\\) `));
    });

    // Code
    clone.querySelectorAll('pre, code').forEach(codeEl => {
      const span = document.createElement('span');
      span.textContent = `\n\`\`\`\n${codeEl.textContent}\n\`\`\`\n`;
      codeEl.replaceWith(span);
    });

    // Tables
    clone.querySelectorAll('table').forEach(table => {
      let tableText = '\n';
      table.querySelectorAll('tr').forEach(tr => {
        const cells = Array.from(tr.querySelectorAll('th, td')).map(c => c.textContent.trim());
        tableText += `| ${cells.join(' | ')} |\n`;
      });
      table.replaceWith(document.createTextNode(tableText));
    });

    return (clone.innerText || clone.textContent || '')
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * Extract question text and options universally
   */
  function extractQuestionData(questionEl) {
    if (!questionEl) return null;

    // 1. Question Text
    let questionText = '';
    const qtextElem = questionEl.querySelector('.qtext') ||
                      questionEl.querySelector('.formulation .qtext') ||
                      questionEl.querySelector('.formulation') ||
                      questionEl.querySelector('.q-title, h1, h2, h3, h4, h5, h6, legend, [class*="question-text"], [class*="prompt"]');

    if (qtextElem) {
      const clone = qtextElem.cloneNode(true);
      clone.querySelectorAll('.answer, input, .prompt, .options-group').forEach(el => el.remove());
      questionText = extractFormattedText(clone);
    }

    if (!questionText || questionText.length < 3) {
      const allText = extractFormattedText(questionEl);
      const lines = allText.split('\n').map(l => l.trim()).filter(Boolean);
      const firstOptIdx = lines.findIndex(l => /^(?:[A-Za-z][\.\:\)\-]|(?:\([A-Za-z0-9]\))|\d+[\.\:\)\-])\s+/i.test(l));
      if (firstOptIdx > 0) {
        questionText = lines.slice(0, firstOptIdx).join(' ');
      } else {
        const qLine = lines.find(l => /^\d+[\.\:\)]/.test(l) || l.endsWith('?')) || lines[0] || '';
        questionText = qLine;
      }
    }


    const noElem = questionEl.querySelector('.info .no');
    const questionNumber = noElem ? noElem.textContent.replace(/[^\d]/g, '') : (questionEl.id || '').replace(/[^\d]/g, '') || '1';

    // 2. Options
    const options = [];
    let inputs = Array.from(questionEl.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]'));

    // If no standard inputs found, detect custom option items / labels / list items
    if (inputs.length === 0) {
      const candidates = Array.from(questionEl.querySelectorAll('label, [class*="option"], [class*="choice"], [class*="answer"], [class*="item"], li')).filter(el => {
        if (el.matches('h1, h2, h3, h4, h5, h6, legend, [class*="title"], [class*="prompt"]')) return false;
        if (el.closest('h1, h2, h3, h4, h5, h6, legend, [class*="title"], [class*="prompt"]')) return false;
        const text = el.textContent.trim();
        return text.length > 0 && text.length < 250;
      });
      const filtered = candidates.filter(item => !candidates.some(other => other !== item && item.contains(other)));
      if (filtered.length >= 2) {
        inputs = filtered;
      }
    }

    inputs.forEach((input, idx) => {
      let text = '';

      if (input.tagName !== 'INPUT') {
        text = extractFormattedText(input);
      } else {
        if (input.id) {
          const label = questionEl.querySelector(`label[for="${CSS.escape(input.id)}"]`) ||
                        document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
          if (label) text = extractFormattedText(label);
        }

        if (!text && input.closest('label')) {
          const labelClone = input.closest('label').cloneNode(true);
          labelClone.querySelectorAll('input').forEach(i => i.remove());
          text = extractFormattedText(labelClone);
        }

        if (!text && input.parentElement) {
          const parentClone = input.parentElement.cloneNode(true);
          parentClone.querySelectorAll('input').forEach(i => i.remove());
          text = extractFormattedText(parentClone);
        }

        if (!text && input.nextSibling) {
          text = (input.nextSibling.textContent || '').trim();
        }
      }

      text = text.trim();
      if (!text) {
        text = `Option ${idx + 1}`;
      }

      let formattedText = text;
      if (/^(true|false)$/i.test(text)) {
        formattedText = text[0].toUpperCase() + text.slice(1).toLowerCase();
      } else {
        const letterIndex = String.fromCharCode(65 + idx);
        const letterMatch = text.match(/^([A-Za-z])[\.\:\)\-]\s*(.*)$/);
        if (letterMatch) {
          formattedText = `${letterMatch[1].toUpperCase()}. ${letterMatch[2]}`;
        } else {
          formattedText = `${letterIndex}. ${text}`;
        }
      }

      options.push({
        id: input.id || input.value || `opt_${idx}`,
        text: formattedText
      });
    });

    const hasCheckboxes = questionEl.querySelectorAll('input[type="checkbox"], [role="checkbox"]').length > 0;
    const isTrueFalse = options.length === 2 && options.some(o => /true/i.test(o.text)) && options.some(o => /false/i.test(o.text));

    let questionType = 'single_choice';
    if (isTrueFalse || questionEl.classList.contains('truefalse')) {
      questionType = 'true_false';
    } else if (hasCheckboxes) {
      questionType = 'multiple_choice';
    } else if (options.length === 0) {
      if (questionEl.classList.contains('numerical') || questionEl.querySelector('.numerical') || /calculate|sum|\bmath\b|\d+\s*[\+\-\*\/]\s*\d+/i.test(questionText)) {
        questionType = 'numerical';
      } else {
        questionType = 'short_answer';
      }
    }

    return {
      platform: 'moodle',
      questionNumber,
      questionType,
      question: questionText || 'Answer the following question',
      options
    };
  }

  /**
   * Execute Shortcut 1: Shift + Z — Solve Current Question
   */
  async function solveCurrentQuestion() {
    if (!isExtensionEnabled) return;

    if (notification) notification.showStatus('Analyzing question...');

    // 1. Check user text selection first (e.g. highlighted text)
    let data = extractFromSelection();

    // 2. If no text selection, check question container under cursor/focus
    if (!data) {
      const questionEl = getTargetQuestionElement();
      if (questionEl) {
        data = extractQuestionData(questionEl);
      }
    }

    // 3. If text extraction is still missing question text, auto-fallback to Vision Screenshot
    if (!data || !data.question || data.question.trim().length === 0) {
      console.log('[Moodle AI] Question text not found, auto-falling back to Vision Screenshot...');
      return solveQuestionScreenshot();
    }

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'ANALYZE_QUESTION',
        payload: {
          platform: 'moodle',
          questionType: data.questionType || 'single_choice',
          question: data.question,
          options: data.options || []
        }
      });

      if (!response || !response.success || !response.data) {
        throw new Error(response ? response.error : 'No response from backend');
      }

      const res = response.data;
      lastAnswer = {
        option: res.option || '',
        answer: res.answer || ''
      };

      if (notification) {
        notification.showAnswer(lastAnswer);
      }
    } catch (err) {
      console.warn('[Moodle AI] Text solve error, falling back to Vision Screenshot:', err.message);
      // Fallback to vision screenshot
      solveQuestionScreenshot(data ? data.question : '', false);
    }
  }

  /**
   * Execute Shortcut 2: Shift + X — Solve Question Using a Screenshot (Vision)
   * With visual on-screen snipping tool so the user selects the exact region!
   */
  async function solveQuestionScreenshot(prefilledQuestion = '', isInteractive = false) {
    if (!isExtensionEnabled) return;

    let cropRect = null;
    let partialText = prefilledQuestion || '';

    // If triggered interactively by Shift+X, open the interactive snipping selector
    if (isInteractive && window.MoodleScreenshotHandler && typeof window.MoodleScreenshotHandler.promptUserSelectionArea === 'function') {
      cropRect = await window.MoodleScreenshotHandler.promptUserSelectionArea();
      if (!cropRect) {
        console.log('[Moodle AI] Screenshot selection cancelled.');
        return;
      }
    } else {
      const questionEl = getTargetQuestionElement();
      if (questionEl && window.MoodleScreenshotHandler) {
        cropRect = window.MoodleScreenshotHandler.getQuestionCropRect(questionEl);
        if (!partialText) {
          const data = extractQuestionData(questionEl);
          if (data) partialText = data.question;
        }
      }
    }

    if (notification) notification.showStatus('Capturing screenshot...');

    try {
      const captureRes = await chrome.runtime.sendMessage({ action: 'CAPTURE_VISIBLE_TAB' });
      if (!captureRes || !captureRes.dataUrl) {
        throw new Error('Screenshot capture failed. Please make sure the tab is active.');
      }

      let finalImageUrl = captureRes.dataUrl;
      if (cropRect && window.MoodleScreenshotHandler) {
        finalImageUrl = await window.MoodleScreenshotHandler.cropImage(captureRes.dataUrl, cropRect);
      }

      if (notification) notification.showStatus('Evaluating with Vision AI...');

      const response = await chrome.runtime.sendMessage({
        action: 'ANALYZE_QUESTION',
        payload: {
          platform: 'moodle',
          questionType: 'vision',
          question: partialText || 'Identify the question shown in the selected area and determine the best answer.',
          image: finalImageUrl
        }
      });

      if (!response || !response.success || !response.data) {
        throw new Error(response ? response.error : 'No vision response from backend');
      }

      const res = response.data;
      lastAnswer = {
        option: res.option || '',
        answer: res.answer || ''
      };

      if (notification) {
        notification.showAnswer(lastAnswer);
      }
    } catch (err) {
      console.error('[Moodle AI] Screenshot solve error:', err.message);
      if (notification) notification.showError(err.message || 'Vision solve failed');
    }
  }

  /**
   * Execute Shortcut 3: Shift + A — Show the Last Answer Again
   */
  function showLastAnswerAgain() {
    if (!notification) return;

    if (lastAnswer && (lastAnswer.answer || lastAnswer.option)) {
      notification.showAnswer(lastAnswer);
    } else {
      notification.showError('No previous answer recorded');
    }
  }

  /**
   * Check if user is typing in a text field
   */
  function isTypingInField(target) {
    if (!target) return false;
    const tag = (target.tagName || '').toLowerCase();
    if (tag === 'textarea' || target.isContentEditable) return true;
    if (tag === 'input') {
      const type = (target.type || '').toLowerCase();
      return ['text', 'search', 'password', 'email', 'number'].includes(type);
    }
    return false;
  }

  /**
   * Attach keyboard shortcuts on window (Shift+Z, Shift+X, Shift+A)
   */
  function attachKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
      if (!e.shiftKey) return;
      if (isTypingInField(e.target)) return;

      const key = (e.key || '').toUpperCase();
      const code = (e.code || '');

      if (key === 'Z' || code === 'KeyZ') {
        e.preventDefault();
        e.stopPropagation();
        solveCurrentQuestion();
      } else if (key === 'X' || code === 'KeyX') {
        e.preventDefault();
        e.stopPropagation();
        solveQuestionScreenshot('', true);
      } else if (key === 'A' || code === 'KeyA') {
        e.preventDefault();
        e.stopPropagation();
        showLastAnswerAgain();
      }
    }, true);
  }

  /**
   * Listen for messages from background script & popup
   */
  function attachMessageListener() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === 'TRIGGER_SOLVE_QUESTION') {
        solveCurrentQuestion();
        sendResponse({ success: true });
        return true;
      }

      if (message.action === 'TRIGGER_SOLVE_SCREENSHOT') {
        solveQuestionScreenshot('', true);
        sendResponse({ success: true });
        return true;
      }

      if (message.action === 'TRIGGER_SHOW_LAST_ANSWER') {
        showLastAnswerAgain();
        sendResponse({ success: true });
        return true;
      }

      if (message.action === 'SETTINGS_UPDATED') {
        if (message.enabled !== undefined) isExtensionEnabled = message.enabled;
        if (notification && message.notificationPosition) {
          notification.setPosition(message.notificationPosition);
        }
        if (notification && message.notificationDuration) {
          notification.setDuration(message.notificationDuration);
        }
        sendResponse({ success: true });
        return true;
      }
    });
  }

  // Expose adapter methods for testing and extension consumption
  window.MoodleAdapter = {
    extractFormattedText,
    extractQuestionData,
    extractFromSelection,
    getQuestionContainers,
    solveCurrentQuestion,
    solveQuestionScreenshot,
    showLastAnswerAgain,
    getLastAnswer: () => lastAnswer
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
