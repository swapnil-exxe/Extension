import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.resolve(__dirname, '../../tests/fixtures');
const notificationScriptPath = path.resolve(__dirname, '../../extension/notification.js');
const screenshotScriptPath = path.resolve(__dirname, '../../extension/screenshot-handler.js');
const contentScriptPath = path.resolve(__dirname, '../../extension/moodle-content.js');

const notificationCode = fs.readFileSync(notificationScriptPath, 'utf8');
const screenshotCode = fs.readFileSync(screenshotScriptPath, 'utf8');
const contentScriptCode = fs.readFileSync(contentScriptPath, 'utf8');

function setupDOM(htmlContent, mockAnswer = { option: 'B', answer: 'Binary Search', status: 'success' }) {
  const dom = new JSDOM(htmlContent, {
    runScripts: 'dangerously',
    url: 'http://localhost/moodle/mod/quiz/attempt.php'
  });

  // Track sent messages
  dom.window.sentMessages = [];

  // Mock chrome extension APIs in JSDOM window
  dom.window.chrome = {
    storage: {
      local: {
        get: () => Promise.resolve({ enabled: true, notificationPosition: 'top-right', notificationDuration: 1000 }),
        set: () => Promise.resolve()
      }
    },
    runtime: {
      onMessage: { addListener: () => {} },
      sendMessage: (msg) => {
        dom.window.sentMessages.push(msg);
        if (msg.action === 'CAPTURE_VISIBLE_TAB') {
          return Promise.resolve({ success: true, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' });
        }
        if (msg.action === 'ANALYZE_QUESTION') {
          return Promise.resolve({ success: true, data: mockAnswer });
        }
        return Promise.resolve({ success: true });
      }
    }
  };

  // Execute scripts in order
  dom.window.eval(notificationCode);
  dom.window.eval(screenshotCode);
  dom.window.eval(contentScriptCode);

  return dom;
}

test('Fixture 1: Single-Choice Question extraction', () => {
  const html = fs.readFileSync(path.join(fixturesDir, '1-single-choice.html'), 'utf8');
  const dom = setupDOM(html);
  const { MoodleAdapter } = dom.window;

  assert.ok(MoodleAdapter, 'MoodleAdapter must be defined');
  const containers = MoodleAdapter.getQuestionContainers();
  assert.equal(containers.length, 1);

  const data = MoodleAdapter.extractQuestionData(containers[0]);
  assert.equal(data.platform, 'moodle');
  assert.equal(data.questionType, 'single_choice');
  assert.equal(data.questionNumber, '1');
  assert.ok(data.question.includes('photosynthesis primarily take place'));
  assert.equal(data.options.length, 4);
  assert.ok(data.options.some(o => o.text.includes('Chloroplasts')));
});

test('Fixture 2: Multiple-Answer Question extraction', () => {
  const html = fs.readFileSync(path.join(fixturesDir, '2-multiple-answer.html'), 'utf8');
  const dom = setupDOM(html);
  const { MoodleAdapter } = dom.window;

  const containers = MoodleAdapter.getQuestionContainers();
  assert.equal(containers.length, 1);

  const data = MoodleAdapter.extractQuestionData(containers[0]);
  assert.equal(data.questionType, 'multiple_choice');
  assert.ok(data.question.includes('prime numbers below 10'));
  assert.equal(data.options.length, 4);
  assert.ok(data.options.some(o => o.text.includes('2')));
  assert.ok(data.options.some(o => o.text.includes('3')));
});

test('Fixture 3: True/False Question extraction', () => {
  const html = fs.readFileSync(path.join(fixturesDir, '3-true-false.html'), 'utf8');
  const dom = setupDOM(html);
  const { MoodleAdapter } = dom.window;

  const containers = MoodleAdapter.getQuestionContainers();
  assert.equal(containers.length, 1);

  const data = MoodleAdapter.extractQuestionData(containers[0]);
  assert.equal(data.questionType, 'true_false');
  assert.ok(data.question.includes('Earth revolves around the Sun'));
  assert.equal(data.options.length, 2);
  assert.ok(data.options.some(o => o.text === 'True'));
  assert.ok(data.options.some(o => o.text === 'False'));
});

test('Fixture 4: Numerical Question extraction', () => {
  const html = fs.readFileSync(path.join(fixturesDir, '4-numerical.html'), 'utf8');
  const dom = setupDOM(html);
  const { MoodleAdapter } = dom.window;

  const containers = MoodleAdapter.getQuestionContainers();
  assert.equal(containers.length, 1);

  const data = MoodleAdapter.extractQuestionData(containers[0]);
  assert.equal(data.questionType, 'numerical');
  assert.ok(data.question.includes('Calculate the sum: 15 + 27'));
  assert.equal(data.options.length, 0);
});

test('Fixture 5: Formatted Text and Math preservation', () => {
  const html = fs.readFileSync(path.join(fixturesDir, '5-formatted-text.html'), 'utf8');
  const dom = setupDOM(html);
  const { MoodleAdapter } = dom.window;

  const containers = MoodleAdapter.getQuestionContainers();
  const data = MoodleAdapter.extractQuestionData(containers[0]);

  assert.ok(data.question.includes('\\Delta G = \\Delta H - T\\Delta S') || data.question.includes('Delta G'));
  assert.ok(data.question.includes('Enthalpy') || data.question.includes('Exothermic'));
  assert.equal(data.options.length, 4);
});

test('Fixture 6: Code snippet preservation', () => {
  const html = fs.readFileSync(path.join(fixturesDir, '6-code-question.html'), 'utf8');
  const dom = setupDOM(html);
  const { MoodleAdapter } = dom.window;

  const containers = MoodleAdapter.getQuestionContainers();
  const data = MoodleAdapter.extractQuestionData(containers[0]);

  assert.ok(data.question.includes('compute()'));
  assert.ok(data.question.includes('i ** 2 for i in range(3)'));
  assert.equal(data.options.length, 4);
});

test('Fixture 7: Multi-Question Page avoids mixing options from neighboring questions', () => {
  const html = fs.readFileSync(path.join(fixturesDir, '7-multi-question-page.html'), 'utf8');
  const dom = setupDOM(html);
  const { MoodleAdapter } = dom.window;

  const containers = MoodleAdapter.getQuestionContainers();
  assert.equal(containers.length, 3, 'Page should contain 3 distinct questions');

  // Question 1
  const q1 = MoodleAdapter.extractQuestionData(containers[0]);
  assert.equal(q1.questionNumber, '1');
  assert.equal(q1.questionType, 'single_choice');
  assert.equal(q1.options.length, 3);
  assert.ok(q1.options.every(o => !o.text.includes('True') && !o.text.includes('False')));

  // Question 2
  const q2 = MoodleAdapter.extractQuestionData(containers[1]);
  assert.equal(q2.questionNumber, '2');
  assert.equal(q2.questionType, 'true_false');
  assert.equal(q2.options.length, 2);
  assert.ok(q2.options.some(o => o.text === 'True'));

  // Question 3
  const q3 = MoodleAdapter.extractQuestionData(containers[2]);
  assert.equal(q3.questionNumber, '3');
  assert.equal(q3.questionType, 'multiple_choice');
  assert.equal(q3.options.length, 3);
  assert.ok(q3.options.some(o => o.text.includes('2')));
});

test('Fixture 8: Dynamically loaded AJAX question extraction', () => {
  const html = fs.readFileSync(path.join(fixturesDir, '8-dynamic-question.html'), 'utf8');
  const dom = setupDOM(html);
  const { MoodleAdapter } = dom.window;

  let containers = MoodleAdapter.getQuestionContainers();
  let data = MoodleAdapter.extractQuestionData(containers[0]);
  assert.ok(data.question.includes('capital city of France'));
  assert.equal(data.options.length, 3);

  const nextBtn = dom.window.document.getElementById('btn-next-question');
  nextBtn.click();

  containers = MoodleAdapter.getQuestionContainers();
  data = MoodleAdapter.extractQuestionData(containers[0]);
  assert.ok(data.question.includes('powerhouse of the eukaryotic cell'));
  assert.equal(data.options.length, 4);
});

test('Fixture 9: Custom Modern Quiz Layout (User Screenshot Replica) extraction', () => {
  const html = fs.readFileSync(path.join(fixturesDir, '9-custom-quiz-layout.html'), 'utf8');
  const dom = setupDOM(html);
  const { MoodleAdapter } = dom.window;

  const containers = MoodleAdapter.getQuestionContainers();
  assert.ok(containers.length >= 2, 'Should detect both question cards');

  const q4 = MoodleAdapter.extractQuestionData(containers[0]);
  assert.ok(q4.question.includes('Where would you make your place'));
  assert.ok(q4.options.length >= 7);
  assert.ok(q4.options[0].text.includes('A cave or a tree house'));

  const q5 = MoodleAdapter.extractQuestionData(containers[1]);
  assert.ok(q5.question.includes('What would you do in your spare time'));
  assert.equal(q5.options.length, 3);
  assert.ok(q5.options.some(o => o.text.includes('Hunt')));
});

test('Shortcut 1 (Shift+Z): solveCurrentQuestion extracts text and stores lastAnswer', async () => {
  const html = fs.readFileSync(path.join(fixturesDir, '1-single-choice.html'), 'utf8');
  const dom = setupDOM(html, { option: 'B', answer: 'Chloroplasts', status: 'success' });
  const { MoodleAdapter } = dom.window;

  await MoodleAdapter.solveCurrentQuestion();

  // Verify message sent to backend
  const analyzeCall = dom.window.sentMessages.find(m => m.action === 'ANALYZE_QUESTION');
  assert.ok(analyzeCall, 'Should have sent ANALYZE_QUESTION message');
  assert.equal(analyzeCall.payload.questionType, 'single_choice');
  assert.ok(analyzeCall.payload.question.includes('photosynthesis'));

  // Verify lastAnswer stored in-memory
  const last = MoodleAdapter.getLastAnswer();
  assert.ok(last);
  assert.equal(last.option, 'B');
  assert.equal(last.answer, 'Chloroplasts');
});

test('Shortcut 2 (Shift+X): solveQuestionScreenshot captures tab and sends vision payload', async () => {
  const html = fs.readFileSync(path.join(fixturesDir, '6-code-question.html'), 'utf8');
  const dom = setupDOM(html, { option: 'B', answer: '[0, 1, 4]', status: 'success' });
  const { MoodleAdapter } = dom.window;

  await MoodleAdapter.solveQuestionScreenshot();

  // Verify CAPTURE_VISIBLE_TAB was triggered
  const captureCall = dom.window.sentMessages.find(m => m.action === 'CAPTURE_VISIBLE_TAB');
  assert.ok(captureCall, 'Should have sent CAPTURE_VISIBLE_TAB');

  // Verify vision question was sent
  const visionCall = dom.window.sentMessages.find(m => m.action === 'ANALYZE_QUESTION');
  assert.ok(visionCall);
  assert.equal(visionCall.payload.questionType, 'vision');
  assert.ok(visionCall.payload.image.startsWith('data:image/'));

  // Verify lastAnswer stored
  const last = MoodleAdapter.getLastAnswer();
  assert.equal(last.answer, '[0, 1, 4]');
});

test('Shortcut 3 (Shift+A): showLastAnswerAgain re-displays previous answer without new API request', async () => {
  const html = fs.readFileSync(path.join(fixturesDir, '1-single-choice.html'), 'utf8');
  const dom = setupDOM(html, { option: 'B', answer: 'Chloroplasts', status: 'success' });
  const { MoodleAdapter } = dom.window;

  // First solve to establish last answer
  await MoodleAdapter.solveCurrentQuestion();
  const initialCallCount = dom.window.sentMessages.length;

  // Now trigger Shift+A
  MoodleAdapter.showLastAnswerAgain();

  // Must NOT trigger another network request
  assert.equal(dom.window.sentMessages.length, initialCallCount, 'Shift+A must not send additional API calls');
  assert.equal(MoodleAdapter.getLastAnswer().answer, 'Chloroplasts');
});

test('MoodleQuickNotification: renders answer cleanly and handles positions', () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    runScripts: 'dangerously',
    url: 'http://localhost/'
  });
  dom.window.chrome = {
    storage: {
      local: {
        get: () => Promise.resolve({ notificationPosition: 'top-right', notificationDuration: 1000 }),
        set: () => Promise.resolve()
      }
    }
  };
  dom.window.eval(notificationCode);

  const notifier = new dom.window.MoodleQuickNotification();
  notifier.showAnswer({ option: 'B', answer: 'Binary Search' });

  const host = dom.window.document.getElementById('moodle-quick-notify-host');
  assert.ok(host, 'Notification container element must exist');
  const box = host.shadowRoot.getElementById('notify-box');
  assert.equal(box.textContent, 'B — Binary Search');

  notifier.setPosition('bottom-right');
  assert.equal(host.style.bottom, '16px');
  assert.equal(host.style.right, '16px');
});

test('MoodleQuickNotification: progressive 3-dot expansion for long answers', () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    runScripts: 'dangerously',
    url: 'http://localhost/'
  });
  dom.window.chrome = {
    storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() } }
  };
  dom.window.eval(notificationCode);

  const notifier = new dom.window.MoodleQuickNotification();
  const longAnswer = 'I am a student for the college and I go to college and love to learn every single day';
  notifier.showAnswer({ option: 'A', answer: longAnswer });

  const host = dom.window.document.getElementById('moodle-quick-notify-host');
  const box = host.shadowRoot.getElementById('notify-box');
  const dotsBtn = box.querySelector('.more-dots-btn');

  assert.ok(dotsBtn, 'Long answer should render ... expansion button');
  assert.ok(box.textContent.includes('···'));

  // Advance chunk
  notifier.advanceChunk();
  assert.ok(box.textContent.length > 30, 'Should reveal more text after advancing chunk');
});

test('MoodleScreenshotHandler: computes question crop rectangle accurately', () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="q1" style="width:500px; height:200px;"></div></body></html>', {
    runScripts: 'dangerously',
    url: 'http://localhost/'
  });
  dom.window.eval(screenshotCode);
  const handler = dom.window.MoodleScreenshotHandler;

  const el = dom.window.document.getElementById('q1');
  el.getBoundingClientRect = () => ({
    top: 50,
    left: 20,
    width: 400,
    height: 150
  });

  const rect = handler.getQuestionCropRect(el);
  assert.ok(rect);
  assert.ok(rect.width > 400); // Has buffer padding
  assert.ok(rect.height > 150);
});
