import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { classifyOllamaQuestion, verifyAndNormalizeAnswer } from '../services/ollama-service.js';

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
  const fakeChrome = {
    runtime: {
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: { addListener: () => {} },
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
        set: async (items) => { Object.assign(storageData, items); }
      }
    },
    tabs: { captureVisibleTab: () => {}, sendMessage: () => {} },
    commands: { onCommand: { addListener: () => {} } }
  };

  const sandbox = {
    chrome: fakeChrome,
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {} },
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
  return { normalizeAnswerPayload: sandbox.normalizeAnswerPayload, context };
}

function setupNotificationDOM() {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', { runScripts: 'dangerously' });
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

// 1. Single-choice question returns one correct answer
test('Master Test 1: Single-choice question returns exactly one correct answer', () => {
  const payload = {
    question: 'Which of the following is the capital of Japan?',
    options: [
      { id: 'A', text: 'Kyoto' },
      { id: 'B', text: 'Tokyo' },
      { id: 'C', text: 'Osaka' },
      { id: 'D', text: 'Nagoya' }
    ]
  };
  const parsed = {
    question_type: 'single',
    option: 'B',
    options: ['B'],
    answer: 'Tokyo',
    reason: 'Tokyo is the current capital of Japan.',
    isMultiple: false
  };
  const result = verifyAndNormalizeAnswer(parsed, payload, 'Geography');
  assert.equal(result.isMultiple, false);
  assert.equal(result.option, 'B');
  assert.deepEqual(result.options, ['B']);
  assert.equal(result.answer, 'Tokyo');
});

// 2. Two correct options are both returned
test('Master Test 2: Two correct options are both returned', () => {
  const payload = {
    question: 'Select all prime numbers below 10.',
    options: [
      { id: 'A', text: '2' },
      { id: 'B', text: '4' },
      { id: 'C', text: '3' },
      { id: 'D', text: '9' }
    ]
  };
  const parsed = {
    question_type: 'multiple',
    option: 'A, C',
    options: ['A', 'C'],
    reason: '2 and 3 are prime numbers.',
    isMultiple: true
  };
  const result = verifyAndNormalizeAnswer(parsed, payload, 'Mathematics');
  assert.equal(result.isMultiple, true);
  assert.equal(result.option, 'A, C');
  assert.deepEqual(result.options, ['A', 'C']);
  assert.ok(result.answer.includes('A — 2'));
  assert.ok(result.answer.includes('C — 3'));
});

// 3. Three correct options A, B and D are all returned
test('Master Test 3: Three correct options A, B and D are all returned (SRS Example)', () => {
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
    question_type: 'multiple',
    option: 'A, B, D',
    options: ['A', 'B', 'D'],
    reason: '- A: Clear interpretation.\n- B: All requirements included.\n- D: Must be testable.',
    isMultiple: true
  };
  const result = verifyAndNormalizeAnswer(parsed, payload, 'Software Engineering');
  assert.equal(result.isMultiple, true);
  assert.equal(result.option, 'A, B, D');
  assert.deepEqual(result.options, ['A', 'B', 'D']);
  assert.ok(result.answer.includes('A — Unambiguous requirements'));
  assert.ok(result.answer.includes('B — Complete requirements'));
  assert.ok(!result.answer.includes('C — Contradictory requirements'));
  assert.ok(result.answer.includes('D — Verifiable requirements'));
});

// 4. Four correct options are preserved
test('Master Test 4: Four correct options are preserved without truncation', () => {
  const payload = {
    question: 'Which of the following are valid HTTP methods?',
    options: [
      { id: 'A', text: 'GET' },
      { id: 'B', text: 'POST' },
      { id: 'C', text: 'PUT' },
      { id: 'D', text: 'DELETE' }
    ]
  };
  const parsed = {
    question_type: 'multiple',
    option: 'A, B, C, D',
    options: ['A', 'B', 'C', 'D'],
    reason: 'All four are standard HTTP/1.1 request methods.',
    isMultiple: true
  };
  const result = verifyAndNormalizeAnswer(parsed, payload, 'Networking');
  assert.equal(result.isMultiple, true);
  assert.equal(result.option, 'A, B, C, D');
  assert.deepEqual(result.options, ['A', 'B', 'C', 'D']);
});

// 5. Questions with 8-10 options work correctly
test('Master Test 5: Questions with 8-10 options work correctly (options A-J)', () => {
  const options = [
    { id: 'A', text: 'Algorithm A' },
    { id: 'B', text: 'Algorithm B' },
    { id: 'C', text: 'Algorithm C' },
    { id: 'D', text: 'Algorithm D' },
    { id: 'E', text: 'Algorithm E' },
    { id: 'F', text: 'Algorithm F' },
    { id: 'G', text: 'Algorithm G' },
    { id: 'H', text: 'Algorithm H' },
    { id: 'I', text: 'Algorithm I' },
    { id: 'J', text: 'Algorithm J' }
  ];
  const payload = {
    question: 'Select all algorithms that run in O(n log n) average time:',
    options
  };
  const parsed = {
    question_type: 'multiple',
    option: 'B, D, G, J',
    options: ['B', 'D', 'G', 'J'],
    reason: 'Algorithms B, D, G, J run in O(n log n) time.',
    isMultiple: true
  };
  const result = verifyAndNormalizeAnswer(parsed, payload, 'Algorithms');
  assert.equal(result.isMultiple, true);
  assert.equal(result.option, 'B, D, G, J');
  assert.deepEqual(result.options, ['B', 'D', 'G', 'J']);
  assert.ok(result.answer.includes('B — Algorithm B'));
  assert.ok(result.answer.includes('J — Algorithm J'));
});

// 6. Multiple-answer wording is classified correctly
test('Master Test 6: Multiple-answer wording is classified correctly as MULTIPLE_CHOICE', () => {
  assert.equal(classifyOllamaQuestion('Which are characteristics of a good SRS?'), 'MULTIPLE_CHOICE');
  assert.equal(classifyOllamaQuestion('Select all prime numbers below 10.'), 'MULTIPLE_CHOICE');
  assert.equal(classifyOllamaQuestion('Which of the following are valid protocols?'), 'MULTIPLE_CHOICE');
  assert.equal(classifyOllamaQuestion('Choose all that apply from the list below:'), 'MULTIPLE_CHOICE');
  assert.equal(classifyOllamaQuestion('Random text', [], 'single_choice', true), 'MULTIPLE_CHOICE', 'Checkboxes must force MULTIPLE_CHOICE');
});

// 7. Single-answer wording is classified correctly
test('Master Test 7: Single-answer wording is classified correctly as SINGLE_CHOICE', () => {
  const options = [{ id: 'A', text: 'Opt 1' }, { id: 'B', text: 'Opt 2' }];
  assert.equal(classifyOllamaQuestion('Which of the following is the primary key?', options), 'SINGLE_CHOICE');
  assert.equal(classifyOllamaQuestion('Which is the highest normal form?', options), 'SINGLE_CHOICE');
  assert.equal(classifyOllamaQuestion('Select the single best answer for time complexity:', options), 'SINGLE_CHOICE');
});

// 8. Ambiguous wording is handled safely
test('Master Test 8: Ambiguous wording without options resolves to UNKNOWN or OPEN_ENDED', () => {
  assert.equal(classifyOllamaQuestion('', []), 'UNKNOWN');
  assert.equal(classifyOllamaQuestion('Calculate 15 + 27', []), 'OPEN_ENDED');
});

// 9. Streaming does not lose earlier options
test('Master Test 12: Streaming / partial output does not truncate multiple answers', () => {
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
    option: 'A',
    options: ['A', 'B', 'D'],
    answer: 'Unambiguous requirements',
    reason: 'Requirements must be unambiguous, complete, and verifiable.',
    isMultiple: true
  };
  const result = normalizeAnswerPayload(parsed, payload, 'gemma3:4b', 'ollama');
  assert.equal(result.isMultiple, true);
  assert.equal(JSON.stringify(result.options), JSON.stringify(['A', 'B', 'D']));
  assert.equal(result.option, 'A, B, D');
  assert.ok(result.answer.includes('A — Unambiguous requirements'));
  assert.ok(result.answer.includes('B — Complete requirements'));
  assert.ok(result.answer.includes('D — Verifiable requirements'));
});

// 10. Malformed responses are handled safely
test('Master Test 14: Malformed response is safely normalized with available candidate letters', () => {
  const payload = {
    question: 'Which are characteristics of a good SRS?',
    options: [
      { id: 'A', text: 'Unambiguous' },
      { id: 'B', text: 'Complete' },
      { id: 'C', text: 'Contradictory' },
      { id: 'D', text: 'Verifiable' }
    ]
  };
  // Malformed: option is missing, but reason specifies Options A, B, and D
  const parsed = {
    reason: 'Option A, option B and option D are correct characteristics.',
    isMultiple: true
  };
  const result = verifyAndNormalizeAnswer(parsed, payload, 'SE');
  assert.equal(result.isMultiple, true);
  assert.equal(JSON.stringify(result.options), JSON.stringify(['A', 'B', 'D']));
  assert.equal(result.option, 'A, B, D');
});

// 11. Popup displays every correct option & Shift+A replays it
test('Master Test 15 & 16: Popup displays every correct option and Shift+A replays with Ollama badge', () => {
  const dom = setupNotificationDOM();
  const notifier = new dom.window.MoodleQuickNotification();

  const multiPayload = {
    option: 'A, B, D',
    options: ['A', 'B', 'D'],
    optionIds: ['A', 'B', 'D'],
    answer: 'A — Unambiguous requirements\nB — Complete requirements\nD — Verifiable requirements',
    reason: '- A: Clear\n- B: Complete\n- D: Verifiable',
    isMultiple: true,
    isOllama: true,
    provider: 'ollama',
    fallbackNotice: 'Gemini unavailable — answered using Ollama 🦙'
  };

  notifier.showAnswer(multiPayload);
  const shadow = dom.window.document.getElementById('moodle-quick-notify-host').shadowRoot;
  const box = shadow.querySelector('.quick-notify-box');
  const answerText = box.querySelector('.answer-text').textContent;

  assert.ok(answerText.includes('MULTIPLE ANSWER'));
  assert.ok(answerText.includes('A — Unambiguous requirements'));
  assert.ok(answerText.includes('B — Complete requirements'));
  assert.ok(answerText.includes('D — Verifiable requirements'));
  assert.ok(box.querySelector('.ollama-badge'), 'Must display 🦙 badge');

  // Replay via Shift + A
  const replayed = { ...multiPayload, cached: true };
  notifier.showAnswer(replayed);
  const replayedText = shadow.querySelector('.answer-text').textContent;
  assert.ok(replayedText.includes('MULTIPLE ANSWER'));
  assert.ok(replayedText.includes('D — Verifiable requirements'));
  assert.ok(shadow.querySelector('.ollama-badge'));
});

// 12. Correct answer is B: must return B and NOT default to A
test('Master Test 17: When correct answer is B, returns B and does NOT default to A', () => {
  const { normalizeAnswerPayload } = setupBackgroundSandbox();
  const payload = {
    question: 'Which data structure operates on a Last In, First Out (LIFO) basis?',
    options: [
      { id: 'A', text: 'Queue' },
      { id: 'B', text: 'Stack' },
      { id: 'C', text: 'Binary Search Tree' },
      { id: 'D', text: 'Array' }
    ]
  };
  const parsed = {
    question_type: 'single',
    option: 'B',
    // Simulating small model returning all options in options key
    options: ['A', 'B', 'C', 'D'],
    answer: 'Stack',
    reason: 'Stacks use LIFO ordering while queues use FIFO.',
    isMultiple: false
  };
  const result = normalizeAnswerPayload(parsed, payload, 'gemma3:4b', 'ollama');
  assert.equal(result.isMultiple, false);
  assert.equal(result.option, 'B', 'Must return B, not A');
  assert.equal(result.answer, 'Stack', 'Must return Stack, not Queue');
});

// 13. Correct answer is C: must return C and NOT default to A
test('Master Test 18: When correct answer is C, returns C and does NOT default to A', () => {
  const payload = {
    question: 'Which normal form eliminates transitive dependency?',
    options: [
      { id: 'A', text: '1NF' },
      { id: 'B', text: '2NF' },
      { id: 'C', text: '3NF' },
      { id: 'D', text: 'BCNF' }
    ]
  };
  const parsed = {
    question_type: 'single',
    option: 'C',
    options: ['A', 'B', 'C', 'D'],
    answer: '3NF',
    reason: 'Third Normal Form removes transitive dependencies.',
    isMultiple: false
  };
  const result = verifyAndNormalizeAnswer(parsed, payload, 'DBMS');
  assert.equal(result.isMultiple, false);
  assert.equal(result.option, 'C', 'Must return C');
  assert.equal(result.answer, '3NF', 'Must return 3NF');
});

// 14. Correct answer is D: must return D and NOT default to A
test('Master Test 19: When correct answer is D, returns D and does NOT default to A', () => {
  const payload = {
    question: 'Which Boolean logic gate cannot be implemented by a single-layer perceptron?',
    options: [
      { id: 'A', text: 'AND' },
      { id: 'B', text: 'OR' },
      { id: 'C', text: 'NAND' },
      { id: 'D', text: 'XOR' }
    ]
  };
  const parsed = {
    question_type: 'single',
    option: 'D',
    answer: 'XOR',
    reason: 'XOR is not linearly separable.',
    isMultiple: false
  };
  const result = verifyAndNormalizeAnswer(parsed, payload, 'AI');
  assert.equal(result.isMultiple, false);
  assert.equal(result.option, 'D', 'Must return D');
  assert.equal(result.answer, 'XOR', 'Must return XOR');
});

// 15. Numeric option "2" maps to B
test('Master Test 20: Numeric option "2" maps accurately to option B', () => {
  const payload = {
    question: 'What is 10 / 2?',
    options: [
      { id: 'A', text: '3' },
      { id: 'B', text: '5' },
      { id: 'C', text: '7' },
      { id: 'D', text: '9' }
    ]
  };
  const parsed = {
    question_type: 'single',
    option: '2',
    answer: '5',
    isMultiple: false
  };
  const result = verifyAndNormalizeAnswer(parsed, payload, 'Math');
  assert.equal(result.option, 'B', 'Option 2 must map to B');
  assert.equal(result.answer, '5', 'Answer text must be 5');
});

// 16. Multiple-correct B and D: preserves both without distractor A
test('Master Test 21: Multiple-correct B and D preserves B and D without inserting distractor A', () => {
  const payload = {
    question: 'Which of the following are non-linear data structures?',
    options: [
      { id: 'A', text: 'Array' },
      { id: 'B', text: 'Tree' },
      { id: 'C', text: 'Linked List' },
      { id: 'D', text: 'Graph' }
    ]
  };
  const parsed = {
    question_type: 'multiple',
    option: 'B, D',
    options: ['B', 'D'],
    answer: 'Tree and Graph',
    isMultiple: true
  };
  const result = verifyAndNormalizeAnswer(parsed, payload, 'Data Structures');
  assert.equal(result.isMultiple, true);
  assert.equal(result.option, 'B, D');
  assert.deepEqual(result.options, ['B', 'D']);
  assert.ok(result.answer.includes('B — Tree'));
  assert.ok(result.answer.includes('D — Graph'));
  assert.ok(!result.answer.includes('A — Array'), 'Must not include distractor A');
});

