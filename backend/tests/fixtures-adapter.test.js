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
        if (msg.action === 'FETCH_IMAGE_AS_DATA_URL') {
          if (msg.url && (msg.url.includes('inaccessible') || msg.url.includes('broken'))) {
            return Promise.resolve({ success: false, error: 'Inaccessible image: HTTP 404' });
          }
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

test('GeeksforGeeks Layout: Shift+Z automatically extracts question and options', async () => {
  const gfgHtml = `
    <div class="QuizDiscussitPage_js_mainContentContainer__yrbZu">
      <div class="QuizQuestionDiscuss_quizQuestionDiscussMainContainer_questionsAndOptions__2TYvt">
        <p>A market research firm wants to estimate the average annual household income in a large country. The country is divided into 50 states. The firm's methodology is as follows: first, it randomly selects 5 of the 50 states. Then, within each of these 5 selected states, it obtains data from every household. This sampling strategy is an example of:</p>
        <div class="QuizQuestionDiscuss_quizQuestionDiscussMainContainer_questionsAndOptions_optionContainer__OwS9_">Stratified Random Sampling</div>
        <div class="QuizQuestionDiscuss_quizQuestionDiscussMainContainer_questionsAndOptions_optionContainer__OwS9_">Cluster Sampling</div>
        <div class="QuizQuestionDiscuss_quizQuestionDiscussMainContainer_questionsAndOptions_optionContainer__OwS9_">Simple Random Sampling</div>
        <div class="QuizQuestionDiscuss_quizQuestionDiscussMainContainer_questionsAndOptions_optionContainer__OwS9_">Systematic Sampling</div>
      </div>
    </div>
  `;
  const dom = setupDOM(gfgHtml, { option: 'B', answer: 'Cluster Sampling', status: 'success' });
  const { MoodleAdapter } = dom.window;

  await MoodleAdapter.solveCurrentQuestion();

  const analyzeCall = dom.window.sentMessages.find(m => m.action === 'ANALYZE_QUESTION');
  assert.ok(analyzeCall, 'Should have sent ANALYZE_QUESTION message');
  assert.ok(analyzeCall.payload.question.includes('household income'));
  assert.equal(analyzeCall.payload.options.length, 4);
  assert.ok(analyzeCall.payload.options[1].text.includes('Cluster Sampling'));
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

test('MoodleQuickNotification: default duration is 500ms and uses pure white theme', () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    runScripts: 'dangerously',
    url: 'http://localhost/'
  });
  dom.window.chrome = {
    storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() } }
  };
  dom.window.eval(notificationCode);

  const notifier = new dom.window.MoodleQuickNotification();
  assert.equal(notifier.currentDurationMs, 500, 'Default notification duration must be 500ms');

  notifier.showAnswer({ option: 'A', answer: 'Test Answer' });
  const host = dom.window.document.getElementById('moodle-quick-notify-host');
  assert.ok(host, 'Notification container must exist');
  const styleEl = host.shadowRoot.querySelector('style');
  assert.ok(styleEl.textContent.includes('background: #FFFFFF'));
  assert.ok(styleEl.textContent.includes('color: #000000'));
  assert.ok(styleEl.textContent.includes('border: 1px solid #E5E5E5'));
});

test('Question with 6 options (A-F) extracts all options accurately without loss', () => {
  const html = `
    <div class="que multichoice" id="q_six_opts">
      <div class="formulation">
        <div class="qtext">Which of the following sorting algorithms has worst-case time complexity of O(n log n)?</div>
        <div class="answer">
          <div class="r0"><label><input type="radio" name="q6" value="1"> Insertion Sort</label></div>
          <div class="r1"><label><input type="radio" name="q6" value="2"> Bubble Sort</label></div>
          <div class="r0"><label><input type="radio" name="q6" value="3"> Merge Sort</label></div>
          <div class="r1"><label><input type="radio" name="q6" value="4"> Quick Sort</label></div>
          <div class="r0"><label><input type="radio" name="q6" value="5"> Selection Sort</label></div>
          <div class="r1"><label><input type="radio" name="q6" value="6"> Heap Sort</label></div>
        </div>
      </div>
    </div>
  `;
  const dom = setupDOM(html);
  const { MoodleAdapter } = dom.window;

  const tStart = performance.now();
  const qEl = dom.window.document.getElementById('q_six_opts');
  const extracted = MoodleAdapter.extractQuestionData(qEl);
  const duration = performance.now() - tStart;

  assert.ok(duration < 100, `DOM extraction must finish under 100ms (took ${duration.toFixed(2)}ms)`);
  assert.equal(extracted.options.length, 6, 'Should extract all 6 options');
  assert.ok(extracted.options[0].text.startsWith('A. Insertion Sort'));
  assert.ok(extracted.options[2].text.startsWith('C. Merge Sort'));
  assert.ok(extracted.options[5].text.startsWith('F. Heap Sort'));
  assert.equal(extracted.questionType, 'dsa');
});

test('Superscripts and Subscripts are preserved in mathematical and complexity formulas', () => {
  const html = `
    <div class="que" id="q_math">
      <div class="formulation">
        <div class="qtext">The complexity is O(n<sup>2</sup>) and initial term is x<sub>0</sub>.</div>
        <div class="answer">
          <label><input type="radio" name="qm"> True</label>
          <label><input type="radio" name="qm"> False</label>
        </div>
      </div>
    </div>
  `;
  const dom = setupDOM(html);
  const { MoodleAdapter } = dom.window;

  const qEl = dom.window.document.getElementById('q_math');
  const extracted = MoodleAdapter.extractQuestionData(qEl);

  assert.ok(extracted.question.includes('O(n^{2})'));
  assert.ok(extracted.question.includes('x_{0}'));
  assert.equal(extracted.questionType, 'true_false');
});

test('UI Theme Files verification: Popup and Settings use pure white #FFFFFF theme', () => {
  const popupHtml = fs.readFileSync(path.resolve(__dirname, '../../extension/popup.html'), 'utf8');
  const settingsHtml = fs.readFileSync(path.resolve(__dirname, '../../extension/settings.html'), 'utf8');

  // Verify popup.html uses pure white theme
  assert.ok(popupHtml.includes('background: #FFFFFF'));
  assert.ok(popupHtml.includes('color: #000000'));
  assert.ok(!popupHtml.includes('background: #0f172a'), 'Popup must not have dark background #0f172a');
  assert.ok(!popupHtml.includes('background: #1e293b'), 'Popup must not have dark cards #1e293b');

  // Verify settings.html uses pure white theme
  assert.ok(settingsHtml.includes('background: #FFFFFF'));
  assert.ok(settingsHtml.includes('color: #000000'));
  assert.ok(!settingsHtml.includes('background: #09090b'), 'Settings must not have dark background #09090b');
});

// =========================================================================
// Image-Aware Moodle Extraction Tests (Shift + Z)
// =========================================================================

test('Acceptance Test: Image-only Moodle question with 4 text options via Shift+Z', async () => {
  const html = `
    <div class="que multichoice clearfix" id="q_image_only">
      <div class="info">
        <h3 class="no">Question <span class="qno">1</span></h3>
      </div>
      <div class="content">
        <div class="formulation clearfix">
          <div class="qtext">
            <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" alt="Circuit diagram showing an operational amplifier with negative feedback" />
          </div>
          <div class="answer">
            <div class="r0"><input type="radio" name="q1" id="q1_a"><label for="q1_a">a. Inverting Amplifier</label></div>
            <div class="r1"><input type="radio" name="q1" id="q1_b"><label for="q1_b">b. Non-inverting Amplifier</label></div>
            <div class="r2"><input type="radio" name="q1" id="q1_c"><label for="q1_c">c. Voltage Follower</label></div>
            <div class="r3"><input type="radio" name="q1" id="q1_d"><label for="q1_d">d. Differential Amplifier</label></div>
          </div>
        </div>
      </div>
    </div>
  `;
  const dom = setupDOM(html, { option: 'A', answer: 'Inverting Amplifier', status: 'success' });
  const { MoodleAdapter } = dom.window;

  // Trigger Shift+Z
  await MoodleAdapter.solveCurrentQuestion();

  // Verify ANALYZE_QUESTION message payload
  const analyzeCall = dom.window.sentMessages.find(m => m.action === 'ANALYZE_QUESTION');
  assert.ok(analyzeCall, 'Should send ANALYZE_QUESTION');
  assert.equal(analyzeCall.payload.questionType, 'image_based');
  assert.ok(analyzeCall.payload.image, 'Must include base64 question image');
  assert.ok(analyzeCall.payload.image.startsWith('data:image/'));
  assert.equal(analyzeCall.payload.options.length, 4, 'Must include all 4 text options');
  assert.ok(analyzeCall.payload.options[0].text.includes('Inverting Amplifier'));
  assert.ok(analyzeCall.payload.options[1].text.includes('Non-inverting Amplifier'));
});

test('Image + Text Moodle question includes both text prompt and image payload', async () => {
  const html = `
    <div class="que multichoice" id="q_img_text">
      <div class="formulation">
        <div class="qtext">
          <p>Find the current flowing through resistor R1 in the circuit below:</p>
          <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" alt="Resistor circuit diagram" />
        </div>
        <div class="answer">
          <div class="r0"><label><input type="radio" name="q_it" id="q_it_1"> 2.5 A</label></div>
          <div class="r1"><label><input type="radio" name="q_it" id="q_it_2"> 5.0 A</label></div>
          <div class="r2"><label><input type="radio" name="q_it" id="q_it_3"> 10 A</label></div>
        </div>
      </div>
    </div>
  `;
  const dom = setupDOM(html, { option: 'B', answer: '5.0 A', status: 'success' });
  const { MoodleAdapter } = dom.window;

  await MoodleAdapter.solveCurrentQuestion();

  const analyzeCall = dom.window.sentMessages.find(m => m.action === 'ANALYZE_QUESTION');
  assert.ok(analyzeCall);
  assert.ok(analyzeCall.payload.question.includes('resistor R1'));
  assert.ok(analyzeCall.payload.image);
  assert.equal(analyzeCall.payload.options.length, 3);
});

test('Multiple images in a question are extracted in DOM order', async () => {
  const html = `
    <div class="que multichoice" id="q_multi_img">
      <div class="formulation">
        <div class="qtext">
          <img src="data:image/png;base64,IMAGE_ONE_DATA" alt="Diagram 1" />
          <svg width="100" height="100"><circle cx="50" cy="50" r="40"/></svg>
        </div>
        <div class="answer">
          <label><input type="radio" name="qm"> Option A</label>
          <label><input type="radio" name="qm"> Option B</label>
        </div>
      </div>
    </div>
  `;
  const dom = setupDOM(html, { option: 'A', answer: 'Option A', status: 'success' });
  const { MoodleAdapter } = dom.window;

  await MoodleAdapter.solveCurrentQuestion();

  const analyzeCall = dom.window.sentMessages.find(m => m.action === 'ANALYZE_QUESTION');
  assert.ok(analyzeCall);
  assert.ok(analyzeCall.payload.images, 'Should include images array');
  assert.equal(analyzeCall.payload.images.length, 2, 'Should capture both images');
  assert.ok(analyzeCall.payload.images[0].includes('IMAGE_ONE_DATA'), 'First image in DOM order');
  assert.ok(analyzeCall.payload.images[1].includes('data:image/svg+xml;base64,'), 'Second image is serialized SVG in DOM order');
});

test('Neighboring question isolation: images and options never leak between adjacent questions', async () => {
  const html = `
    <div class="que multichoice" id="q_first">
      <div class="formulation">
        <div class="qtext">
          <img src="data:image/png;base64,Q1_SPECIFIC_IMAGE" alt="Q1 Image" />
        </div>
        <div class="answer">
          <label><input type="radio" name="q1"> Q1 Option 1</label>
          <label><input type="radio" name="q1"> Q1 Option 2</label>
        </div>
      </div>
    </div>
    <div class="que multichoice" id="q_second">
      <div class="formulation">
        <div class="qtext">
          <img src="data:image/png;base64,Q2_SPECIFIC_IMAGE" alt="Q2 Image" />
        </div>
        <div class="answer">
          <label><input type="radio" name="q2"> Q2 Option 1</label>
          <label><input type="radio" name="q2"> Q2 Option 2</label>
        </div>
      </div>
    </div>
  `;
  const dom = setupDOM(html, { option: 'A', answer: 'Q1 Option 1', status: 'success' });
  const { MoodleAdapter } = dom.window;

  // Target Q1 specifically
  const q1El = dom.window.document.getElementById('q_first');
  const extractedQ1 = MoodleAdapter.extractQuestionData(q1El);

  assert.equal(extractedQ1.images.length, 1);
  assert.ok(extractedQ1.images[0].includes('Q1_SPECIFIC_IMAGE'), 'Must only have Q1 image');
  assert.ok(!extractedQ1.images[0].includes('Q2_SPECIFIC_IMAGE'), 'Must NOT have Q2 image');
  assert.equal(extractedQ1.options.length, 2);
  assert.ok(extractedQ1.options.every(o => o.text.includes('Q1')), 'All options must belong to Q1');
  assert.ok(extractedQ1.options.every(o => !o.text.includes('Q2')), 'No options from Q2 should leak');
});

test('Inaccessible images trigger clear notification instead of silently failing', async () => {
  const html = `
    <div class="que multichoice" id="q_broken">
      <div class="formulation">
        <div class="qtext">
          <img src="https://example.com/inaccessible_broken_diagram.png" />
        </div>
        <div class="answer">
          <label><input type="radio" name="qb"> Option A</label>
          <label><input type="radio" name="qb"> Option B</label>
        </div>
      </div>
    </div>
  `;
  const dom = setupDOM(html);
  const { MoodleAdapter } = dom.window;

  await MoodleAdapter.solveCurrentQuestion();

  // Verify error notification rendered
  const host = dom.window.document.getElementById('moodle-quick-notify-host');
  assert.ok(host, 'Notification host should be present');
  const box = host.shadowRoot.getElementById('notify-box');
  assert.ok(box.textContent.includes('Could not decode question image'), `Notification should state image decoding error, got: ${box.textContent}`);

  // No ANALYZE_QUESTION should have been dispatched with invalid/missing image
  const analyzeCall = dom.window.sentMessages.find(m => m.action === 'ANALYZE_QUESTION');
  assert.ok(!analyzeCall, 'Should NOT dispatch request with broken image');
});

test('Decorative images, user avatars, and feedback icons are excluded', () => {
  const html = `
    <div class="que multichoice" id="q_decor">
      <div class="info">
        <img class="userpicture" src="avatar.png" width="35" height="35" />
        <img class="icon" src="flag.png" width="16" height="16" />
      </div>
      <div class="formulation">
        <div class="qtext">
          <img role="presentation" src="spacer.gif" width="1" height="1" />
          <img class="question-diagram" src="data:image/png;base64,REAL_DIAGRAM_DATA" width="300" height="200" alt="State Transition Diagram" />
        </div>
        <div class="answer">
          <label><input type="radio" name="qd"> State S0</label>
          <label><input type="radio" name="qd"> State S1</label>
        </div>
        <div class="feedback">
          <img class="icon" src="tick.png" width="16" height="16" />
        </div>
      </div>
    </div>
  `;
  const dom = setupDOM(html);
  const { MoodleAdapter } = dom.window;

  const qEl = dom.window.document.getElementById('q_decor');
  const extracted = MoodleAdapter.extractQuestionData(qEl);

  assert.equal(extracted.images.length, 1, 'Should only extract the 1 real diagram');
  assert.ok(extracted.images[0].includes('REAL_DIAGRAM_DATA'));
});

test('Shift + X preserves normal page brightness with transparent overlay and updates answer popup in-place', async () => {
  const html = `
    <div id="test-page-content">
      <p>Sample question content on page</p>
    </div>
  `;
  const dom = setupDOM(html);
  const { document, MoodleQuickNotification, MoodleScreenshotHandler } = dom.window;

  // 1. Verify crosshair overlay preserves normal page brightness (no black backdrop, transparent overlay)
  const promise = MoodleScreenshotHandler.promptUserSelectionArea();
  const overlay = document.getElementById('moodle-snipping-overlay');
  assert.ok(overlay, 'Snipping overlay must exist');
  assert.ok(!overlay.style.background.includes('rgba(0, 0, 0'), 'Overlay must not have dark dimming background (preserves normal brightness)');

  // Simulate Escape to clean up
  dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await promise;

  // 2. Verify small status appears in the exact same answer popup location
  const notify = new MoodleQuickNotification();
  notify.showImagePreview('data:image/png;base64,TEST_SNIPPET', 'Evaluating...');

  const host = document.getElementById('moodle-quick-notify-host');
  assert.ok(host, 'Must reuse the exact same answer notification host');
  const box = host.shadowRoot.getElementById('notify-box');
  assert.ok(box, 'Must reuse the exact same notification box');
  assert.ok(box.textContent.includes('Evaluating...'), 'Shows small Evaluating... status in answer popup');

  // 3. Verify word change in-place when answer arrives
  notify.showAnswer({ option: 'B', answer: 'Cluster Sampling' });
  assert.ok(box.textContent.includes('B — Cluster Sampling'), 'The words inside the exact same box change to the answer');
});

test('Vision support verification: isVisionSupported confirms image capability', async () => {
  const { isVisionSupported } = await import('../services/llm-provider.js');

  assert.equal(isVisionSupported('gemini', 'gemini-3.1-flash-lite'), true, 'Gemini supports vision');
  assert.equal(isVisionSupported('gemini_1', 'gemini-3.5-flash'), true, 'Gemini pool key supports vision');
  assert.equal(isVisionSupported('chatgpt', 'gpt-4o-mini'), true, 'GPT-4o-mini supports vision');
  assert.equal(isVisionSupported('chatgpt', 'gpt-3.5-turbo'), false, 'GPT-3.5 does NOT support vision');
  assert.equal(isVisionSupported('custom', 'mistral-7b'), false, 'Generic custom model does not claim vision support');
});
