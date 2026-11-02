import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import app from '../server.js';
import {
  detectModelCapability,
  formatBytes,
  getOllamaUrl,
  checkOllamaStatus,
  getInstalledModels,
  callOllama
} from '../services/ollama-service.js';
import { isVisionSupported, getLLMAnswer } from '../services/llm-provider.js';

let appServer;
let appBaseUrl;

// Mock Ollama HTTP Server
let mockOllamaServer;
let mockOllamaPort;
let mockOllamaUrl;

// Configurable state for mock Ollama responses
let mockOllamaState = {
  version: '0.5.1',
  models: [],
  failConnection: false,
  failTags: false,
  failGenerate: false,
  generateDelayMs: 0,
  generateResponseText: JSON.stringify({
    answer: 'Binary Search',
    option: 'B',
    status: 'success',
    reason: 'Binary search runs in O(log n) time on sorted arrays.',
    confidence: 0.98
  })
};

test.before(async () => {
  process.env.NODE_ENV = 'test';

  // 1. Start Mock Ollama Server
  mockOllamaServer = http.createServer((req, res) => {
    if (mockOllamaState.failConnection) {
      req.socket.destroy();
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/api/version')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: mockOllamaState.version }));
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/api/tags')) {
      if (mockOllamaState.failTags) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Ollama Error' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: mockOllamaState.models }));
      return;
    }

    if (req.method === 'POST' && req.url.startsWith('/api/generate')) {
      if (mockOllamaState.failGenerate) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Generation crashed' }));
        return;
      }

      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');

        // Check if delay requested
        const sendResponse = () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            model: parsed.model,
            created_at: new Date().toISOString(),
            response: mockOllamaState.generateResponseText,
            done: true,
            prompt_eval_count: 45,
            eval_count: 32
          }));
        };

        if (mockOllamaState.generateDelayMs > 0) {
          setTimeout(sendResponse, mockOllamaState.generateDelayMs);
        } else {
          sendResponse();
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  await new Promise(resolve => {
    mockOllamaServer.listen(0, '127.0.0.1', () => {
      mockOllamaPort = mockOllamaServer.address().port;
      mockOllamaUrl = `http://127.0.0.1:${mockOllamaPort}`;
      resolve();
    });
  });

  // 2. Start Express app test server
  await new Promise(resolve => {
    appServer = app.listen(0, '127.0.0.1', () => {
      const port = appServer.address().port;
      appBaseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise(resolve => mockOllamaServer.close(resolve));
  await new Promise(resolve => appServer.close(resolve));
});

// ==========================================
// 1. MODEL CAPABILITY DETECTION TESTS
// ==========================================
test('Capability Detection: Text models identify as Text', () => {
  const gemma = detectModelCapability({
    name: 'gemma2:9b',
    details: { family: 'gemma2', families: ['gemma2'] }
  });
  assert.equal(gemma, 'Text');

  const llama = detectModelCapability({
    name: 'llama3.2:latest',
    details: { family: 'llama', families: ['llama'] }
  });
  assert.equal(llama, 'Text');

  const qwen = detectModelCapability({
    name: 'qwen2.5:7b',
    details: { family: 'qwen2.5', families: ['qwen2.5'] }
  });
  assert.equal(qwen, 'Text');
});

test('Capability Detection: Vision models identify as Vision', () => {
  const gemma3 = detectModelCapability({
    name: 'gemma3:4b',
    details: { family: 'gemma3', families: ['gemma3', 'clip'] },
    capabilities: ['completion', 'vision']
  });
  assert.equal(gemma3, 'Vision');

  const llamaVision = detectModelCapability({
    name: 'llama3.2-vision:11b',
    details: { family: 'mllama', families: ['mllama', 'clip'] }
  });
  assert.equal(llamaVision, 'Vision');

  const llava = detectModelCapability({
    name: 'llava:7b',
    details: { family: 'llava', families: ['llava', 'clip'] }
  });
  assert.equal(llava, 'Vision');

  const moondream = detectModelCapability({
    name: 'moondream:1.8b',
    details: { family: 'moondream', families: ['moondream'] }
  });
  assert.equal(moondream, 'Vision');
});

test('Capability Detection: Unrecognized model metadata identifies as Unknown', () => {
  const unknownModel = detectModelCapability({
    name: 'custom-internal-exp-v1:latest',
    details: { family: 'proprietary_arch', families: ['proprietary_arch'] }
  });
  assert.equal(unknownModel, 'Unknown');
});

test('FormatBytes accurately formats model file sizes', () => {
  assert.equal(formatBytes(2490000000), '2.3 GB');
  assert.equal(formatBytes(4700000000), '4.4 GB');
  assert.equal(formatBytes(0), '0 B');
});

// ==========================================
// 2. MODEL DETECTION TESTS
// ==========================================
test('Model Detection: One installed model', async () => {
  mockOllamaState.models = [
    {
      name: 'gemma3:4b',
      model: 'gemma3:4b',
      size: 2490000000,
      modified_at: '2026-11-01T12:00:00Z',
      details: {
        family: 'gemma3',
        families: ['gemma3'],
        parameter_size: '4B',
        quantization_level: 'Q4_K_M'
      }
    }
  ];

  const res = await fetch(`${appBaseUrl}/api/ollama/models?url=${encodeURIComponent(mockOllamaUrl)}`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.models.length, 1);
  assert.equal(data.models[0].name, 'gemma3:4b');
  assert.equal(data.models[0].tag, '4b');
  assert.equal(data.models[0].capability, 'Vision');
  assert.equal(data.models[0].parameterSize, '4B');
});

test('Model Detection: Multiple installed models with mixed capabilities', async () => {
  mockOllamaState.models = [
    {
      name: 'gemma3:4b',
      size: 2490000000,
      details: { family: 'gemma3', parameter_size: '4B' }
    },
    {
      name: 'llama3.2-vision:11b',
      size: 7900000000,
      details: { family: 'mllama', families: ['mllama', 'clip'], parameter_size: '11B' }
    },
    {
      name: 'qwen2.5:7b',
      size: 4700000000,
      details: { family: 'qwen2.5', parameter_size: '7B' }
    }
  ];

  const res = await fetch(`${appBaseUrl}/api/ollama/models?url=${encodeURIComponent(mockOllamaUrl)}`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.models.length, 3);
  assert.equal(data.models[0].name, 'gemma3:4b');
  assert.equal(data.models[0].capability, 'Vision');
  assert.equal(data.models[1].name, 'llama3.2-vision:11b');
  assert.equal(data.models[1].capability, 'Vision');
  assert.equal(data.models[2].name, 'qwen2.5:7b');
  assert.equal(data.models[2].capability, 'Text');
});

test('Model Detection: No installed models returns clear instructions', async () => {
  mockOllamaState.models = [];

  const res = await fetch(`${appBaseUrl}/api/ollama/models?url=${encodeURIComponent(mockOllamaUrl)}`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.models.length, 0);
  assert.ok(data.message.includes('No local models found'));
  assert.ok(data.message.includes('ollama pull'));
});

test('Model Detection: Ollama unavailable handles connection error gracefully', async () => {
  const invalidUrl = 'http://127.0.0.1:59999'; // closed port
  const res = await fetch(`${appBaseUrl}/api/ollama/status?url=${encodeURIComponent(invalidUrl)}`);
  assert.equal(res.status, 503);
  const data = await res.json();
  assert.equal(data.ok, false);
  assert.ok(data.error.includes('Cannot connect') || data.error.includes('refused'));
});

// ==========================================
// 3. MODEL SELECTION & VALIDATION TESTS
// ==========================================
test('Model Selection: POST /api/solve rejects missing model parameter', async () => {
  const res = await fetch(`${appBaseUrl}/api/solve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'ollama',
      question: 'What is 2+2?',
      ollamaUrl: mockOllamaUrl
    })
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.ok(data.error.includes('No local Ollama model specified'));
});

test('Model Selection: Model removed after selection is rejected with clear terminal guidance', async () => {
  // Only gemma3:4b is installed
  mockOllamaState.models = [{ name: 'gemma3:4b', size: 2490000000, details: { family: 'gemma3' } }];

  // User asks for llama3.2 which was deleted
  const res = await fetch(`${appBaseUrl}/api/solve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'ollama',
      model: 'llama3.2:latest',
      question: 'What is 2+2?',
      ollamaUrl: mockOllamaUrl
    })
  });

  assert.equal(res.status, 400);
  const data = await res.json();
  assert.ok(data.error.includes('is not installed in Ollama'));
  assert.ok(data.error.includes('ollama pull llama3.2:latest'));
});

// ==========================================
// 4. AI GENERATION TESTS
// ==========================================
test('AI Generation: Text question evaluation via POST /api/solve', async () => {
  mockOllamaState.models = [{ name: 'gemma3:4b', size: 2490000000, details: { family: 'gemma3' } }];
  mockOllamaState.generateResponseText = JSON.stringify({
    answer: 'Stack',
    option: 'B',
    status: 'success',
    reason: 'A stack operates on Last-In-First-Out.',
    confidence: 0.99
  });

  const res = await fetch(`${appBaseUrl}/api/solve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'ollama',
      model: 'gemma3:4b',
      question: 'Which data structure follows LIFO?',
      options: [
        { id: 'A', text: 'Queue' },
        { id: 'B', text: 'Stack' }
      ],
      ollamaUrl: mockOllamaUrl
    })
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.option, 'B');
  assert.equal(data.answer, 'Stack');
  assert.equal(data.status, 'success');
  assert.equal(data.confidence, 0.99);
  assert.equal(data.realUsage.provider, 'ollama');
  assert.equal(data.realUsage.modelUsed, 'gemma3:4b');
});

test('AI Generation: Text question via unified POST /api/answer with provider="ollama"', async () => {
  mockOllamaState.models = [{ name: 'gemma3:4b', size: 2490000000, details: { family: 'gemma3' } }];
  mockOllamaState.generateResponseText = JSON.stringify({
    answer: 'O(log n)',
    option: 'A',
    status: 'success',
    reason: 'Binary search halves the search space each step.',
    confidence: 0.95
  });

  const res = await fetch(`${appBaseUrl}/api/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'ollama',
      model: 'gemma3:4b',
      question: 'What is the time complexity of binary search?',
      options: [
        { id: 'A', text: 'O(log n)' },
        { id: 'B', text: 'O(n)' }
      ],
      ollamaUrl: mockOllamaUrl
    })
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.option, 'A');
  assert.equal(data.answer, 'O(log n)');
});

test('AI Generation: Text-only model receiving image input is rejected with clear warning', async () => {
  mockOllamaState.models = [{ name: 'gemma2:9b', size: 5400000000, details: { family: 'gemma2' } }];

  const res = await fetch(`${appBaseUrl}/api/solve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'ollama',
      model: 'gemma2:9b',
      question: 'Solve the question in image',
      image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      ollamaUrl: mockOllamaUrl
    })
  });

  assert.equal(res.status, 400);
  const data = await res.json();
  assert.ok(data.error.includes('is a text-only model and does not support image questions'));
  assert.ok(data.error.includes('llama3.2-vision') || data.error.includes('llava') || data.error.includes('gemma3'));
});

test('AI Generation: Vision model accepts image and solves correctly', async () => {
  mockOllamaState.models = [
    {
      name: 'llama3.2-vision:11b',
      size: 7900000000,
      details: { family: 'mllama', families: ['mllama', 'clip'] }
    }
  ];
  mockOllamaState.generateResponseText = JSON.stringify({
    answer: 'Resistor',
    option: 'C',
    status: 'success',
    reason: 'The circuit diagram depicts a zigzag resistor symbol.',
    confidence: 0.94
  });

  const res = await fetch(`${appBaseUrl}/api/solve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'ollama',
      model: 'llama3.2-vision:11b',
      question: 'Identify the circuit component in the diagram',
      image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      options: [
        { id: 'A', text: 'Capacitor' },
        { id: 'B', text: 'Inductor' },
        { id: 'C', text: 'Resistor' }
      ],
      ollamaUrl: mockOllamaUrl
    })
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.option, 'C');
  assert.equal(data.answer, 'Resistor');
});

test('AI Generation: Multiple images with vision model are processed in DOM order', async () => {
  mockOllamaState.models = [
    {
      name: 'llama3.2-vision:11b',
      size: 7900000000,
      details: { family: 'mllama', families: ['mllama', 'clip'] }
    }
  ];
  mockOllamaState.generateResponseText = JSON.stringify({
    answer: 'Graph Isomorphism',
    option: 'A',
    status: 'success',
    reason: 'Both graphs have identical adjacency matrices.',
    confidence: 0.92
  });

  const res = await fetch(`${appBaseUrl}/api/solve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'ollama',
      model: 'llama3.2-vision:11b',
      question: 'Compare Graph 1 and Graph 2',
      images: [
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
      ],
      ollamaUrl: mockOllamaUrl
    })
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.option, 'A');
  assert.equal(data.answer, 'Graph Isomorphism');
});

test('AI Generation: Generation timeout produces clear user-friendly error', async () => {
  mockOllamaState.models = [{ name: 'gemma3:4b', size: 2490000000, details: { family: 'gemma3' } }];
  mockOllamaState.generateDelayMs = 200; // Delay response past test timeout

  await assert.rejects(
    async () => {
      await callOllama(
        {
          model: 'gemma3:4b',
          question: 'Very slow calculation'
        },
        {
          ollamaUrl: mockOllamaUrl,
          timeoutMs: 50 // Short 50ms timeout for testing
        }
      );
    },
    /timed out/i
  );

  mockOllamaState.generateDelayMs = 0;
});

test('AI Generation: Ollama service failure returns clean error', async () => {
  mockOllamaState.models = [{ name: 'gemma3:4b', size: 2490000000, details: { family: 'gemma3' } }];
  mockOllamaState.failGenerate = true;

  const res = await fetch(`${appBaseUrl}/api/solve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'ollama',
      model: 'gemma3:4b',
      question: 'Will this fail?',
      ollamaUrl: mockOllamaUrl
    })
  });

  assert.equal(res.status, 500);
  const data = await res.json();
  assert.ok(data.error.includes('Ollama generation failed') || data.message.includes('Ollama generation failed'));
  mockOllamaState.failGenerate = false;
});

test('Post-processing: Eliminates uncertainty and hedges from model output', async () => {
  mockOllamaState.models = [{ name: 'gemma3:4b', size: 2490000000, details: { family: 'gemma3' } }];
  mockOllamaState.generateResponseText = JSON.stringify({
    option: 'UNCERTAIN',
    answer: 'Question needs verification or cannot determine',
    reason: 'Option C is likely correct based on algorithmic properties',
    confidence: 0.4
  });

  const res = await fetch(`${appBaseUrl}/api/solve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'ollama',
      model: 'gemma3:4b',
      question: 'What is the recurrence relation for Merge Sort?',
      options: [
        { id: 'A', text: 'T(n) = T(n-1) + 1' },
        { id: 'B', text: 'T(n) = T(n/2) + 1' },
        { id: 'C', text: 'T(n) = 2T(n/2) + O(n)' },
        { id: 'D', text: 'T(n) = 2T(n/2) + O(n^2)' }
      ],
      ollamaUrl: mockOllamaUrl
    })
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  // Uncertainty must be purged and repaired
  assert.notEqual(data.option, 'UNCERTAIN');
  assert.equal(data.option, 'C');
  assert.equal(data.answer, 'T(n) = 2T(n/2) + O(n)');
  assert.equal(data.status, 'success');
  assert.ok(data.confidence >= 0.70);
});

test('Manifest: Ensures all_frames is enabled for iframe quiz compatibility', async () => {
  const fs = await import('fs');
  const manifestRaw = fs.readFileSync(new URL('../../extension/manifest.json', import.meta.url), 'utf8');
  const manifest = JSON.parse(manifestRaw);
  assert.ok(manifest.content_scripts, 'Content scripts defined');
  assert.equal(manifest.content_scripts[0].all_frames, true, 'all_frames must be true');
});
