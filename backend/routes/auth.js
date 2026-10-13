import { Router } from 'express';
import crypto from 'crypto';
import {
  getConnectionStatus,
  startAuthorization,
  completeAuthorization,
  disconnectProvider,
  setActiveProvider,
  getActiveProviderInfo,
  saveProviderApiKey
} from '../services/llm-provider.js';


const router = Router();

// In-memory CSRF & PKCE session store for in-flight OAuth flows (state -> { provider, codeVerifier, createdAt })
const authSessions = new Map();

// Periodic cleanup of expired auth sessions (older than 10 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [state, sess] of authSessions.entries()) {
    if (now - sess.createdAt > 10 * 60 * 1000) {
      authSessions.delete(state);
    }
  }
}, 60 * 1000).unref?.();

/**
 * GET /api/auth/status
 * Returns connection status for all providers and active provider
 */
router.get('/status', (req, res) => {
  try {
    const chatgpt = getConnectionStatus('chatgpt');
    const gemini = getConnectionStatus('gemini');
    const active = getActiveProviderInfo();

    return res.json({
      providers: {
        chatgpt,
        gemini
      },
      active
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to retrieve auth status', message: err.message });
  }
});

/**
 * POST /api/auth/start
 * Initiates official OAuth authorization flow with PKCE
 * Body: { provider: 'chatgpt' | 'gemini', redirectUri?: string }
 */
router.post('/start', async (req, res) => {
  try {
    const { provider, redirectUri } = req.body || {};
    if (!provider || !['chatgpt', 'gemini'].includes(provider.toLowerCase())) {
      return res.status(400).json({ error: 'Invalid provider. Must be "chatgpt" or "gemini".' });
    }

    const authInit = await startAuthorization(provider.toLowerCase(), { redirectUri });

    if (authInit.status === 'error') {
      return res.json({
        success: false,
        status: 'error',
        provider: provider.toLowerCase(),
        error: authInit.error,
        message: authInit.message
      });
    }

    // Store state and codeVerifier for verification in complete step
    if (authInit.state && authInit.codeVerifier) {
      authSessions.set(authInit.state, {
        provider: provider.toLowerCase(),
        codeVerifier: authInit.codeVerifier,
        redirectUri: authInit.redirectUri,
        createdAt: Date.now()
      });
    }

    return res.json({
      success: true,
      status: authInit.status || 'connecting',
      provider: provider.toLowerCase(),
      authUrl: authInit.authUrl || null,
      state: authInit.state || null,
      clientId: authInit.clientId || null,
      message: authInit.message
    });

  } catch (err) {
    return res.status(500).json({ error: 'Failed to start authorization', message: err.message });
  }
});

/**
 * POST /api/auth/complete
 * Completes OAuth flow by exchanging authorization code with PKCE verification
 * Body: { provider, code, state, error }
 */
router.post('/complete', async (req, res) => {
  try {
    const { provider, code, state, error } = req.body || {};

    if (error) {
      return res.status(400).json({ error: 'Authorization was cancelled or denied by provider', details: error });
    }

    if (!provider || !code) {
      return res.status(400).json({ error: 'Missing required authorization code or provider' });
    }

    const session = state ? authSessions.get(state) : null;
    if (state && !session) {
      return res.status(400).json({ error: 'Invalid or expired authorization state (CSRF check failed)' });
    }

    const codeVerifier = session ? session.codeVerifier : undefined;
    const redirectUri = session ? session.redirectUri : undefined;

    const result = await completeAuthorization(provider.toLowerCase(), {
      code,
      state,
      codeVerifier,
      redirectUri
    });

    if (state) {
      authSessions.delete(state);
    }

    return res.json({
      success: true,
      status: result.status,
      provider: provider.toLowerCase(),
      account: result.account
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to complete authorization', message: err.message });
  }
});

/**
 * POST /api/auth/disconnect
 * Revokes and deletes stored credentials for a provider
 * Body: { provider: 'chatgpt' | 'gemini' }
 */
router.post('/disconnect', async (req, res) => {
  try {
    const { provider } = req.body || {};
    if (!provider) {
      return res.status(400).json({ error: 'Provider is required' });
    }

    const result = await disconnectProvider(provider.toLowerCase());
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to disconnect provider', message: err.message });
  }
});

/**
 * POST /api/auth/select
 * Sets the active AI provider
 * Body: { provider: 'chatgpt' | 'gemini' | 'mock' }
 */
router.post('/select', (req, res) => {
  try {
    const { provider } = req.body || {};
    if (!provider) {
      return res.status(400).json({ error: 'Provider is required' });
    }

    const result = setActiveProvider(provider.toLowerCase());
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/auth/save-key
 * Connects a provider directly using their API key
 * Body: { provider: 'chatgpt' | 'gemini', apiKey: string }
 */
router.post('/save-key', async (req, res) => {
  try {
    const { provider, apiKey } = req.body || {};
    if (!provider || !apiKey) {
      return res.status(400).json({ error: 'Provider and apiKey are required' });
    }

    const result = await saveProviderApiKey(provider.toLowerCase(), apiKey.trim());
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});


/**
 * GET /api/auth/callback
 * Browser redirect landing page for OAuth code return
 */
router.get('/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>Authorization Failed</title></head>
        <body style="font-family: system-ui, sans-serif; text-align: center; padding: 40px; background: #0f172a; color: #f8fafc;">
          <h2 style="color: #ef4444;">Authorization Cancelled or Failed</h2>
          <p>${error_description || error}</p>
          <p>You can close this tab and return to the Moodle AI Quick Answer extension.</p>
        </body>
      </html>
    `);
  }

  const session = state ? authSessions.get(state) : null;
  if (!session) {
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>Invalid Session</title></head>
        <body style="font-family: system-ui, sans-serif; text-align: center; padding: 40px; background: #0f172a; color: #f8fafc;">
          <h2 style="color: #f59e0b;">Session Expired or Invalid</h2>
          <p>The authorization session expired. Please return to the extension popup and click Connect again.</p>
        </body>
      </html>
    `);
  }

  try {
    await completeAuthorization(session.provider, {
      code,
      state,
      codeVerifier: session.codeVerifier,
      redirectUri: session.redirectUri
    });
    authSessions.delete(state);

    return res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>Authorization Successful</title></head>
        <body style="font-family: system-ui, sans-serif; text-align: center; padding: 40px; background: #09090b; color: #f4f4f5;">
          <h2 style="color: #10b981;">🎉 Successfully Connected ${session.provider.toUpperCase()}!</h2>
          <p>Your account is now securely linked to Moodle AI Quick Answer.</p>
          <p style="color: #a1a1aa; font-size: 14px;">You can close this window and return to your quiz.</p>
          <script>
            setTimeout(() => { window.close(); }, 2500);
          </script>
        </body>
      </html>
    `);
  } catch (err) {
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>Token Exchange Failed</title></head>
        <body style="font-family: system-ui, sans-serif; text-align: center; padding: 40px; background: #0f172a; color: #f8fafc;">
          <h2 style="color: #ef4444;">Connection Error</h2>
          <p>${err.message}</p>
          <p>Return to the extension and try connecting again.</p>
        </body>
      </html>
    `);
  }
});

export default router;
