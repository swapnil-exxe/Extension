/**
 * Moodle AI Quick Answer - Dedicated Content Script Adapter
 * Supports text selection, standard Moodle (3.x, 4.x), custom web quizzes, and vision screenshot fallback.
 * Intercepts Shift+Z, Shift+X, and Shift+A shortcuts with zero visual interference.
 */

(function () {
  'use strict';

  let activeKeydownListener = null;
  let activeMouseMoveListener = null;

  if (typeof window.__moodleQuickAICleanup === 'function') {
    try {
      window.__moodleQuickAICleanup();
    } catch (_) {}
  }

  window.__moodleQuickAICleanup = function () {
    try {
      if (activeKeydownListener) {
        window.removeEventListener('keydown', activeKeydownListener, true);
        activeKeydownListener = null;
      }
      if (activeMouseMoveListener) {
        document.removeEventListener('mousemove', activeMouseMoveListener, { passive: true });
        activeMouseMoveListener = null;
      }
    } catch (_) {}
  };

  function isExtensionContextValid() {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime) return false;
      // In real Chrome, reading chrome.runtime.id throws "Extension context invalidated." if context is dead
      const id = chrome.runtime.id;
      // In Node.js test mocks chrome.runtime.id may be undefined
      if (typeof id === 'undefined') {
        return typeof chrome.runtime.sendMessage === 'function';
      }
      return Boolean(id);
    } catch (_) {
      return false;
    }
  }

  // In-memory state
  let notification = null;
  let elementUnderMouse = null;
  let activeQuestionElement = null;
  let lastAnswer = null; // Temporary in-memory storage for Shift+A
  let isExtensionEnabled = true;

  // Concurrency & Debounce controls
  let activeAbortController = null;
  let lastProcessedQuestionHash = null;
  let lastSolveRequestTime = 0;
  let currentRequestId = 0;
  const DEBOUNCE_MS = 250;

  let isInitialized = false;

  function getNotification() {
    if (!notification && window.MoodleQuickNotification) {
      notification = new window.MoodleQuickNotification();
    }
    return notification;
  }

  /**
   * Initialize content script adapter
   */
  async function init() {
    if (isInitialized) return;
    isInitialized = true;
    notification = getNotification();

    // Attach listeners immediately so shortcuts work without waiting for storage I/O
    attachMouseAndFocusTracking();
    attachKeyboardShortcuts();
    attachMessageListener();

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

    console.log('[Moodle Quick AI] Ready. Shortcuts: Shift+Z, Shift+X, Shift+A.');
  }

  /**
   * Track mouse position and focus to detect active question under cursor
   */
  function attachMouseAndFocusTracking() {
    if (activeMouseMoveListener) {
      document.removeEventListener('mousemove', activeMouseMoveListener, { passive: true });
    }
    activeMouseMoveListener = (e) => {
      elementUnderMouse = e.target;
    };
    document.addEventListener('mousemove', activeMouseMoveListener, { passive: true });

    document.addEventListener('mouseover', (e) => {
      elementUnderMouse = e.target;
    }, { passive: true });

    document.addEventListener('focusin', (e) => {
      if (e.target && e.target.closest) {
        const que = e.target.closest('.que, .question, [data-question-id], [class*="question" i], [class*="quiz" i]');
        if (que) activeQuestionElement = que;
      }
    }, { passive: true });

    document.addEventListener('click', (e) => {
      if (e.target && e.target.closest) {
        const que = e.target.closest('.que, .question, [data-question-id], [class*="question" i], [class*="quiz" i]');
        if (que) activeQuestionElement = que;
      }
    }, { passive: true });
  }

  /**
   * Simple string hash for question deduplication
   */
  function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return String(hash);
  }

  /**
   * Helper to clean irrelevant Moodle UI noise (status, grade, flag, navigation)
   */
  function cleanMoodleJunk(text) {
    if (!text || typeof text !== 'string') return '';
    const lines = text.split('\n');
    const cleaned = [];
    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      // Filter out pure Moodle meta lines
      if (/^(?:Question\s*\d*[\.\:]?|Not yet answered|Marked out of\s*\d*(?:\.\d+)?|Flag question|Select one(?:\s+or\s+more)?\:?|Clear my choice|State\:.*|Grade\:.*|Points(?:\s+out\s+of)?.*|Edit question|Time left.*)$/i.test(trimmed)) {
        continue;
      }
      // Strip leading/trailing Moodle UI prefixes within text lines
      let l = trimmed
        .replace(/^Question\s*\d+[\.\:\s\-]*/i, '')
        .replace(/^Not yet answered\s*/i, '')
        .replace(/^Marked out of\s*\d+(?:\.\d+)?\s*/i, '')
        .replace(/^Flag question\s*/i, '')
        .replace(/^Select one(?:\s+or\s+more)?\:?\s*/i, '')
        .replace(/Clear my choice\s*$/i, '')
        .trim();
      if (l) cleaned.push(l);
    }
    return cleaned.join('\n');
  }

  /**
   * Extract question and options directly from user's highlighted text selection (Mode B)
   */
  function extractFromSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return null;

    const rawText = selection.toString().trim();
    if (!rawText || rawText.length < 2) return null;

    const cleanedText = cleanMoodleJunk(rawText);
    const lines = cleanedText.split('\n').map(l => l.trim()).filter(Boolean);

    // Check if selected text contains option lines
    function isOptionLine(line) {
      return /^(?:[A-Za-z][\.\:\)\-]|(?:\([A-Za-z0-9]\))|(?:\[[A-Za-z0-9]\])|\d+[\.\:\)\-])\s+/i.test(line) ||
             /^(?:True|False)$/i.test(line);
    }

    // Anchor element to locate enclosing question container on page
    let anchorEl = null;
    try {
      if (selection.anchorNode) {
        anchorEl = selection.anchorNode.nodeType === Node.ELEMENT_NODE
          ? selection.anchorNode
          : selection.anchorNode.parentElement;
      }
    } catch (_) {}

    const container = findQuestionContainerFromElement(anchorEl) || activeQuestionElement;
    let containerData = null;
    if (container) {
      try {
        containerData = extractQuestionData(container);
      } catch (_) {}
    }

    // Case 1: User selected BOTH question and options lines
    if (lines.length >= 2) {
      const firstOptIndex = lines.findIndex((l, i) => i > 0 && isOptionLine(l));
      if (firstOptIndex > 0) {
        const questionText = cleanMoodleJunk(lines.slice(0, firstOptIndex).join(' '));
        const optionLines = lines.slice(firstOptIndex);
        const options = optionLines.map((optText, idx) => {
          let text = optText;
          const letterMatch = optText.match(/^([A-Za-z0-9]+)[\.\:\)\-]\s*(.*)$/);
          const letter = letterMatch ? letterMatch[1].toUpperCase() : String.fromCharCode(65 + idx);
          if (letterMatch) {
            text = `${letter}. ${letterMatch[2].trim()}`;
          } else {
            text = `${letter}. ${optText.trim()}`;
          }
          return {
            id: letter,
            text
          };
        });

        console.log('[Moodle AI] Mode B: Both question and options selected from highlight:', { question: questionText, options: options.length });
        return {
          platform: 'moodle',
          questionNumber: (questionText.match(/^\d+/) || ['1'])[0],
          questionType: 'single_choice',
          question: questionText,
          options
        };
      }
    }

    // Case 2: User selected ONLY an option (or option label was clicked/highlighted)
    if (containerData && containerData.options && containerData.options.length >= 2) {
      const selNormalized = cleanedText.replace(/^[A-Za-z0-9]+[\.\:\)\-]\s*/, '').trim().toLowerCase();
      const matchesOption = containerData.options.some(opt => {
        const optNorm = opt.text.replace(/^[A-Za-z0-9]+[\.\:\)\-]\s*/, '').trim().toLowerCase();
        return optNorm.includes(selNormalized) || selNormalized.includes(optNorm);
      });
      const insideAnswerEl = anchorEl && Boolean(anchorEl.closest('.answer, [class*="option" i], [class*="choice" i], label, [role="radio"], [role="button"], button'));

      if ((matchesOption || insideAnswerEl) && containerData.question && containerData.question.length > 5) {
        console.log('[Moodle AI] Mode B: Highlight matched option -> Enclosing question and options associated:', {
          question: containerData.question,
          options: containerData.options.length
        });
        return {
          platform: 'moodle',
          questionNumber: containerData.questionNumber || '1',
          questionType: containerData.questionType || 'single_choice',
          question: containerData.question,
          options: containerData.options
        };
      }
    }

    // Case 3: User selected question text - find nearby options
    let pageOptions = [];
    if (containerData && containerData.options && containerData.options.length >= 2) {
      pageOptions = containerData.options;
    } else if (anchorEl) {
      // Opportunistically look for nearby options in parent / sibling elements (Google Search, web quiz cards)
      let searchRoot = anchorEl;
      let depth = 0;
      while (searchRoot && searchRoot !== document.body && depth < 12) {
        depth++;
        const foundData = extractQuestionData(searchRoot);
        if (foundData && foundData.options && foundData.options.length >= 2) {
          pageOptions = foundData.options;
          break;
        }
        searchRoot = searchRoot.parentElement;
      }

      // Check following sibling elements for an options list or option buttons
      if (pageOptions.length === 0 && anchorEl.parentElement) {
        let sibling = anchorEl.parentElement.nextElementSibling || anchorEl.nextElementSibling;
        let sCount = 0;
        while (sibling && sCount < 5) {
          sCount++;
          const sibData = extractQuestionData(sibling);
          if (sibData && sibData.options && sibData.options.length >= 2) {
            pageOptions = sibData.options;
            break;
          }
          sibling = sibling.nextElementSibling;
        }
      }
    }

    // Reject pure website boilerplate (Privacy Policy, Terms of Service, Copyright, etc.) or empty strings
    const isBoilerplate = /^(?:privacy\s+policy|terms\s+(?:of\s+service|and\s+conditions)|all\s+rights\s+reserved|copyright|about\s+us|contact\s+us|login|sign\s+in|logout|sign\s+up|home|dashboard|navigation)\b/i.test(cleanedText);
    if (isBoilerplate || cleanedText.length < 4) {
      console.warn('[Moodle AI Diagnostic 3/14] Selection detected as unrelated content (rejected):', cleanedText.slice(0, 50));
      return null;
    }

    console.log('[Moodle AI Diagnostic 5/14] Question extracted via Mode B (Selection):', {
      question: cleanedText.slice(0, 60),
      optionsAttached: pageOptions.length
    });

    return {
      platform: 'moodle',
      questionNumber: (cleanedText.match(/^\d+/) || ['1'])[0],
      questionType: pageOptions.length > 0 ? 'single_choice' : 'short_answer',
      question: cleanedText,
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

    // Google practice problems, search widgets, knowledge panels, interactive quiz cards
    const widgetCard = el.closest('[data-ved], .g, [jscontroller], [data-hveid], [class*="practice" i], [class*="problem" i], [class*="widget" i]');
    if (widgetCard && widgetCard !== document.body && widgetCard.querySelectorAll('button, [role="button"], [role="radio"], label, li, [class*="option" i], [class*="choice" i]').length >= 2) {
      return widgetCard;
    }

    // 2. Climb up parent chain looking for any container containing options
    let curr = el;
    let bestContainer = null;
    let depth = 0;

    while (curr && curr !== document.body && depth < 16) {
      depth++;
      const inputs = curr.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]');
      if (inputs.length >= 2 && inputs.length <= 25) {
        bestContainer = curr;
        const hasPrompt = curr.querySelector('h1, h2, h3, h4, h5, h6, [class*="title"], [class*="prompt"], [class*="text"], p, legend');
        if (hasPrompt) {
          return curr;
        }
      }

      // Check button-based or custom card-based options (Google practice quiz, custom web apps)
      const customOpts = curr.querySelectorAll('button, [role="button"], label, [class*="option" i], [class*="choice" i], [class*="answer" i], [class*="card" i]');
      if (customOpts.length >= 2 && customOpts.length <= 25) {
        const textOpts = Array.from(customOpts).filter(c => {
          const t = c.textContent.trim();
          return t.length > 0 && t.length < 250;
        });
        if (textOpts.length >= 2) {
          bestContainer = curr;
          const hasPrompt = curr.querySelector('h1, h2, h3, h4, h5, h6, [class*="title" i], [class*="prompt" i], [class*="text" i], [class*="question" i], p');
          if (hasPrompt) return curr;
        }
      }

      const className = typeof curr.className === 'string' ? curr.className : '';
      if (/card|box|item|block|form-group|fieldset|widget|result|section/i.test(className) && (inputs.length >= 1 || customOpts.length >= 2)) {
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
   * Helper to determine if an element is genuinely visible on page (supports iframes & shadow DOM)
   */
  function isElementVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;

    try {
      const win = el.ownerDocument?.defaultView || window;
      if (typeof win.getComputedStyle === 'function') {
        const style = win.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
          return false;
        }
      }
    } catch (e) {}

    const isJSDOM = typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent || '');
    if (!isJSDOM) {
      const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (rect && rect.width === 0 && rect.height === 0) {
        if (el.children.length === 0) return false;
      }
    }

    return true;
  }

  /**
   * Check if element is a valid question container (has at least 2 options or question inputs)
   */
  function isValidQuestionContainer(el) {
    if (!el || el.children.length === 0) return false;
    if (el.matches('header, nav, footer, li, ul, ol, [class*="chip" i], [class*="tag" i], [class*="badge" i], [class*="sidebar" i]')) return false;
    if (el.closest('header, nav, footer, [class*="chip" i], [class*="tag" i]')) return false;
    if (el.matches('[class*="optionItem" i], [class*="option-item" i], [class*="optionsList" i], [class*="options-list" i], [class*="optionLabel" i], [class*="optionInput" i], [class*="optionContainer" i]')) return false;
    if (el.matches('[class*="questionText" i], [class*="qtext" i], [class*="prompt" i], [class*="header" i], [class*="footer" i]')) return false;

    // 1. Must have radio/checkbox inputs
    const inputs = el.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]');
    if (inputs.length >= 2) return true;

    // 2. Matching questions with select dropdowns
    const selects = el.querySelectorAll('select, [role="listbox"]');
    if (selects.length >= 1) return true;

    // 3. Text inputs for numerical or short answer questions
    const textInputs = el.querySelectorAll('input[type="text"], input[type="number"], textarea');
    if (textInputs.length >= 1 && (el.classList.contains('numerical') || el.classList.contains('shortanswer') || el.querySelector('.qtext, .formulation'))) {
      return true;
    }

    // 4. Custom card-based options / answer choices
    const optionEls = el.querySelectorAll('[class*="optionContainer" i], [class*="option-item" i], [class*="optionItem" i], [class*="optionCard" i], [class*="option-card" i], [class*="choice" i], [class*="answer" i], li');
    const textOptions = Array.from(optionEls).filter(o => o.textContent.trim().length > 0 && o.textContent.trim().length < 300);
    if (textOptions.length >= 2) return true;

    // 5. Question prompt and option text in raw markup
    const text = el.textContent.trim();
    if (text.length >= 20 && (/^(?:(?:\([A-Da-d]\))|[A-Da-d][\.\:\)])/m.test(text) || /\b(True|False)\b/i.test(text))) {
      return true;
    }

    return false;
  }

  /**
   * Get all question containers on the page (filtered to visible ones)
   */
  function getQuestionContainers() {
    let list = Array.from(document.querySelectorAll('.que'));
    if (list.length > 0) {
      const visible = list.filter(isElementVisible);
      return visible.length > 0 ? visible : list;
    }

    const rawCandidates = Array.from(document.querySelectorAll(
      '[data-question-id], .question-container, .formulation, fieldset, .quiz-card, ' +
      '[class*="questionsAndOptions" i], [class*="quizQuestion" i], [class*="quizComponent" i], ' +
      '[class*="quiz-question" i], [class*="question-card" i], [class*="question_holder" i], ' +
      '[class*="quizCard" i], [class*="QuizQuestionCard" i], [class*="questionCard" i], ' +
      '[class*="bix-div-container" i], [class*="bix-tbl-container" i], [class*="que-ans" i], ' +
      '.question, [class*="question-block" i], [class*="question_content" i], [class*="question_title" i], ' +
      '[role="listitem"], [data-item-id], [class*="geS5n" i], [class*="display_question" i], ' +
      '[class*="quiz_sortable_question" i], [class*="takeQuestionDiv" i], [class*="questionDiv" i]'
    )).filter(isValidQuestionContainer);

    if (rawCandidates.length > 0) {
      // Pick innermost containers (leaf question cards, not outer wrappers)
      const innermost = rawCandidates.filter(c => !rawCandidates.some(other => other !== c && c.contains(other)));
      const visible = innermost.filter(isElementVisible);
      return visible.length > 0 ? visible : innermost;
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
            const hasHeading = container.parentElement.querySelector('h1, h2, h3, h4, h5, h6, [class*="title" i], p');
            if (hasHeading) container = container.parentElement;
          }
          containers.push(container);
        }
      }
    }

    // Dynamic grouping by custom option items (GeeksforGeeks, IndiaBIX, Sanfoundry, etc.)
    const customOptions = Array.from(document.querySelectorAll(
      '[class*="optionContainer" i], [class*="option-item" i], [class*="choice-item" i], [class*="answer-item" i]'
    )).filter(el => {
      const text = el.textContent.trim();
      return text.length > 0 && text.length < 300;
    });
    if (customOptions.length >= 2) {
      const leaves = customOptions.filter(el => !customOptions.some(other => other !== el && el.contains(other)));
      if (leaves.length >= 2) {
        let container = findLowestCommonAncestor(leaves);
        if (container) {
          if (container.parentElement && container.parentElement !== document.body && container.parentElement.tagName !== 'MAIN') {
            const hasHeading = container.parentElement.querySelector('h1, h2, h3, h4, h5, h6, [class*="title" i], p');
            if (hasHeading) container = container.parentElement;
          }
          containers.push(container);
        }
      }
    }

    if (containers.length > 0) {
      const unique = Array.from(new Set(containers));
      const visible = unique.filter(isElementVisible);
      return visible.length > 0 ? visible : unique;
    }

    // Fallback: Check elements with numbers like "1. ", "8. "
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6, p, div')).filter(el => {
      const text = el.textContent.trim();
      return /^\d+[\.\:\)]\s+\S+/.test(text) && text.length < 300 && el.children.length < 3;
    });

    const headingContainers = headings.map(h => findQuestionContainerFromElement(h) || h.parentElement).filter(Boolean);
    const uniqueHeadings = Array.from(new Set(headingContainers));
    const visibleHeadings = uniqueHeadings.filter(isElementVisible);
    return visibleHeadings.length > 0 ? visibleHeadings : uniqueHeadings;
  }

  /**
   * Determine target question (selected text, active focus, under cursor, or most visible in viewport)
   */
  function getTargetQuestionElement() {
    // 1. Check user text selection anchor
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.anchorNode) {
      const anchorEl = selection.anchorNode.nodeType === Node.ELEMENT_NODE
        ? selection.anchorNode
        : selection.anchorNode.parentElement;
      const q = findQuestionContainerFromElement(anchorEl);
      if (q && isElementVisible(q)) return q;
    }

    // 2. Check document activeElement focus (keyboard navigation or radio/input click)
    if (document.activeElement && document.activeElement !== document.body && document.activeElement !== document.documentElement) {
      const q = findQuestionContainerFromElement(document.activeElement);
      if (q && isElementVisible(q)) return q;
    }

    // 3. Check under cursor
    if (elementUnderMouse) {
      const q = findQuestionContainerFromElement(elementUnderMouse);
      if (q && isElementVisible(q)) return q;
    }

    // 4. Check active/clicked question in memory
    if (activeQuestionElement && document.body.contains(activeQuestionElement) && isElementVisible(activeQuestionElement)) {
      const rect = activeQuestionElement.getBoundingClientRect();
      if (rect.bottom > 20 && rect.top < (window.innerHeight || 800) - 20) {
        return activeQuestionElement;
      }
    }

    // 5. Scan all visible question containers and determine the most prominent one in viewport
    const questions = getQuestionContainers().filter(isElementVisible);
    if (questions.length === 0) return null;

    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 800;
    const viewportCenter = viewportHeight / 2;

    let bestQuestion = null;
    let maxVisibleHeight = 0;
    let minCenterDistance = Infinity;

    for (const q of questions) {
      const rect = q.getBoundingClientRect();
      const visibleTop = Math.max(0, rect.top);
      const visibleBottom = Math.min(viewportHeight, rect.bottom);
      const visibleHeight = Math.max(0, visibleBottom - visibleTop);

      if (visibleHeight > 0) {
        const qCenter = visibleTop + visibleHeight / 2;
        const distFromCenter = Math.abs(qCenter - viewportCenter);

        if (visibleHeight > maxVisibleHeight * 1.25 || (Math.abs(visibleHeight - maxVisibleHeight) <= 40 && distFromCenter < minCenterDistance)) {
          maxVisibleHeight = visibleHeight;
          minCenterDistance = distFromCenter;
          bestQuestion = q;
        }
      }
    }

    if (bestQuestion) return bestQuestion;

    // Fallback: If containers are found (single question or test environment without layout metrics), return first
    if (questions.length > 0) {
      return questions[0];
    }

    // 6. Viewport fallback: scan visible elements for question text & options
    const viewportEls = Array.from(document.querySelectorAll('article, section, form, [role="main"], div')).filter(el => {
      if (el.children.length > 50 || el.children.length < 1) return false;
      const text = el.textContent || '';
      return text.length > 25 && text.length < 2500 &&
             (/\?|^\s*\d+[\.\:\)]/m.test(text)) &&
             (/^(?:(?:\([A-Da-d0-9]\))|(?:\[[A-Da-d0-9]\])|[A-Da-d0-9][\.\:\)\-])\s+\S+/m.test(text) || /\b(True|False)\b/i.test(text) || el.querySelector('input[type="radio"], input[type="checkbox"]'));
    });
    if (viewportEls.length > 0) {
      const innermost = viewportEls.filter(c => !viewportEls.some(other => other !== c && c.contains(other)));
      const visible = innermost.filter(isElementVisible);
      if (visible.length > 0) return visible[0];
      if (innermost.length > 0) return innermost[0];
    }

    return null;
  }

  /**
   * Cleanly format text preserving math, code, equations, and tables
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

    // MathML
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

    // Superscripts & Subscripts (equations, powers, Big-O complexities)
    clone.querySelectorAll('sup').forEach(sup => {
      const span = document.createElement('span');
      span.textContent = `^{${sup.textContent}}`;
      sup.replaceWith(span);
    });
    clone.querySelectorAll('sub').forEach(sub => {
      const span = document.createElement('span');
      span.textContent = `_{${sub.textContent}}`;
      sub.replaceWith(span);
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
   * Check if an element is a relevant question image (and not a decor icon or inside answer options)
   */
  function isRelevantQuestionImage(el, questionEl) {
    if (!el || !questionEl.contains(el)) return false;

    // Must NOT be inside answer choices, feedback, user info, or comments
    const excludedAncestor = el.closest('.answer, .ablock, .info, .feedback, .outcome, .comment, .options-group, [class*="optionContainer" i], [class*="option-item" i], [class*="choice-item" i], [class*="answer-item" i]');
    if (excludedAncestor && excludedAncestor !== questionEl && questionEl.contains(excludedAncestor)) {
      return false;
    }

    // Exclude icons, avatars, flags, decorative images, buttons, and navigation
    if (el.classList.contains('icon') || el.classList.contains('userpicture') || el.classList.contains('activityicon') || el.classList.contains('smallicon')) {
      return false;
    }
    if (el.getAttribute('role') === 'presentation' || el.getAttribute('aria-hidden') === 'true') {
      return false;
    }
    if (el.closest('button, a, [role="button"], [class*="btn" i], nav, header, footer, .info, .state, .grade')) {
      return false;
    }

    // Exclude MathJax / KaTeX / TeX formulas (formulas are cleanly captured as LaTeX math text)
    if (el.closest('.MathJax, .katex, mjx-container, math, .tex, [class*="math" i]')) {
      return false;
    }

    // Exclude images without valid source
    if (el.tagName === 'IMG') {
      const src = el.currentSrc || el.src || el.getAttribute('src') || el.getAttribute('data-src') || el.getAttribute('data-lazy-src') || el.getAttribute('data-original') || el.getAttribute('data-url') || el.getAttribute('srcset');
      if (!src || !src.trim() || src.trim() === '#' || src.trim() === 'about:blank' || src.trim().startsWith('javascript:')) {
        return false;
      }
    }

    // Exclude small SVG icons (checkboxes, flags, UI chevrons)
    if (el.tagName === 'SVG' || el instanceof (window.SVGElement || Object)) {
      const svgW = parseFloat(el.getAttribute('width') || el.style.width || 0);
      const svgH = parseFloat(el.getAttribute('height') || el.style.height || 0);
      if ((svgW > 0 && svgW < 32) || (svgH > 0 && svgH < 32)) {
        return false;
      }
    }

    // Check dimensions if available (exclude spacers, 1x1 pixels, tiny bullets < 18px)
    const attrW = parseInt(el.getAttribute('width'), 10);
    const attrH = parseInt(el.getAttribute('height'), 10);
    if (!isNaN(attrW) && !isNaN(attrH) && (attrW < 18 || attrH < 18)) {
      return false;
    }

    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    if (rect && rect.width > 0 && rect.height > 0 && (rect.width < 18 || rect.height < 18)) {
      return false;
    }
    if (el.tagName === 'IMG' && el.naturalWidth > 0 && el.naturalWidth < 18 && el.naturalHeight > 0 && el.naturalHeight < 18) {
      return false;
    }

    return true;
  }

  /**
   * Find all relevant images strictly within the question prompt/formulation in DOM order
   */
  function extractQuestionImageElements(questionEl) {
    if (!questionEl) return [];
    const qArea = questionEl.querySelector('.qtext') ||
                  questionEl.querySelector('.formulation') ||
                  questionEl;

    return Array.from(qArea.querySelectorAll('img, svg, canvas')).filter(el => isRelevantQuestionImage(el, questionEl));
  }

  /**
   * Get initial string representation or source of an image element
   */
  function getInitialImageSource(el) {
    if (!el) return '';
    if (el.tagName === 'IMG') {
      let src = el.currentSrc || el.src || el.getAttribute('src');
      if (!src || src.startsWith('blob:') || el.getAttribute('data-src') || el.getAttribute('data-lazy-src')) {
        src = el.getAttribute('data-src') || el.getAttribute('data-lazy-src') || el.getAttribute('data-original') || src || '';
      }
      if (!src && el.getAttribute('srcset')) {
        const parts = el.getAttribute('srcset').split(',').map(s => s.trim().split(/\s+/)[0]);
        src = parts[parts.length - 1] || parts[0] || '';
      }
      return src;
    }
    if (el.tagName === 'CANVAS') {
      try {
        return el.toDataURL('image/png');
      } catch (e) {
        return 'canvas:accessible';
      }
    }
    if (el.tagName === 'SVG' || el instanceof (window.SVGElement || Object)) {
      try {
        const serializer = new (window.XMLSerializer || XMLSerializer)();
        const svgStr = serializer.serializeToString(el);
        const base64 = typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(svgStr))) : Buffer.from(svgStr).toString('base64');
        return `data:image/svg+xml;base64,${base64}`;
      } catch (e) {
        return 'svg:diagram';
      }
    }
    return '';
  }

  /**
   * Convert an image element (img, svg, canvas) into a base64 data URL
   */
  async function convertImageElementToDataUrl(el) {
    if (!el) return null;

    if (el.tagName === 'CANVAS') {
      try {
        const dataUrl = el.toDataURL('image/png');
        if (dataUrl && dataUrl.startsWith('data:image/')) return dataUrl;
      } catch (e) {
        throw new Error('Inaccessible Canvas: Canvas is tainted or security restricted.');
      }
    }

    if (el.tagName === 'SVG' || el instanceof (window.SVGElement || Object)) {
      const serializer = new (window.XMLSerializer || XMLSerializer)();
      const svgStr = serializer.serializeToString(el);
      const base64 = typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(svgStr))) : Buffer.from(svgStr).toString('base64');
      return `data:image/svg+xml;base64,${base64}`;
    }

    if (el.tagName === 'IMG') {
      let src = el.currentSrc || el.src || el.getAttribute('src');
      if (!src || src.startsWith('blob:') || el.getAttribute('data-src') || el.getAttribute('data-lazy-src')) {
        src = el.getAttribute('data-src') || el.getAttribute('data-lazy-src') || el.getAttribute('data-original') || src;
      }
      if (!src && el.getAttribute('srcset')) {
        const parts = el.getAttribute('srcset').split(',').map(s => s.trim().split(/\s+/)[0]);
        src = parts[parts.length - 1] || parts[0];
      }

      if (!src) {
        throw new Error('Inaccessible image: <img> has no valid src or srcset attribute.');
      }

      if (src.startsWith('data:image/')) {
        return src;
      }

      // Try canvas conversion if loaded in DOM
      try {
        if (el.naturalWidth > 0 && typeof document.createElement === 'function') {
          const canvas = document.createElement('canvas');
          canvas.width = el.naturalWidth;
          canvas.height = el.naturalHeight;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(el, 0, 0);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
            if (dataUrl && dataUrl.startsWith('data:image/')) return dataUrl;
          }
        }
      } catch (canvasErr) {
        // Tainted canvas by CORS, fall through to background fetch
      }

      // Fetch via background or direct fetch
      const fetched = await fetchImageAsDataUrl(src);
      if (fetched) return fetched;

      throw new Error(`Inaccessible image: Could not load or decode image from ${src.slice(0, 60)}...`);
    }

    return null;
  }

  /**
   * Helper to fetch an image and convert it to a base64 data URL
   */
  async function fetchImageAsDataUrl(url) {
    if (!url) return null;
    if (url.startsWith('data:image/')) return url;

    // 1. Try background fetch if chrome.runtime is available
    if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
      try {
        const response = await chrome.runtime.sendMessage({
          action: 'FETCH_IMAGE_AS_DATA_URL',
          url
        });
        if (response) {
          if (response.success && response.dataUrl) {
            return response.dataUrl;
          }
          if (response.success === false) {
            return null; // Explicit failure from background fetch
          }
        }
      } catch (e) {}
    }

    // 2. Direct fetch fallback
    if (typeof fetch === 'function') {
      try {
        const res = await fetch(url);
        if (res.ok) {
          const blob = await res.blob();
          return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        }
      } catch (e) {}
    }

    return null;
  }

  /**
   * Extract question text and options universally
   */
  function extractQuestionData(questionEl) {
    if (!questionEl) return null;

    // 1. Question Text
    let questionText = '';
    const qtextElem = questionEl.querySelector('.qtext') ||
                      questionEl.querySelector('[class*="quizQuestionTextContainer" i] [class*="question" i]') ||
                      questionEl.querySelector('[class*="quizQuestionTextContainer" i]') ||
                      questionEl.querySelector('.formulation .qtext') ||
                      questionEl.querySelector('.formulation') ||
                      questionEl.querySelector('.q-title, h1, h2, h3, h4, h5, h6, legend, [class*="question-text" i], [class*="prompt" i], p');

    if (qtextElem) {
      const clone = qtextElem.cloneNode(true);
      clone.querySelectorAll('.answer, input, .prompt, .options-group, .info, .state, .grade, .im-controls, .comment').forEach(el => el.remove());
      questionText = extractFormattedText(clone);
    }

    // Strip Moodle metadata lines & status headers
    questionText = cleanMoodleJunk(questionText);

    if (!questionText || questionText.length < 3) {
      const cloneQ = questionEl.cloneNode(true);
      cloneQ.querySelectorAll('.answer, input, .prompt, .options-group, .info, .state, .grade, .outcome, .feedback, .im-controls, .comment').forEach(el => el.remove());
      const allText = extractFormattedText(cloneQ);
      const cleanedAll = cleanMoodleJunk(allText);
      const lines = cleanedAll.split('\n').filter(Boolean);
      const firstOptIdx = lines.findIndex(l => /^(?:[A-Za-z][\.\:\)\-]|(?:\([A-Za-z0-9]\))|\d+[\.\:\)\-])\s+/i.test(l));
      if (firstOptIdx > 0) {
        questionText = lines.slice(0, firstOptIdx).join(' ');
      } else if (lines.length > 0) {
        const qLine = lines.find(l => /^\d+[\.\:\)]/.test(l) || l.endsWith('?')) || lines[0] || '';
        questionText = qLine;
      }
    }

    questionText = cleanMoodleJunk(questionText);

    // 1b. Detect images strictly within this question container in DOM order
    const relevantImages = extractQuestionImageElements(questionEl);
    const diagrams = [];
    relevantImages.forEach(diag => {
      const alt = diag.getAttribute('alt') || diag.getAttribute('title') || diag.getAttribute('aria-label') || '';
      if (alt.trim()) {
        diagrams.push(alt.trim());
      }
    });

    const isImageOnly = (!questionText || questionText.trim().length === 0) && relevantImages.length > 0;
    const hasImages = relevantImages.length > 0;

    if (isImageOnly) {
      questionText = diagrams.length > 0
        ? `Solve the question shown in the attached image: ${diagrams.join('; ')}`
        : 'Solve the question shown in the attached image.';
    } else if (diagrams.length > 0 && !questionText.includes('[Diagram:')) {
      questionText += `\n[Diagram / Visual: ${diagrams.join('; ')}]`;
    }

    const noElem = questionEl.querySelector('.info .no');
    const questionNumber = noElem ? noElem.textContent.replace(/[^\d]/g, '') : (questionEl.id || '').replace(/[^\d]/g, '') || '1';

    // 2. Options
    const options = [];
    let inputs = Array.from(questionEl.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]'));

    // If no standard inputs found, detect custom option items / labels / list items
    if (inputs.length === 0) {
      const candidates = Array.from(questionEl.querySelectorAll(
        'button, [role="button"], [role="radio"], label, [class*="optionItem" i], [class*="option-item" i], [class*="optionContainer" i], ' +
        '[class*="optionCard" i], [class*="option-card" i], [class*="choiceCard" i], [class*="answerCard" i], ' +
        '[class*="option" i], [class*="choice" i], [class*="answer" i], [class*="item" i], li'
      )).filter(el => {
        if (el.matches('h1, h2, h3, h4, h5, h6, legend, [class*="title" i], [class*="prompt" i], [class*="header" i]')) return false;
        if (el.closest('h1, h2, h3, h4, h5, h6, legend, [class*="title" i], [class*="prompt" i], [class*="header" i]')) return false;
        const text = el.textContent.trim();
        return text.length > 0 && text.length < 250;
      });
      // Retain leaf option items (filter out parent containers that enclose other candidate options)
      const leafCandidates = candidates.filter(item => !candidates.some(other => other !== item && item.contains(other)));
      if (leafCandidates.length >= 2) {
        inputs = leafCandidates;
      }
    }

    // 2b. If still no inputs found, detect elements with option prefixes (A., B., C., D. or (A), (B), etc.)
    if (inputs.length === 0) {
      const textEls = Array.from(questionEl.querySelectorAll('button, [role="button"], p, div, span, li, a')).filter(el => {
        if (el.children.length > 3) return false;
        const t = el.textContent.trim();
        return /^(?:(?:\([A-Da-d0-9]\))|(?:\[[A-Da-d0-9]\])|[A-Da-d0-9][\.\:\)\-])\s+\S+/.test(t) && t.length < 300;
      });
      const outermost = textEls.filter(item => !textEls.some(other => other !== item && other.contains(item)));
      if (outermost.length >= 2) {
        inputs = outermost;
      }
    }

    inputs.forEach((input, idx) => {
      let text = '';

      if (input.tagName !== 'INPUT') {
        const circle = input.querySelector('[class*="innerCircle" i], [class*="optionInput" i], [class*="cardLetter" i], [class*="letter" i]');
        const label = input.querySelector('[class*="optionLabel" i], [class*="cardText" i], [class*="text" i]');
        if (label) {
          const labelText = extractFormattedText(label);
          const letter = circle ? circle.textContent.trim() : String.fromCharCode(65 + idx);
          text = `${letter}. ${labelText}`;
        } else {
          text = extractFormattedText(input);
        }
      } else {
        if (input.labels && input.labels.length > 0) {
          text = extractFormattedText(input.labels[0]);
        }

        if (!text && input.id) {
          const doc = questionEl.ownerDocument || document;
          const label = questionEl.querySelector(`label[for="${CSS.escape(input.id)}"]`) ||
                        doc.querySelector(`label[for="${CSS.escape(input.id)}"]`);
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

      const letterIndex = String.fromCharCode(65 + idx);
      let letter = letterIndex;
      let formattedText = text;

      if (/^(true|false)$/i.test(text)) {
        formattedText = text[0].toUpperCase() + text.slice(1).toLowerCase();
        letter = formattedText === 'True' ? 'A' : 'B';
      } else {
        const letterMatch = text.match(/^(?:(?:\(([A-Za-z0-9])\))|(?:\[([A-Za-z0-9])\])|([A-Za-z0-9])[\.\:\)\-])\s*(.*)$/);
        if (letterMatch) {
          letter = (letterMatch[1] || letterMatch[2] || letterMatch[3]).toUpperCase();
          const content = letterMatch[4] ? letterMatch[4].trim() : text;
          formattedText = `${letter}. ${content}`;
        } else {
          formattedText = `${letterIndex}. ${text}`;
        }
      }

      options.push({
        id: letter,
        text: formattedText,
        inputVal: input.value || '',
        elementId: input.id || ''
      });
    });

    // 2c. If options array is still empty, scan raw text lines for options
    if (options.length === 0) {
      const rawLines = (questionEl.innerText || questionEl.textContent || '')
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);
      const optLines = rawLines.filter(l => 
        /^(?:(?:\([A-Da-d0-9]\))|(?:\[[A-Da-d0-9]\])|[A-Da-d0-9][\.\:\)\-])\s+/i.test(l) || /^(?:True|False)$/i.test(l)
      );
      if (optLines.length >= 2) {
        optLines.forEach((optText, idx) => {
          const letterMatch = optText.match(/^(?:(?:\(([A-Za-z0-9]+)\))|(?:\[([A-Za-z0-9]+)\])|([A-Za-z0-9]+)[\.\:\)\-])\s*(.*)$/);
          const letter = letterMatch ? (letterMatch[1] || letterMatch[2] || letterMatch[3]).toUpperCase() : String.fromCharCode(65 + idx);
          options.push({
            id: letter,
            text: optText
          });
        });
      }
    }

    // If questionText is missing but options exist, infer questionText from preceding lines
    if ((!questionText || questionText.length < 3) && options.length >= 2) {
      const rawLines = (questionEl.innerText || questionEl.textContent || '')
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);
      const firstOptIndex = rawLines.findIndex(l => 
        /^(?:(?:\([A-Da-d0-9]\))|(?:\[[A-Da-d0-9]\])|[A-Da-d0-9][\.\:\)\-])\s+/i.test(l) || /^(?:True|False)$/i.test(l)
      );
      if (firstOptIndex > 0) {
        questionText = rawLines.slice(0, firstOptIndex).join(' ');
      }
    }

    // Support Moodle matching questions (<select> elements in rows)
    const selects = Array.from(questionEl.querySelectorAll('select, [role="listbox"]'));
    if (inputs.length === 0 && options.length === 0 && selects.length > 0) {
      const rows = Array.from(questionEl.querySelectorAll('tr, .match-row, [class*="row" i]')).filter(r => r.querySelector('select'));
      if (rows.length > 0) {
        let matchingPrompt = questionText ? `${questionText}\n\nMatch each item:\n` : 'Match each item:\n';
        const allChoices = new Set();
        rows.forEach((row, rIdx) => {
          const itemTextEl = row.querySelector('.text, [class*="text" i], td:first-child');
          const itemText = itemTextEl ? extractFormattedText(itemTextEl) : `Item ${rIdx + 1}`;
          const select = row.querySelector('select');
          const choices = select ? Array.from(select.options).map(o => o.text.trim()).filter(t => t && !/choose|select/i.test(t)) : [];
          choices.forEach(c => allChoices.add(c));
          matchingPrompt += `${rIdx + 1}. ${itemText} -> [Options: ${choices.join(', ')}]\n`;
        });
        questionText = matchingPrompt;
        Array.from(allChoices).forEach((choice, cIdx) => {
          options.push({
            id: String.fromCharCode(65 + cIdx),
            text: `${String.fromCharCode(65 + cIdx)}. ${choice}`
          });
        });
      }
    }

    const hasCheckboxes = questionEl.querySelectorAll('input[type="checkbox"], [role="checkbox"]').length > 0;
    const isTrueFalse = options.length === 2 && options.some(o => /true/i.test(o.text)) && options.some(o => /false/i.test(o.text));
    const isMatching = selects.length > 0 && options.length > 0;
    const isDSA = /\b(time complexity|space complexity|big-o|recurrence|binary search|merge sort|quicksort|dynamic programming|dijkstra|graph|bfs|dfs|heap|tree)\b/i.test(questionText);
    const isCoding = /```|public static|def |function\(|int main/i.test(questionText) || questionEl.querySelector('pre, code') !== null;

    let questionType = 'single_choice';
    if (isImageOnly) {
      questionType = 'image_based';
    } else if (isMatching) {
      questionType = 'matching';
    } else if (isTrueFalse || questionEl.classList.contains('truefalse')) {
      questionType = 'true_false';
    } else if (hasCheckboxes) {
      questionType = 'multiple_choice';
    } else if (isCoding) {
      questionType = 'coding';
    } else if (isDSA) {
      questionType = 'dsa';
    } else if (options.length === 0) {
      if (questionEl.classList.contains('numerical') || questionEl.querySelector('.numerical') || /calculate|sum|\bmath\b|\d+\s*[\+\-\*\/]\s*\d+/i.test(questionText)) {
        questionType = 'numerical';
      } else {
        questionType = 'short_answer';
      }
    }

    console.log('[Moodle AI Diagnostic 5/14] Question extracted via Mode A:', {
      preview: (questionText || '').slice(0, 60),
      questionNumber
    });
    console.log('[Moodle AI Diagnostic 6/14] Options extracted via Mode A:', {
      count: options.length,
      optionIds: options.map(o => o.id)
    });

    return {
      platform: 'moodle',
      questionNumber,
      questionType: isImageOnly ? 'image_based' : questionType,
      hasDiagram: diagrams.length > 0,
      hasImage: hasImages,
      isImageBased: isImageOnly,
      question: questionText || (hasImages ? 'Solve the question shown in the attached image.' : 'Answer the following question'),
      options,
      images: relevantImages.map(el => getInitialImageSource(el)),
      imageElements: relevantImages
    };
  }

  /**
   * Execute Shortcut 1: Shift + Z — Solve Current Question
   */
  async function solveCurrentQuestion() {
    if (!isExtensionEnabled) return;

    // 1. Debounce rapid key triggers
    const now = Date.now();
    if (now - lastSolveRequestTime < DEBOUNCE_MS) {
      return;
    }
    lastSolveRequestTime = now;

    const notif = getNotification();
    if (notif) notif.showStatus('Quick AI — Solving question...');

    const extractStartTime = performance.now();

    // 2. Extract question text and options (Mode B selection or Mode A automatic)
    const selection = window.getSelection();
    const hasUserSelection = Boolean(selection && !selection.isCollapsed && selection.toString().trim().length > 1);

    let data = null;
    let detectionMode = hasUserSelection ? 'Mode B (Selection)' : 'Mode A (Automatic DOM)';

    if (hasUserSelection) {
      console.log('[Moodle AI Diagnostic 3/14] Selection detected by user on page');
      data = extractFromSelection();
      if (!data) {
        console.warn('[Moodle AI Diagnostic 7/14] Extraction validation: FAILED (Selection is unrelated or missing context)');
        if (notif) {
          notif.showError('Question not detected. Select the question or use Shift + X.');
        }
        return;
      }
    } else {
      // Mode A: Automatic DOM Detection
      const questionEl = getTargetQuestionElement();
      if (questionEl) {
        console.log('[Moodle AI Diagnostic 4/14] Question container identified:', questionEl.className || questionEl.tagName);
        data = extractQuestionData(questionEl);
      }

      // 2b. Full-Page Fallback Scan for single-question pages (GeeksforGeeks, IndiaBIX, Sanfoundry, etc.)
      if (!data || (!data.question && (!data.options || data.options.length === 0) && (!data.images || data.images.length === 0))) {
        const candidateRoots = [
          document.querySelector('main, article, [role="main"], [class*="mainContent" i], #content, .content, .container, [class*="quiz" i]'),
          document.body
        ].filter(Boolean);
        for (const root of candidateRoots) {
          const fallbackData = extractQuestionData(root);
          if (fallbackData && (fallbackData.question || fallbackData.hasImage) && ((fallbackData.options && fallbackData.options.length >= 2) || fallbackData.hasImage || fallbackData.question.length > 20)) {
            data = fallbackData;
            break;
          }
        }
      }
    }

    const extractionDurationMs = Math.round(performance.now() - extractStartTime);

    // If no question text or options detected in DOM, show immediate user-facing error
    if (!data || (!data.question && (!data.options || data.options.length === 0) && (!data.images || data.images.length === 0))) {
      console.warn('[Moodle AI Diagnostic 7/14] Extraction validation: FAILED (No question text or options detected in DOM)');
      if (notif) {
        notif.showError('Question not detected. Select the question or use Shift + X.');
      }
      return;
    }

    console.log('[Moodle AI] QUESTION_EXTRACTED:', {
      mode: detectionMode,
      question: (data.question || '').slice(0, 70),
      optionsCount: data.options?.length,
      hasImages: Boolean(data.hasImage || (data.imageElements && data.imageElements.length > 0))
    });

    console.log('[Moodle AI Diagnostic 7/14] Extraction validation: PASSED', {
      mode: detectionMode,
      questionPreview: data.question?.slice(0, 70),
      optionsCount: data.options?.length,
      hasImages: Boolean(data.hasImage || (data.imageElements && data.imageElements.length > 0))
    });

    // 4. Resolve all images if question is image-based or contains images
    let resolvedImages = [];
    if (data.imageElements && data.imageElements.length > 0) {
      if (notif && data.isImageBased) {
        notif.showStatus('Quick AI — Solving question...');
      }
      for (const el of data.imageElements) {
        try {
          const dataUrl = await convertImageElementToDataUrl(el);
          if (dataUrl) resolvedImages.push(dataUrl);
        } catch (singleErr) {
          console.warn('[Moodle AI] Single image conversion skipped:', singleErr.message);
        }
      }
    }

    // If marked as image-based question (no question text in DOM), verify at least one image decoded
    if (data.isImageBased && resolvedImages.length === 0) {
      if (notif) {
        notif.showError('Could not decode question image. Press Shift+X to snip manually.');
      }
      return;
    }

    // 5. Duplicate request check (same question just solved)
    const currentQuestionHash = hashString((data.question || '') + (data.options || []).map(o => o.text).join('') + resolvedImages.join(''));
    if (lastAnswer && lastProcessedQuestionHash === currentQuestionHash && (now - lastSolveRequestTime < 2000)) {
      if (notif) notif.showAnswer(lastAnswer);
      return;
    }

    // Cancel / invalidate obsolete in-flight requests
    const thisRequestId = ++currentRequestId;

    if (notif) notif.showStatus('Quick AI — Solving question...');

    try {
      const startTime = performance.now();
      const payload = {
        platform: 'moodle',
        questionType: data.questionType || (resolvedImages.length > 0 ? 'image_based' : 'single_choice'),
        question: data.question || (resolvedImages.length > 0 ? 'Solve the question shown in the attached image.' : ''),
        options: data.options || [],
        extractionDurationMs
      };

      if (resolvedImages.length > 0) {
        payload.image = resolvedImages[0];
        payload.images = resolvedImages;
      }

      console.log('[Moodle AI] BACKGROUND_MESSAGE_SENT:', {
        action: 'ANALYZE_QUESTION',
        questionType: payload.questionType,
        optionsCount: payload.options?.length
      });

      console.log('[Moodle AI Diagnostic 8/14] Background message sent:', {
        action: 'ANALYZE_QUESTION',
        questionType: payload.questionType,
        optionsCount: payload.options?.length
      });

      if (!isExtensionContextValid()) {
        console.warn('[Moodle AI] Extension context invalidated. Refresh required.');
        if (notif) notif.showError('Please refresh this page (Cmd+R or F5)');
        return;
      }

      const response = await chrome.runtime.sendMessage({
        action: 'ANALYZE_QUESTION',
        payload
      });

      // Discard obsolete response if another question was triggered while waiting
      if (thisRequestId !== currentRequestId) {
        return;
      }

      if (!response || !response.success || !response.data) {
        throw new Error(response ? response.error : 'No response from backend');
      }

      const res = response.data;
      const totalClientDurationMs = Math.round(performance.now() - startTime);

      const isOllama = Boolean(
        res.isOllama ||
        res.provider === 'ollama' ||
        res.source === 'ollama_fallback' ||
        res.engine === 'direct_ollama' ||
        (res.model && (String(res.model).includes('gemma') || String(res.model).includes('llama') || String(res.model).includes('mistral') || String(res.model).includes('qwen')))
      );

      console.log('[Moodle AI] AI_RESPONSE_RECEIVED:', {
        option: res.option,
        answer: (res.answer || res.answerText || '').slice(0, 40),
        isOllama,
        provider: res.provider || (isOllama ? 'ollama' : 'gemini')
      });

      console.log('[Moodle AI Diagnostic 12/14] Response processed:', {
        option: res.option,
        answerPreview: (res.answer || res.answerText || '').slice(0, 40),
        isOllama,
        provider: res.provider || (isOllama ? 'ollama' : 'gemini')
      });

      lastAnswer = {
        question: payload.question || '',
        option: res.option || '',
        answer: res.answer || res.answerText || '',
        reason: res.reason || res.explanation || '',
        explanation: res.explanation || res.reason || '',
        confidence: res.confidence,
        status: res.status || 'ok',
        model: res.realUsage?.modelUsed || res.model || '',
        provider: res.provider || (isOllama ? 'ollama' : 'gemini'),
        source: res.source || (isOllama ? 'ollama_fallback' : 'cloud'),
        isOllama: isOllama,
        timestamp: Date.now(),
        latencyMs: res.latencyMs || totalClientDurationMs
      };
      lastProcessedQuestionHash = currentQuestionHash;

      // Persist across all frames, tabs, and page reloads
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ lastRecordedAnswer: lastAnswer });
        }
      } catch (_) {}

      if (notif) {
        notif.showAnswer(lastAnswer);
      }
    } catch (err) {
      if (thisRequestId !== currentRequestId) return;
      const isContextInv = err.message && (err.message.includes('context invalidated') || err.message.includes('Extension context'));
      if (isContextInv) {
        console.warn('[Moodle AI] Solve error: Extension context invalidated. Tab reload required.');
      } else {
        console.error('[Moodle AI] Solve error:', err.message);
      }
      let errMsg = err.message || 'Failed to solve question';
      if (isContextInv) {
        errMsg = 'Please refresh this page (Cmd+R or F5)';
      }
      if (notif) {
        notif.showError(errMsg);
      }
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
    let extractedOptions = [];

    // If triggered interactively by Shift+X, open the interactive snipping selector
    if (isInteractive && window.MoodleScreenshotHandler && typeof window.MoodleScreenshotHandler.promptUserSelectionArea === 'function') {
      cropRect = await window.MoodleScreenshotHandler.promptUserSelectionArea();
      if (!cropRect) {
        console.log('[Moodle AI] Screenshot selection cancelled.');
        return;
      }

      // Opportunistically detect if snipped area overlaps a quiz question element on the page
      try {
        const centerX = cropRect.x + cropRect.width / 2;
        const centerY = cropRect.y + cropRect.height / 2;
        const elUnder = document.elementFromPoint(centerX, centerY);
        if (elUnder) {
          const questionContainer = elUnder.closest('.que, .question, [class*="quiz"], [id*="question"]');
          if (questionContainer) {
            const data = extractQuestionData(questionContainer);
            if (data) {
              if (!partialText) partialText = data.question;
              if (Array.isArray(data.options) && data.options.length > 0) {
                extractedOptions = data.options;
              }
            }
          }
        }
      } catch (_) {}
    } else {
      const questionEl = getTargetQuestionElement();
      if (questionEl && window.MoodleScreenshotHandler) {
        cropRect = window.MoodleScreenshotHandler.getQuestionCropRect(questionEl);
        if (!partialText) {
          const data = extractQuestionData(questionEl);
          if (data) {
            partialText = data.question;
            if (Array.isArray(data.options)) extractedOptions = data.options;
          }
        }
      }
    }

    const notif = getNotification();
    if (notif) notif.showStatus(isInteractive ? 'Quick AI — Select question region...' : 'Quick AI — Solving screenshot...');

    if (!isExtensionContextValid()) {
      console.warn('[Moodle AI] Extension context invalidated. Refresh required.');
      if (notif) notif.showError('Please refresh this page (Cmd+R or F5)');
      return;
    }

    try {
      const captureRes = await chrome.runtime.sendMessage({ action: 'CAPTURE_VISIBLE_TAB' });
      if (!captureRes || !captureRes.dataUrl) {
        throw new Error('Screenshot capture failed. Please make sure the tab is active.');
      }

      let finalImageUrl = captureRes.dataUrl;
      if (cropRect && window.MoodleScreenshotHandler) {
        finalImageUrl = await window.MoodleScreenshotHandler.cropImage(captureRes.dataUrl, cropRect);
      }

      if (notif) {
        notif.showStatus('Quick AI — Solving screenshot...');
      }

      console.log('[Moodle AI] BACKGROUND_MESSAGE_SENT:', {
        action: 'ANALYZE_QUESTION',
        questionType: 'vision'
      });

      let response = null;
      try {
        response = await chrome.runtime.sendMessage({
          action: 'ANALYZE_QUESTION',
          payload: {
            platform: 'moodle',
            questionType: 'vision',
            question: partialText || 'Identify the question shown in the selected area and determine the best answer.',
            options: extractedOptions || [],
            image: finalImageUrl
          }
        });
      } catch (sendErr) {
        throw new Error(sendErr.message || 'Could not communicate with background service');
      }

      if (!response || !response.success || !response.data) {
        throw new Error(response ? response.error : 'No vision response from backend');
      }

      const res = response.data;
      const isOllama = Boolean(
        res.isOllama ||
        res.provider === 'ollama' ||
        res.source === 'ollama_fallback' ||
        res.engine === 'direct_ollama' ||
        (res.model && (String(res.model).includes('gemma') || String(res.model).includes('llama') || String(res.model).includes('mistral') || String(res.model).includes('qwen')))
      );

      console.log('[Moodle AI] AI_RESPONSE_RECEIVED:', {
        option: res.option,
        answer: (res.answer || res.answerText || '').slice(0, 40),
        isOllama,
        provider: res.provider || (isOllama ? 'ollama' : 'gemini')
      });

      lastAnswer = {
        question: partialText || 'Screen Snippet',
        option: res.option || '',
        answer: res.answer || res.answerText || '',
        reason: res.reason || res.explanation || '',
        explanation: res.explanation || res.reason || '',
        confidence: res.confidence || 0.95,
        status: res.status || 'ok',
        model: res.realUsage?.modelUsed || res.model || '',
        provider: res.provider || (isOllama ? 'ollama' : 'gemini'),
        source: res.source || (isOllama ? 'ollama_fallback' : 'cloud'),
        isOllama: isOllama,
        timestamp: Date.now()
      };

      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ lastRecordedAnswer: lastAnswer });
        }
      } catch (_) {}

      if (notif) {
        notif.showAnswer(lastAnswer);
      }
    } catch (err) {
      const isContextInv = err.message && (err.message.includes('context invalidated') || err.message.includes('Extension context'));
      if (isContextInv) {
        console.warn('[Moodle AI] Screenshot solve error: Extension context invalidated. Tab reload required.');
      } else {
        console.error('[Moodle AI] Screenshot solve error:', err.message);
      }
      if (notif) notif.showError(isContextInv ? 'Please refresh this page (Cmd+R or F5)' : (err.message || 'Vision solve failed'));
    }
  }

  /**
   * Execute Shortcut 3: Shift + A — Show the Last Answer Again
   */
  async function showLastAnswerAgain() {
    const notif = getNotification();
    if (!notif) return;

    if (!isExtensionContextValid()) {
      notif.showError('Please refresh this page (Cmd+R or F5)');
      return;
    }

    let answerObj = lastAnswer;
    if (!answerObj || (!answerObj.answer && !answerObj.option)) {
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          const st = await chrome.storage.local.get(['lastRecordedAnswer']);
          if (st.lastRecordedAnswer && (st.lastRecordedAnswer.answer || st.lastRecordedAnswer.option)) {
            answerObj = st.lastRecordedAnswer;
            lastAnswer = answerObj;
          }
        }
      } catch (_) {}
    }

    if (answerObj && (answerObj.answer || answerObj.option)) {
      notif.showAnswer(answerObj);
    } else {
      notif.showStatus('Quick AI — No previous answer recorded yet');
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

  let lastShortcutEventTime = 0;

  /**
   * Attach keyboard shortcuts on window (Shift+Z, Shift+X, Shift+A)
   */
  function attachKeyboardShortcuts() {
    if (activeKeydownListener) {
      window.removeEventListener('keydown', activeKeydownListener, true);
    }

    activeKeydownListener = (e) => {
      if (!e.shiftKey) return;
      if (isTypingInField(e.target)) {
        const sel = window.getSelection();
        const hasSelection = sel && !sel.isCollapsed && sel.toString().trim().length > 0;
        const inQuiz = Boolean(e.target.closest && e.target.closest('.que, .question, [data-question-id], [class*="quiz" i]'));
        if (!hasSelection && !inQuiz) return;
      }

      const key = (e.key || '').toUpperCase();
      const code = (e.code || '');

      const isZ = (key === 'Z' || code === 'KeyZ');
      const isX = (key === 'X' || code === 'KeyX');
      const isA = (key === 'A' || code === 'KeyA');

      if (!isZ && !isX && !isA) return;

      console.log('[Moodle AI] SHORTCUT_RECEIVED:', {
        key,
        code,
        isZ,
        isX,
        isA,
        isTopFrame: window === window.top
      });

      console.log('[Moodle AI Diagnostic 1/14] Shortcut event received:', { key, code, isZ, isX, isA });
      console.log('[Moodle AI Diagnostic 2/14] Active frame identified:', {
        isTopFrame: window === window.top,
        hasFocus: typeof document.hasFocus === 'function' ? document.hasFocus() : true
      });

      // Global debounce to prevent duplicate events between frame DOM listeners and background commands
      const now = Date.now();
      if (now - lastShortcutEventTime < 350) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      lastShortcutEventTime = now;

      e.preventDefault();
      e.stopPropagation();

      // Proactively verify extension context before calling background
      if (!isExtensionContextValid()) {
        const notif = getNotification();
        if (notif) {
          notif.showError('Please refresh this page (Cmd+R or F5)');
        }
        return;
      }

      if (isZ) {
        solveCurrentQuestion();
      } else if (isX) {
        solveQuestionScreenshot('', true);
      } else if (isA) {
        showLastAnswerAgain();
      }
    };

    window.addEventListener('keydown', activeKeydownListener, true);
  }

  /**
   * Listen for messages from background script & popup
   */
  function attachMessageListener() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      // If message is restricted to top frame only and this is a child frame, ignore
      if (message.topFrameOnly && window !== window.top) {
        sendResponse({ success: true, skippedChildFrame: true });
        return true;
      }

      const now = Date.now();

      if (message.action === 'TRIGGER_SOLVE_QUESTION') {
        console.log('[Moodle AI] SHORTCUT_RECEIVED:', { action: message.action, isTopFrame: window === window.top });
        if (now - lastShortcutEventTime < 450) {
          sendResponse({ success: true, debounced: true });
          return true;
        }
        lastShortcutEventTime = now;
        solveCurrentQuestion();
        sendResponse({ success: true });
        return true;
      }

      if (message.action === 'TRIGGER_SOLVE_SCREENSHOT') {
        console.log('[Moodle AI] SHORTCUT_RECEIVED:', { action: message.action, isTopFrame: window === window.top });
        if (now - lastShortcutEventTime < 450) {
          sendResponse({ success: true, debounced: true });
          return true;
        }
        lastShortcutEventTime = now;
        solveQuestionScreenshot('', true);
        sendResponse({ success: true });
        return true;
      }

      if (message.action === 'TRIGGER_SHOW_LAST_ANSWER') {
        console.log('[Moodle AI] SHORTCUT_RECEIVED:', { action: message.action, isTopFrame: window === window.top });
        if (now - lastShortcutEventTime < 450) {
          sendResponse({ success: true, debounced: true });
          return true;
        }
        lastShortcutEventTime = now;
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
    cleanMoodleJunk,
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
