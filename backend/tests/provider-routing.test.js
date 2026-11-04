import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backgroundScriptPath = path.resolve(__dirname, '../../extension/background.js');
const backgroundCode = fs.readFileSync(backgroundScriptPath, 'utf8');

function setupBackgroundSandbox(initialStorage = {}, fetchHandler) {
  const storageData = { ...initialStorage };
  const messageListeners = [];
  const callsMade = [];

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
      },
      onChanged: { addListener: () => {} }
    },
    commands: {
      onCommand: { addListener: () => {} }
    },
    declarativeNetRequest: {
      updateDynamicRules: () => Promise.resolve()
    },
    tabs: {
      query: () => Promise.resolve([]),
      sendMessage: () => {}
    }
  };

  const fakeFetch = async (url, options = {}) => {
    callsMade.push({ url: String(url), options });
    if (fetchHandler) {
      return fetchHandler(String(url), options);
    }
    throw new Error('fetch handler not configured');
  };

  const sandbox = {
    chrome: fakeChrome,
    fetch: fakeFetch,
    console: {
      log: () => {},
      warn: () => {},
      error: () => {},
      info: () => {}
    },
    setTimeout,
    clearTimeout,
    AbortController,
    AbortSignal,
    URL,
    Date,
    Array,
    Object,
    String,
    Number,
    Boolean,
    JSON,
    Math,
    RegExp,
    parseInt
  };

  vm.createContext(sandbox);
  vm.runInContext(backgroundCode, sandbox);

  return {
    sandbox,
    storageData,
    callsMade,
    async sendMessage(msg) {
      for (const listener of messageListeners) {
        let responded = false;
        let responseData = null;
        const res = listener(msg, {}, (r) => {
          responded = true;
          responseData = r;
        });
        if (res === true) {
          // Async response, wait a bit
          await new Promise(r => setTimeout(r, 50));
          return responseData;
        }
        if (responded) return responseData;
      }
      return null;
    }
  };
}

test('Provider Isolation: When Gemini is selected, request routes strictly to Gemini API', async () => {
  let geminiApiCalled = false;
  let openaiCalled = false;
  let ollamaCalled = false;

  const env = setupBackgroundSandbox({
    activeProvider: 'gemini',
    geminiApiKey: 'AIzaSyFakeGeminiTestKey123',
    geminiSelectedModel: 'gemini-2.5-flash'
  }, async (url, options) => {
    if (url.includes('generativelanguage.googleapis.com')) {
      geminiApiCalled = true;
      assert.equal(options.headers['x-goog-api-key'], 'AIzaSyFakeGeminiTestKey123');
      assert.ok(url.includes('gemini-2.5-flash'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{
            content: { parts: [{ text: JSON.stringify({ option: 'B', answer: '42', reason: 'Calculated' }) }] }
          }]
        })
      };
    }
    if (url.includes('openai.com')) {
      openaiCalled = true;
    }
    if (url.includes('11434')) {
      ollamaCalled = true;
    }
    throw new Error(`Unexpected destination: ${url}`);
  });

  const res = await env.sendMessage({
    action: 'ANALYZE_QUESTION',
    payload: {
      question: 'What is 40 + 2?',
      options: [{ id: 'A', text: '40' }, { id: 'B', text: '42' }]
    }
  });

  assert.ok(geminiApiCalled, 'Must call official Gemini API');
  assert.equal(openaiCalled, false, 'Must never call OpenAI when Gemini is selected');
  assert.equal(ollamaCalled, false, 'Must never call Ollama when Gemini is selected');
  assert.equal(res.success, true);
  assert.equal(res.data.option, 'B');
  assert.equal(res.data.provider, 'gemini');
});

test('Provider Isolation: When OpenAI is selected, request routes strictly to OpenAI API', async () => {
  let openaiCalled = false;
  let geminiCalled = false;
  let ollamaCalled = false;

  const env = setupBackgroundSandbox({
    activeProvider: 'openai',
    openaiApiKey: 'sk-proj-FakeOpenAITestKey456',
    openaiSelectedModel: 'gpt-4o-mini'
  }, async (url, options) => {
    if (url.includes('api.openai.com')) {
      openaiCalled = true;
      assert.equal(options.headers['Authorization'], 'Bearer sk-proj-FakeOpenAITestKey456');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'gpt-4o-mini');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: { content: JSON.stringify({ option: 'A', answer: 'True', reason: 'Fact' }) }
          }]
        })
      };
    }
    if (url.includes('googleapis.com')) {
      geminiCalled = true;
    }
    if (url.includes('11434')) {
      ollamaCalled = true;
    }
    throw new Error(`Unexpected destination: ${url}`);
  });

  const res = await env.sendMessage({
    action: 'ANALYZE_QUESTION',
    payload: {
      question: 'Is the earth round?',
      options: [{ id: 'A', text: 'True' }, { id: 'B', text: 'False' }]
    }
  });

  assert.ok(openaiCalled, 'Must call official OpenAI API');
  assert.equal(geminiCalled, false, 'Must never call Gemini when OpenAI is selected');
  assert.equal(ollamaCalled, false, 'Must never call Ollama when OpenAI is selected');
  assert.equal(res.success, true);
  assert.equal(res.data.option, 'A');
  assert.equal(res.data.provider, 'openai');
});

test('Fallback Isolation: Gemini failure does NOT silently fall back to Ollama or OpenAI', async () => {
  let ollamaCalled = false;
  let openaiCalled = false;

  const env = setupBackgroundSandbox({
    activeProvider: 'gemini',
    geminiApiKey: 'AIzaSyInvalidKey',
    ollamaUrl: 'http://127.0.0.1:11434'
  }, async (url) => {
    if (url.includes('generativelanguage.googleapis.com')) {
      return {
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { message: 'API_KEY_INVALID' } })
      };
    }
    if (url.includes('11434')) {
      ollamaCalled = true;
    }
    if (url.includes('openai.com')) {
      openaiCalled = true;
    }
    throw new Error(`Unexpected url: ${url}`);
  });

  const res = await env.sendMessage({
    action: 'ANALYZE_QUESTION',
    payload: { question: 'Test question', options: [] }
  });

  assert.equal(res.success, false, 'Request must report failure');
  assert.ok(res.error.includes('Invalid API key') || res.error.includes('Gemini Authentication Error'));
  assert.equal(ollamaCalled, false, 'Must not fallback to Ollama on Gemini failure');
  assert.equal(openaiCalled, false, 'Must not fallback to OpenAI on Gemini failure');
});

test('Fallback Isolation: OpenAI quota failure does NOT silently fall back to Gemini or Ollama', async () => {
  let geminiCalled = false;
  let ollamaCalled = false;

  const env = setupBackgroundSandbox({
    activeProvider: 'openai',
    openaiApiKey: 'sk-proj-ExhaustedKey',
    ollamaUrl: 'http://127.0.0.1:11434'
  }, async (url) => {
    if (url.includes('api.openai.com')) {
      return {
        ok: false,
        status: 429,
        text: async () => JSON.stringify({ error: { message: 'You exceeded your current quota' } })
      };
    }
    if (url.includes('googleapis.com')) {
      geminiCalled = true;
    }
    if (url.includes('11434')) {
      ollamaCalled = true;
    }
    throw new Error(`Unexpected url: ${url}`);
  });

  const res = await env.sendMessage({
    action: 'ANALYZE_QUESTION',
    payload: { question: 'Test question', options: [] }
  });

  assert.equal(res.success, false, 'Request must report failure');
  assert.ok(res.error.includes('Quota Error') || res.error.includes('quota'));
  assert.equal(geminiCalled, false, 'Must not fallback to Gemini on OpenAI quota error');
  assert.equal(ollamaCalled, false, 'Must not fallback to Ollama on OpenAI quota error');
});

test('Connection Test: Gemini test reports connection success and invalid key correctly', async () => {
  const env = setupBackgroundSandbox({}, async (url, options) => {
    if (options.headers['x-goog-api-key'] === 'AIzaSyValid') {
      return { ok: true, status: 200, json: async () => ({ candidates: [] }) };
    }
    return {
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'API key not valid' } })
    };
  });

  // Valid key test
  const validRes = await env.sendMessage({
    action: 'TEST_GEMINI_CONNECTION',
    apiKey: 'AIzaSyValid',
    model: 'gemini-2.5-flash'
  });
  assert.equal(validRes.ok, true);
  assert.ok(validRes.message.includes('Connection successful'));

  // Invalid key test
  const invalidRes = await env.sendMessage({
    action: 'TEST_GEMINI_CONNECTION',
    apiKey: 'AIzaSyBadKey',
    model: 'gemini-2.5-flash'
  });
  assert.equal(invalidRes.ok, false);
  assert.ok(invalidRes.error.includes('Invalid API key'));
});

test('Connection Test: OpenAI test reports connection success and invalid key correctly', async () => {
  const env = setupBackgroundSandbox({}, async (url, options) => {
    if (options.headers['Authorization'] === 'Bearer sk-proj-Valid') {
      return { ok: true, status: 200, json: async () => ({ choices: [] }) };
    }
    return {
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'Incorrect API key provided' } })
    };
  });

  // Valid key test
  const validRes = await env.sendMessage({
    action: 'TEST_OPENAI_CONNECTION',
    apiKey: 'sk-proj-Valid',
    model: 'gpt-4o-mini'
  });
  assert.equal(validRes.ok, true);
  assert.ok(validRes.message.includes('Connection successful'));

  // Invalid key test
  const invalidRes = await env.sendMessage({
    action: 'TEST_OPENAI_CONNECTION',
    apiKey: 'sk-proj-Bad',
    model: 'gpt-4o-mini'
  });
  assert.equal(invalidRes.ok, false);
  assert.ok(invalidRes.error.includes('Invalid API key'));
});

test('Connection Test: Ollama test reports connection success, model missing, and offline server', async () => {
  const env = setupBackgroundSandbox({}, async (url) => {
    if (url.includes('11434')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          models: [{ name: 'gemma3:4b' }, { name: 'llama3.2:latest' }]
        })
      };
    }
    throw new Error('Connection refused');
  });

  // Successful test with installed model
  const successRes = await env.sendMessage({
    action: 'TEST_OLLAMA_CONNECTION',
    ollamaUrl: 'http://127.0.0.1:11434',
    model: 'gemma3:4b'
  });
  assert.equal(successRes.ok, true);
  assert.ok(successRes.message.includes('Connection successful'));

  // Model not installed
  const missingModelRes = await env.sendMessage({
    action: 'TEST_OLLAMA_CONNECTION',
    ollamaUrl: 'http://127.0.0.1:11434',
    model: 'deepseek-r1:70b'
  });
  assert.equal(missingModelRes.ok, false);
  assert.ok(missingModelRes.error.includes('Model unavailable'));

  // Offline Ollama test
  const envOffline = setupBackgroundSandbox({}, async () => {
    throw new Error('fetch failed ECONNREFUSED');
  });
  const offlineRes = await envOffline.sendMessage({
    action: 'TEST_OLLAMA_CONNECTION',
    ollamaUrl: 'http://127.0.0.1:11434',
    model: 'gemma3:4b'
  });
  assert.equal(offlineRes.ok, false);
  assert.ok(offlineRes.error.includes('unavailable'));
});

test('Provider Switching: Gemini -> Ollama -> Gemini -> OpenAI correctly updates routing destination', async () => {
  let lastDestination = '';

  const env = setupBackgroundSandbox({
    activeProvider: 'gemini',
    geminiApiKey: 'AIzaSyKey123',
    openaiApiKey: 'sk-proj-Key456',
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaSelectedModel: 'gemma3:4b'
  }, async (url) => {
    lastDestination = url;
    if (url.includes('googleapis.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ option: 'A', answer: 'Gemini Answer' }) }] } }]
        })
      };
    }
    if (url.includes('api.openai.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ option: 'B', answer: 'OpenAI Answer' }) } }]
        })
      };
    }
    if (url.includes('11434')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          response: JSON.stringify({ option: 'C', answer: 'Ollama Answer' })
        })
      };
    }
    throw new Error('Unexpected destination');
  });

  // 1. Initial request (Gemini)
  const res1 = await env.sendMessage({ action: 'ANALYZE_QUESTION', payload: { question: 'Q1', options: [] } });
  assert.equal(res1.success, true);
  assert.ok(lastDestination.includes('googleapis.com'), 'Must call Gemini');

  // 2. Switch to Ollama
  await env.sandbox.chrome.storage.local.set({ activeProvider: 'ollama' });
  const res2 = await env.sendMessage({ action: 'ANALYZE_QUESTION', payload: { question: 'Q2', options: [] } });
  assert.equal(res2.success, true);
  assert.ok(lastDestination.includes('11434'), 'Must call Ollama');

  // 3. Switch back to Gemini
  await env.sandbox.chrome.storage.local.set({ activeProvider: 'gemini' });
  const res3 = await env.sendMessage({ action: 'ANALYZE_QUESTION', payload: { question: 'Q3', options: [] } });
  assert.equal(res3.success, true);
  assert.ok(lastDestination.includes('googleapis.com'), 'Must call Gemini');

  // 4. Switch to OpenAI
  await env.sandbox.chrome.storage.local.set({ activeProvider: 'openai' });
  const res4 = await env.sendMessage({ action: 'ANALYZE_QUESTION', payload: { question: 'Q4', options: [] } });
  assert.equal(res4.success, true);
  assert.ok(lastDestination.includes('api.openai.com'), 'Must call OpenAI');
});

test('Multimodal Vision: Both Gemini and OpenAI format images according to official specifications', async () => {
  let capturedGeminiBody = null;
  let capturedOpenAiBody = null;

  const env = setupBackgroundSandbox({
    geminiApiKey: 'AIzaSyVision',
    openaiApiKey: 'sk-proj-Vision'
  }, async (url, options) => {
    if (url.includes('googleapis.com')) {
      capturedGeminiBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ option: 'D', answer: 'Vision Gemini' }) }] } }]
        })
      };
    }
    if (url.includes('api.openai.com')) {
      capturedOpenAiBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ option: 'D', answer: 'Vision OpenAI' }) } }]
        })
      };
    }
    throw new Error('Unexpected destination');
  });

  const payload = {
    question: 'What is shown in the picture?',
    options: [{ id: 'D', text: 'Vision Result' }],
    image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  };

  // Test Gemini multimodal formatting
  await env.sandbox.chrome.storage.local.set({ activeProvider: 'gemini' });
  const resG = await env.sendMessage({ action: 'ANALYZE_QUESTION', payload });
  assert.equal(resG.success, true);
  assert.ok(capturedGeminiBody.contents[0].parts.some(p => p.inlineData && p.inlineData.mimeType === 'image/png'), 'Gemini must have inlineData part');

  // Test OpenAI multimodal formatting
  await env.sandbox.chrome.storage.local.set({ activeProvider: 'openai' });
  const resO = await env.sendMessage({ action: 'ANALYZE_QUESTION', payload });
  assert.equal(resO.success, true);
  const userMsg = capturedOpenAiBody.messages.find(m => m.role === 'user');
  assert.ok(userMsg.content.some(c => c.type === 'image_url' && c.image_url.url.startsWith('data:image/png')), 'OpenAI must have image_url part');
});

test('Safe Logging: API keys and Bearer tokens are NEVER printed to console', async () => {
  const loggedMessages = [];
  const env = setupBackgroundSandbox({
    activeProvider: 'gemini',
    geminiApiKey: 'AIzaSySecretGeminiKey999',
    openaiApiKey: 'sk-proj-SecretOpenAIKey888'
  }, async (url) => {
    if (url.includes('googleapis.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ option: 'A', answer: 'Safe Answer' }) }] } }]
        })
      };
    }
    throw new Error('Unexpected url');
  });

  // Capture all logs
  env.sandbox.console.log = (...args) => loggedMessages.push(JSON.stringify(args));
  env.sandbox.console.warn = (...args) => loggedMessages.push(JSON.stringify(args));
  env.sandbox.console.error = (...args) => loggedMessages.push(JSON.stringify(args));

  await env.sendMessage({ action: 'ANALYZE_QUESTION', payload: { question: 'Safe test', options: [] } });

  const allLogs = loggedMessages.join(' ');
  assert.equal(allLogs.includes('AIzaSySecretGeminiKey999'), false, 'Gemini API key must NEVER be in logs');
  assert.equal(allLogs.includes('sk-proj-SecretOpenAIKey888'), false, 'OpenAI API key must NEVER be in logs');
});

test('Audit: Incomplete or unclosed streaming JSON is safely recovered by resilient parser', async () => {
  const env = setupBackgroundSandbox({
    activeProvider: 'ollama',
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaSelectedModel: 'gemma3:4b'
  }, async (url) => {
    // Return unclosed JSON string without closing brace
    return {
      ok: true,
      status: 200,
      json: async () => ({
        response: '{"option": "C", "answer": "Speed of Light", "reason": "Universal constant in vacuum'
      })
    };
  });

  const res = await env.sendMessage({
    action: 'ANALYZE_QUESTION',
    payload: {
      question: 'What is 3 * 10^8 m/s?',
      options: [{ id: 'C', text: 'Speed of Light' }]
    }
  });

  assert.equal(res.success, true);
  assert.equal(res.data.option, 'C');
  assert.equal(res.data.answer, 'Speed of Light');
});

test('Audit: Cache keys distinguish different images and providers accurately', async () => {
  let callCount = 0;
  const env = setupBackgroundSandbox({
    activeProvider: 'gemini',
    geminiApiKey: 'AIzaSyAuditKey'
  }, async () => {
    callCount++;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ option: 'A', answer: `Answer ${callCount}` }) }] } }]
      })
    };
  });

  // Call with image 1
  const res1 = await env.sendMessage({
    action: 'ANALYZE_QUESTION',
    payload: { question: 'Q', options: [], image: 'data:image/png;base64,AAAAIMAGE1' }
  });

  // Call with different image 2 (same question)
  const res2 = await env.sendMessage({
    action: 'ANALYZE_QUESTION',
    payload: { question: 'Q', options: [], image: 'data:image/png;base64,BBBBIMAGE2' }
  });

  assert.equal(callCount, 2, 'Different images must not collide in cache');
  assert.notEqual(res1.data.answer, res2.data.answer);
});

test('Audit: OpenAI vision requests specify detail high for mathematical formula precision', async () => {
  let capturedBody = null;
  const env = setupBackgroundSandbox({
    activeProvider: 'openai',
    openaiApiKey: 'sk-proj-DetailHighTest'
  }, async (url, options) => {
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ option: 'A', answer: 'Integral Solution' }) } }]
      })
    };
  });

  await env.sendMessage({
    action: 'ANALYZE_QUESTION',
    payload: {
      question: 'Solve the integral',
      options: [{ id: 'A', text: 'Integral Solution' }],
      image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    }
  });

  assert.ok(capturedBody);
  const userContent = capturedBody.messages.find(m => m.role === 'user').content;
  const imgPart = userContent.find(c => c.type === 'image_url');
  assert.equal(imgPart.image_url.detail, 'high', 'detail must be high to preserve math equations and small text');
});

