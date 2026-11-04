import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backgroundScriptPath = path.resolve(__dirname, '../../extension/background.js');
const notificationScriptPath = path.resolve(__dirname, '../../extension/notification.js');
const contentScriptPath = path.resolve(__dirname, '../../extension/moodle-content.js');

const backgroundCode = fs.readFileSync(backgroundScriptPath, 'utf8');
const notificationCode = fs.readFileSync(notificationScriptPath, 'utf8');
const contentScriptCode = fs.readFileSync(contentScriptPath, 'utf8');

function setupBackgroundSandbox(initialStorage = {}) {
  const storageData = { ...initialStorage };
  const messageListeners = [];

  const fakeChrome = {
    runtime: {
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: {
        addListener: (fn) => messageListeners.push(fn)
      },
      lastError: null,
      sendMessage: () => {}
    },
    storage: {
      local: {
        get: async (keys) => {
          if (!keys) return { ...storageData };
          if (typeof keys === 'string') return { [keys]: storageData[keys] };
          if (Array.isArray(keys)) {
            const res = {};
            keys.forEach(k => { if (storageData[k] !== undefined) res[k] = storageData[k]; });
            return res;
          }
          return { ...storageData };
        },
        set: async (items) => {
          Object.assign(storageData, items);
        }
      }
    },
    tabs: {
      captureVisibleTab: () => {},
      sendMessage: () => {}
    },
    commands: {
      onCommand: { addListener: () => {} }
    }
  };

  const sandbox = {
    chrome: fakeChrome,
    console: {
      log: () => {},
      warn: () => {},
      error: () => {},
      info: () => {}
    },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},
    performance: { now: () => Date.now() },
    AbortController: globalThis.AbortController,
    AbortSignal: globalThis.AbortSignal,
    TextDecoder: globalThis.TextDecoder
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(backgroundCode, context);

  return {
    normalizeAnswerPayload: sandbox.normalizeAnswerPayload,
    extractCandidateLetters: sandbox.extractCandidateLetters,
    context
  };
}

function setupNotificationDOM() {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    runScripts: 'dangerously'
  });
  dom.window.chrome = {
    storage: {
      local: {
        get: () => Promise.resolve({ answerPopupAppearance: {} }),
        set: () => Promise.resolve()
      }
    }
  };
  dom.window.eval(notificationCode);
  return dom;
}

test('Test Case 1: Single correct answer returns only one option and isMultiple=false', () => {
  const { normalizeAnswerPayload } = setupBackgroundSandbox();

  const payload = {
    question: 'What is the capital city of France?',
    options: [
      { id: 'A', text: 'Paris' },
      { id: 'B', text: 'Berlin' },
      { id: 'C', text: 'Madrid' },
      { id: 'D', text: 'Rome' }
    ]
  };

  const parsed = {
    option: 'A',
    options: ['A'],
    answer: 'Paris',
    reason: 'Paris is the capital of France.',
    isMultiple: false
  };

  const result = normalizeAnswerPayload(parsed, payload, 'gemma3:4b', 'ollama');

  assert.equal(result.isMultiple, false, 'Should be flagged as single answer');
  assert.equal(result.option, 'A', 'Option should be single letter A');
  assert.equal(JSON.stringify(result.options), JSON.stringify(['A']), 'Options array should contain only A');
  assert.equal(result.answer, 'Paris', 'Answer text should be single option text');
});

test('Test Case 2: Two correct answers (A, C) preserves both option labels and full text', () => {
  const { normalizeAnswerPayload } = setupBackgroundSandbox();

  const payload = {
    question: 'Select all prime numbers below 10.',
    options: [
      { id: 'A', text: '2' },
      { id: 'B', text: '4' },
      { id: 'C', text: '3' },
      { id: 'D', text: '9' }
    ],
    isMultiple: true
  };

  const parsed = {
    option: 'A, C',
    options: ['A', 'C'],
    reason: '- A: 2 is the smallest prime number\n- C: 3 is a prime number',
    isMultiple: true
  };

  const result = normalizeAnswerPayload(parsed, payload, 'gemini-2.5-flash', 'gemini');

  assert.equal(result.isMultiple, true, 'Should be flagged as multiple answer');
  assert.equal(result.option, 'A, C', 'Option should be comma-separated A, C');
  assert.equal(JSON.stringify(result.optionIds), JSON.stringify(['A', 'C']), 'Option IDs should include A and C');
  assert.ok(result.answer.includes('A — 2'), 'Must include Option A and its text');
  assert.ok(result.answer.includes('C — 3'), 'Must include Option C and its text');
  assert.ok(result.explanation.includes('MULTIPLE ANSWER'), 'Explanation must include MULTIPLE ANSWER header');
});

test('Test Case 3: Three correct answers (A, B, D) - SRS Question from User Prompt', () => {
  const { normalizeAnswerPayload } = setupBackgroundSandbox();

  const payload = {
    question: 'Which are characteristics of a good SRS?',
    options: [
      { id: 'A', text: 'Unambiguous requirements' },
      { id: 'B', text: 'Complete requirements' },
      { id: 'C', text: 'Contradictory requirements' },
      { id: 'D', text: 'Verifiable requirements' }
    ]
  };

  const parsed = {
    option: 'A, B, D',
    options: ['A', 'B', 'D'],
    reason: '- A: Requirements must have only one clear interpretation.\n- B: All necessary requirements must be included.\n- D: Requirements must be testable or verifiable.',
    isMultiple: true
  };

  const result = normalizeAnswerPayload(parsed, payload, 'gemma3:4b', 'ollama');

  assert.equal(result.isMultiple, true, 'Must detect multiple-answer from "Which are" wording');
  assert.equal(result.option, 'A, B, D');
  assert.equal(JSON.stringify(result.optionIds), JSON.stringify(['A', 'B', 'D']));
  assert.ok(result.answer.includes('A — Unambiguous requirements'));
  assert.ok(result.answer.includes('B — Complete requirements'));
  assert.ok(!result.answer.includes('C — Contradictory requirements'), 'Distractor C must NOT be selected');
  assert.ok(result.answer.includes('D — Verifiable requirements'));
  assert.ok(result.explanation.includes('MULTIPLE ANSWER'));
});

test('Test Case 4: Four correct answers (A, B, C, D) are all preserved without truncation', () => {
  const { normalizeAnswerPayload } = setupBackgroundSandbox();

  const payload = {
    question: 'Which of the following are valid HTTP methods?',
    options: [
      { id: 'A', text: 'GET' },
      { id: 'B', text: 'POST' },
      { id: 'C', text: 'PUT' },
      { id: 'D', text: 'DELETE' }
    ],
    isMultiple: true
  };

  const parsed = {
    options: ['A', 'B', 'C', 'D'],
    option: 'A, B, C, D',
    reason: 'All four are standard HTTP/1.1 methods.',
    isMultiple: true
  };

  const result = normalizeAnswerPayload(parsed, payload, 'gpt-4o-mini', 'openai');

  assert.equal(result.isMultiple, true);
  assert.equal(result.optionIds.length, 4);
  assert.equal(JSON.stringify(result.optionIds), JSON.stringify(['A', 'B', 'C', 'D']));
  assert.ok(result.answer.includes('A — GET'));
  assert.ok(result.answer.includes('B — POST'));
  assert.ok(result.answer.includes('C — PUT'));
  assert.ok(result.answer.includes('D — DELETE'));
});

test('Test Case 5: Multiple-answer question with 8-10 options preserves all correct labels', () => {
  const { normalizeAnswerPayload } = setupBackgroundSandbox();

  const options = [
    { id: 'A', text: 'Python' },
    { id: 'B', text: 'HTML' },
    { id: 'C', text: 'Java' },
    { id: 'D', text: 'CSS' },
    { id: 'E', text: 'C++' },
    { id: 'F', text: 'SQL' },
    { id: 'G', text: 'Rust' },
    { id: 'H', text: 'Markdown' },
    { id: 'I', text: 'JSON' },
    { id: 'J', text: 'Go' }
  ];

  const payload = {
    question: 'Select all general-purpose programming languages from the list below:',
    options,
    isMultiple: true
  };

  const parsed = {
    options: ['A', 'C', 'E', 'G', 'J'],
    option: 'A, C, E, G, J',
    reason: 'Python, Java, C++, Rust, and Go are Turing-complete programming languages.',
    isMultiple: true
  };

  const result = normalizeAnswerPayload(parsed, payload, 'gemma3:4b', 'ollama');

  assert.equal(result.isMultiple, true);
  assert.equal(JSON.stringify(result.optionIds), JSON.stringify(['A', 'C', 'E', 'G', 'J']));
  assert.ok(result.answer.includes('A — Python'));
  assert.ok(result.answer.includes('C — Java'));
  assert.ok(result.answer.includes('E — C++'));
  assert.ok(result.answer.includes('G — Rust'));
  assert.ok(result.answer.includes('J — Go'));
  assert.ok(!result.answer.includes('B — HTML'), 'Non-programming language B excluded');
  assert.ok(!result.answer.includes('D — CSS'), 'Non-programming language D excluded');
});

test('Test Case 6: Screenshot-based vision MCQ with multiple answers preserves all options', () => {
  const { normalizeAnswerPayload } = setupBackgroundSandbox();

  const payload = {
    question: 'Identify all highlighted angles that are acute (< 90 degrees):',
    options: [
      { id: 'A', text: 'Angle Alpha (45 deg)' },
      { id: 'B', text: 'Angle Beta (120 deg)' },
      { id: 'C', text: 'Angle Gamma (60 deg)' },
      { id: 'D', text: 'Angle Delta (90 deg)' }
    ],
    questionType: 'vision',
    isMultiple: true
  };

  const parsed = {
    option: 'A, C',
    options: ['A', 'C'],
    reason: 'Angles Alpha (45) and Gamma (60) are both less than 90 degrees.',
    isMultiple: true
  };

  const result = normalizeAnswerPayload(parsed, payload, 'gemini-2.5-flash', 'gemini');

  assert.equal(result.isMultiple, true);
  assert.equal(JSON.stringify(result.optionIds), JSON.stringify(['A', 'C']));
  assert.ok(result.answer.includes('A — Angle Alpha'));
  assert.ok(result.answer.includes('C — Angle Gamma'));
});

test('Test Case 7: Streaming response with "A, B and D" parses all options safely', () => {
  const { normalizeAnswerPayload } = setupBackgroundSandbox();

  const payload = {
    question: 'Which are characteristics of a good SRS?',
    options: [
      { id: 'A', text: 'Unambiguous requirements' },
      { id: 'B', text: 'Complete requirements' },
      { id: 'C', text: 'Contradictory requirements' },
      { id: 'D', text: 'Verifiable requirements' }
    ]
  };

  // Simulates a streaming AI that generated "A, B and D"
  const parsed = {
    option: 'A, B and D',
    answer: 'A, B, D are valid characteristics',
    reason: 'SRS requirements must be clear, complete and verifiable.',
    isMultiple: true
  };

  const result = normalizeAnswerPayload(parsed, payload, 'gemma3:4b', 'ollama');

  assert.equal(result.isMultiple, true);
  assert.equal(JSON.stringify(result.optionIds), JSON.stringify(['A', 'B', 'D']));
  assert.equal(result.option, 'A, B, D');
});

test('Test Case 8: Notification Popup correctly renders multiple answers and supports Shift+A replay', () => {
  const dom = setupNotificationDOM();
  const notifier = new dom.window.MoodleQuickNotification();

  const multiPayload = {
    option: 'A, B, D',
    optionIds: ['A', 'B', 'D'],
    answer: 'A — Unambiguous requirements\nB — Complete requirements\nD — Verifiable requirements',
    reason: '- A: Clear interpretation.\n- B: Complete coverage.\n- D: Verifiable testing.',
    isMultiple: true,
    isOllama: true
  };

  notifier.showAnswer(multiPayload);

  const shadow = dom.window.document.getElementById('moodle-quick-notify-host').shadowRoot;
  const box = shadow.querySelector('.quick-notify-box');
  const answerText = box.querySelector('.answer-text').textContent;

  assert.ok(answerText.includes('MULTIPLE ANSWER'), 'Popup header must display MULTIPLE ANSWER');
  assert.ok(answerText.includes('A — Unambiguous requirements'), 'Must display Option A');
  assert.ok(answerText.includes('B — Complete requirements'), 'Must display Option B');
  assert.ok(answerText.includes('D — Verifiable requirements'), 'Must display Option D');

  // Verify Toggle to Expanded Explanation
  notifier.toggleExpanded();
  const explDiv = shadow.querySelector('.answer-explanation');
  assert.ok(explDiv, 'Explanation block must be rendered when expanded');
  assert.ok(explDiv.textContent.includes('Explanation:'), 'Explanation text must be present');
  assert.ok(explDiv.textContent.includes('Clear interpretation'), 'Option explanation must be present');

  // Verify Replay via Shift + A with cached payload
  const replayedPayload = { ...multiPayload, cached: true };
  notifier.showAnswer(replayedPayload);
  const replayedText = shadow.querySelector('.answer-text').textContent;
  assert.ok(replayedText.includes('MULTIPLE ANSWER'), 'Replayed cached answer must preserve MULTIPLE ANSWER');
  assert.ok(replayedText.includes('D — Verifiable requirements'), 'Replayed cached answer must preserve all options');
});
