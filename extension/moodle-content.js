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

  // Concurrency & Debounce controls
  let activeAbortController = null;
  let lastProcessedQuestionHash = null;
  let lastSolveRequestTime = 0;
  let currentRequestId = 0;
  const DEBOUNCE_MS = 250;

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
   * Extract question and options directly from user's highlighted text selection ONLY
   */
  function extractFromSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return null;

    const rawText = selection.toString().trim();
    if (!rawText || rawText.length < 2) return null;

    const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);

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
   * Helper to determine if an element is genuinely visible on page
   */
  function isElementVisible(el) {
    if (!el || !(el instanceof HTMLElement)) return false;
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;

    if (typeof window.getComputedStyle === 'function') {
      try {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
          return false;
        }
      } catch (e) {}
    }

    const isJSDOM = typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent || '');
    if (!isJSDOM) {
      if (el.offsetParent === null && el.style.position !== 'fixed' && el.style.position !== 'sticky') {
        return false;
      }
      const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (rect && rect.width <= 0 && rect.height <= 0) {
        return false;
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

    // Must have radio/checkbox inputs or option items
    const inputs = el.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]');
    if (inputs.length >= 2) return true;

    const optionEls = el.querySelectorAll('[class*="optionContainer" i], [class*="option-item" i], [class*="optionItem" i], [class*="choice" i], [class*="answer" i], li');
    const textOptions = Array.from(optionEls).filter(o => o.textContent.trim().length > 0 && o.textContent.trim().length < 300);
    if (textOptions.length >= 2) return true;

    // Has question prompt and option text
    const text = el.textContent.trim();
    if (text.length >= 20 && (/^(?:(?:\([A-Da-d]\))|[A-Da-d][\.\:\)])/m.test(text))) {
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
      '[class*="bix-div-container" i]'
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

    // Exclude icons, avatars, flags, decorative images
    if (el.classList.contains('icon') || el.classList.contains('userpicture') || el.classList.contains('activityicon') || el.classList.contains('smallicon')) {
      return false;
    }
    if (el.getAttribute('role') === 'presentation' || el.getAttribute('aria-hidden') === 'true') {
      return false;
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
    const qtextElem = questionEl.querySelector('[class*="quizQuestionTextContainer" i] [class*="question" i]') ||
                      questionEl.querySelector('[class*="quizQuestionTextContainer" i]') ||
                      questionEl.querySelector('.qtext') ||
                      questionEl.querySelector('.formulation .qtext') ||
                      questionEl.querySelector('.formulation') ||
                      questionEl.querySelector('.q-title, h1, h2, h3, h4, h5, h6, legend, [class*="question-text" i], [class*="prompt" i], p');

    if (qtextElem) {
      const clone = qtextElem.cloneNode(true);
      clone.querySelectorAll('.answer, input, .prompt, .options-group, .info, .state, .grade').forEach(el => el.remove());
      questionText = extractFormattedText(clone);
    }

    // Filter out Moodle question numbers / headers like "Question 1", "Not yet answered"
    if (/^Question\s*\d*[\.\:]?$/i.test(questionText.trim()) || /^Not yet answered/i.test(questionText.trim())) {
      questionText = '';
    }

    if (!questionText || questionText.length < 3) {
      const cloneQ = questionEl.cloneNode(true);
      cloneQ.querySelectorAll('.answer, input, .prompt, .options-group, .info, .state, .grade, .outcome, .feedback').forEach(el => el.remove());
      const allText = extractFormattedText(cloneQ);
      const lines = allText.split('\n').map(l => l.trim()).filter(l => Boolean(l) && !/^Question\s*\d*[\.\:]?$/i.test(l) && !/^Not yet answered/i.test(l));
      const firstOptIdx = lines.findIndex(l => /^(?:[A-Za-z][\.\:\)\-]|(?:\([A-Za-z0-9]\))|\d+[\.\:\)\-])\s+/i.test(l));
      if (firstOptIdx > 0) {
        questionText = lines.slice(0, firstOptIdx).join(' ');
      } else if (lines.length > 0) {
        const qLine = lines.find(l => /^\d+[\.\:\)]/.test(l) || l.endsWith('?')) || lines[0] || '';
        questionText = qLine;
      }
    }

    if (/^Question\s*\d*[\.\:]?$/i.test(questionText.trim()) || /^Not yet answered/i.test(questionText.trim())) {
      questionText = '';
    }

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
      const candidates = Array.from(questionEl.querySelectorAll('label, [class*="optionItem" i], [class*="option-item" i], [class*="optionContainer" i], [class*="option" i], [class*="choice" i], [class*="answer" i], li')).filter(el => {
        if (el.matches('h1, h2, h3, h4, h5, h6, legend, [class*="title" i], [class*="prompt" i], [class*="header" i], ul, ol')) return false;
        if (el.closest('h1, h2, h3, h4, h5, h6, legend, [class*="title" i], [class*="prompt" i], [class*="header" i]')) return false;
        const text = el.textContent.trim();
        return text.length > 0 && text.length < 250;
      });
      // Retain outermost items only (e.g. the li or optionItem wrapper, avoiding splitting innerCircle and label into separate options)
      const outermost = candidates.filter(item => !candidates.some(other => other !== item && other.contains(item)));
      if (outermost.length >= 2) {
        inputs = outermost;
      }
    }

    inputs.forEach((input, idx) => {
      let text = '';

      if (input.tagName !== 'INPUT') {
        const circle = input.querySelector('[class*="innerCircle" i], [class*="optionInput" i]');
        const label = input.querySelector('[class*="optionLabel" i]');
        if (label) {
          const labelText = extractFormattedText(label);
          const letter = circle ? circle.textContent.trim() : String.fromCharCode(65 + idx);
          text = `${letter}. ${labelText}`;
        } else {
          text = extractFormattedText(input);
        }
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
        const letterMatch = text.match(/^(?:(?:\(([A-Za-z])\))|(?:\[([A-Za-z])\])|([A-Za-z])[\.\:\)\-])\s*(.*)$/);
        if (letterMatch) {
          const letter = (letterMatch[1] || letterMatch[2] || letterMatch[3]).toUpperCase();
          const content = letterMatch[4] ? letterMatch[4].trim() : text;
          formattedText = `${letter}. ${content}`;
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
    const isDSA = /\b(time complexity|space complexity|big-o|recurrence|binary search|merge sort|quicksort|dynamic programming|dijkstra|graph|bfs|dfs|heap|tree)\b/i.test(questionText);
    const isCoding = /```|public static|def |function\(|int main/i.test(questionText) || questionEl.querySelector('pre, code') !== null;

    let questionType = 'single_choice';
    if (isImageOnly) {
      questionType = 'image_based';
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

    return {
      platform: 'moodle',
      questionNumber,
      questionType,
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

    const extractStartTime = performance.now();

    // 2. Extract question text and options
    let data = extractFromSelection();
    if (!data) {
      const questionEl = getTargetQuestionElement();
      if (questionEl) {
        data = extractQuestionData(questionEl);
      }
    }

    // 2b. Full-Page Fallback Scan for single-question pages (GeeksforGeeks, IndiaBIX, Sanfoundry, etc.)
    if (!data || (!data.question && (!data.options || data.options.length === 0) && (!data.images || data.images.length === 0))) {
      const mainEl = document.querySelector('main, article, [role="main"], [class*="mainContent" i], #content, .content, .container, body');
      if (mainEl) {
        const fallbackData = extractQuestionData(mainEl);
        if (fallbackData && (fallbackData.question || fallbackData.hasImage) && fallbackData.options && fallbackData.options.length >= 2) {
          data = fallbackData;
        }
      }
    }

    const extractionDurationMs = Math.round(performance.now() - extractStartTime);

    // 3. If no active question could be confidently detected, report error instead of guessing
    if (!data || (!data.question && (!data.options || data.options.length === 0) && (!data.images || data.images.length === 0))) {
      console.warn('[Moodle AI] Could not confidently identify active question.');
      if (notification) {
        notification.showError('UNCERTAIN — Question needs verification');
      }
      return;
    }

    // 4. Resolve all images if question is image-based or contains images
    let resolvedImages = [];
    if (data.imageElements && data.imageElements.length > 0) {
      try {
        if (notification) notification.showStatus('Decoding question image...');
        for (const el of data.imageElements) {
          const dataUrl = await convertImageElementToDataUrl(el);
          if (dataUrl) resolvedImages.push(dataUrl);
        }
      } catch (imgErr) {
        console.error('[Moodle AI] Image decoding error:', imgErr.message);
        if (notification) {
          notification.showError('Could not decode question image. Press Shift+X to snip manually.');
        }
        return;
      }
    }

    // If marked as image-based question, verify we successfully decoded at least one image
    if (data.isImageBased && resolvedImages.length === 0) {
      if (notification) {
        notification.showError('Could not decode question image. Press Shift+X to snip manually.');
      }
      return;
    }

    // 5. Duplicate request check (same question just solved)
    const currentQuestionHash = hashString((data.question || '') + (data.options || []).map(o => o.text).join('') + resolvedImages.join(''));
    if (lastAnswer && lastProcessedQuestionHash === currentQuestionHash && (now - lastSolveRequestTime < 2000)) {
      if (notification) notification.showAnswer(lastAnswer);
      return;
    }

    // Cancel / invalidate obsolete in-flight requests
    const thisRequestId = ++currentRequestId;

    if (notification) notification.showStatus(resolvedImages.length > 0 ? 'Analyzing with Vision AI...' : 'Analyzing question...');

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

      lastAnswer = {
        option: res.option || '',
        answer: res.answer || res.answerText || '',
        confidence: res.confidence,
        status: res.status || 'ok',
        latencyMs: res.latencyMs || totalClientDurationMs
      };
      lastProcessedQuestionHash = currentQuestionHash;

      if (notification) {
        notification.showAnswer(lastAnswer);
      }
    } catch (err) {
      if (thisRequestId !== currentRequestId) return;
      console.error('[Moodle AI] Solve error:', err.message);
      let errMsg = err.message || 'Failed to solve question';
      if (errMsg.includes('context invalidated')) {
        errMsg = 'Please refresh this page (Cmd+R or F5)';
      }
      if (notification) {
        notification.showError(errMsg);
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
