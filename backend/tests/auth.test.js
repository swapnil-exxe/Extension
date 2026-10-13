import test from 'node:test';
import assert from 'node:assert/strict';
import app from '../server.js';
import {
  getConnectionStatus,
  startAuthorization,
  completeAuthorization,
  disconnectProvider,
  setActiveProvider,
  getActiveProviderInfo
} from '../services/llm-provider.js';

let server;
let baseUrl;

test.before(async () => {
  process.env.NODE_ENV = 'test';
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

test('GET /api/auth/status returns initial providers and active selection', async () => {
  const res = await fetch(`${baseUrl}/api/auth/status`);
  assert.equal(res.status, 200);
  const data = await res.json();

  assert.ok(data.providers);
  assert.ok(data.providers.chatgpt);
  assert.ok(data.providers.gemini);
  assert.ok(data.active);
  assert.equal(typeof data.providers.chatgpt.status, 'string');
  assert.equal(typeof data.providers.gemini.status, 'string');
});

test('POST /api/auth/start generates valid Google Gemini OAuth flow with PKCE', async () => {
  const res = await fetch(`${baseUrl}/api/auth/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'gemini' })
  });

  assert.equal(res.status, 200);
  const data = await res.json();

  assert.equal(data.success, true);
  assert.equal(data.provider, 'gemini');
  assert.ok(data.authUrl);
  assert.ok(data.state);
  assert.ok(data.authUrl.includes('accounts.google.com'));
  assert.ok(data.authUrl.includes('generative-language'));
  assert.ok(data.authUrl.includes('code_challenge='));
  assert.ok(data.authUrl.includes('code_challenge_method=S256'));
});

test('POST /api/auth/start generates valid ChatGPT SIWC flow with PKCE', async () => {
  const res = await fetch(`${baseUrl}/api/auth/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'chatgpt' })
  });

  assert.equal(res.status, 200);
  const data = await res.json();

  assert.equal(data.success, true);
  assert.equal(data.provider, 'chatgpt');
  assert.ok(data.authUrl);
  assert.ok(data.state);
  assert.ok(data.authUrl.includes('auth.openai.com'));
  assert.ok(data.authUrl.includes('code_challenge='));
});

test('POST /api/auth/complete validates CSRF state and exchanges token', async () => {
  // Start Gemini authorization to create an in-flight session
  const startRes = await fetch(`${baseUrl}/api/auth/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'gemini' })
  });
  const startData = await startRes.json();
  const validState = startData.state;

  // Complete with authorization code
  const completeRes = await fetch(`${baseUrl}/api/auth/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'gemini',
      code: 'mock_authorization_code_123',
      state: validState
    })
  });

  assert.equal(completeRes.status, 200);
  const completeData = await completeRes.json();
  assert.equal(completeData.success, true);
  assert.equal(completeData.status, 'connected');
  assert.equal(completeData.provider, 'gemini');
  assert.ok(completeData.account.email);

  // Status endpoint now reflects connected Gemini
  const statusRes = await fetch(`${baseUrl}/api/auth/status`);
  const statusData = await statusRes.json();
  assert.equal(statusData.providers.gemini.status, 'connected');
});

test('POST /api/auth/complete rejects invalid or forged state (CSRF protection)', async () => {
  const res = await fetch(`${baseUrl}/api/auth/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'gemini',
      code: 'forged_code',
      state: 'non_existent_or_forged_state'
    })
  });

  assert.equal(res.status, 400);
  const data = await res.json();
  assert.ok(data.error.includes('state') || data.error.includes('CSRF'));
});

test('POST /api/auth/select switches active provider', async () => {
  const res = await fetch(`${baseUrl}/api/auth/select`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'gemini' })
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.activeProvider, 'gemini');

  // Verify status reflects it
  const statusRes = await fetch(`${baseUrl}/api/auth/status`);
  const statusData = await statusRes.json();
  assert.equal(statusData.active.provider, 'gemini');
});

test('POST /api/auth/disconnect revokes credentials and resets status', async () => {
  const res = await fetch(`${baseUrl}/api/auth/disconnect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'gemini' })
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.status, 'not_connected');

  const statusRes = await fetch(`${baseUrl}/api/auth/status`);
  const statusData = await statusRes.json();
  assert.equal(statusData.providers.gemini.status, 'not_connected');
});

test('GET /api/auth/callback handles browser OAuth redirect landing', async () => {
  // Start flow
  const startRes = await fetch(`${baseUrl}/api/auth/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'chatgpt' })
  });
  const { state } = await startRes.json();

  // Simulated browser redirect from OAuth provider
  const callbackRes = await fetch(`${baseUrl}/api/auth/callback?code=mock_oauth_code_xyz&state=${state}`);
  assert.equal(callbackRes.status, 200);
  const html = await callbackRes.text();
  assert.ok(html.includes('Successfully Connected'));
});
