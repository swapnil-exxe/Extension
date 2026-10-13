import test from 'node:test';
import assert from 'node:assert/strict';
import app from '../server.js';
import { extractAndParseJSON } from '../services/llm-provider.js';

let server;
let baseUrl;

test.before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.LLM_PROVIDER = 'mock';
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://localhost:${port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('GET /health returns 200 and healthy status', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'ok');
  assert.ok(data.uptimeSeconds >= 0);
  assert.ok(data.provider);
});

test('POST /api/answer succeeds with single_choice question', async () => {
  const payload = {
    platform: 'moodle',
    questionType: 'single_choice',
    question: 'Where does photosynthesis primarily take place in plant cells?',
    options: [
      { id: 'opt_1', text: 'Mitochondria' },
      { id: 'opt_2', text: 'Chloroplasts' },
      { id: 'opt_3', text: 'Ribosomes' },
      { id: 'opt_4', text: 'Golgi apparatus' }
    ]
  };

  const res = await fetch(`${baseUrl}/api/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.answer.toLowerCase().includes('chloroplast'));
  assert.deepEqual(data.optionIds, ['opt_2']);
  assert.ok(typeof data.explanation === 'string');
  assert.ok(data.confidence > 0.5);
  assert.equal(data.needsMoreContext, false);
  assert.equal(data.cached, false);
  assert.ok(typeof data.latencyMs === 'number');
});

test('POST /api/answer returns cached result on duplicate request', async () => {
  const payload = {
    platform: 'moodle',
    questionType: 'single_choice',
    question: 'Where does photosynthesis primarily take place in plant cells?',
    options: [
      { id: 'opt_1', text: 'Mitochondria' },
      { id: 'opt_2', text: 'Chloroplasts' },
      { id: 'opt_3', text: 'Ribosomes' },
      { id: 'opt_4', text: 'Golgi apparatus' }
    ]
  };

  const res = await fetch(`${baseUrl}/api/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.cached, true);
  assert.deepEqual(data.optionIds, ['opt_2']);
});

test('POST /api/answer evaluates multiple_choice questions', async () => {
  const payload = {
    platform: 'moodle',
    questionType: 'multiple_choice',
    question: 'Select all prime numbers below 10.',
    options: [
      { id: 'opt_a', text: '2' },
      { id: 'opt_b', text: '3' },
      { id: 'opt_c', text: '4' },
      { id: 'opt_d', text: '6' }
    ]
  };

  const res = await fetch(`${baseUrl}/api/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.optionIds));
  assert.ok(data.optionIds.length >= 1);
  assert.ok(data.explanation.length > 0);
});

test('POST /api/answer evaluates numerical questions', async () => {
  const payload = {
    platform: 'moodle',
    questionType: 'numerical',
    question: 'Calculate 15 + 27',
    options: []
  };

  const res = await fetch(`${baseUrl}/api/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.answer, '42');
  assert.deepEqual(data.optionIds, []);
});

test('POST /api/answer evaluates vision screenshot questions', async () => {
  const payload = {
    platform: 'moodle',
    questionType: 'vision',
    question: 'Identify the algorithm in the screenshot',
    image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  };

  const res = await fetch(`${baseUrl}/api/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'success');
  assert.ok(data.answer.length > 0);
  assert.equal(data.option, 'B');
});

test('POST /api/answer rejects invalid requests', async () => {
  const invalidPayload = {
    platform: 'canvas', // Only 'moodle' allowed
    questionType: 'invalid_type',
    question: ''
  };

  const res = await fetch(`${baseUrl}/api/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(invalidPayload)
  });

  assert.equal(res.status, 400);
  const data = await res.json();
  assert.ok(data.error);
  assert.ok(Array.isArray(data.details));
});

test('extractAndParseJSON parses raw text and markdown fences', () => {
  const plain = '{"answer":"B","optionIds":["b"],"explanation":"test","confidence":0.9,"needsMoreContext":false}';
  assert.equal(extractAndParseJSON(plain).answer, 'B');

  const fenced = '```json\n{"answer":"A","optionIds":["a"],"explanation":"test","confidence":0.9,"needsMoreContext":false}\n```';
  assert.equal(extractAndParseJSON(fenced).answer, 'A');

  const withPreamble = 'Here is the answer:\n{"answer":"C","optionIds":["c"],"explanation":"test","confidence":0.9,"needsMoreContext":false}\nHope this helps!';
  assert.equal(extractAndParseJSON(withPreamble).answer, 'C');
});
