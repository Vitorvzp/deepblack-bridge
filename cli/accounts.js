// language: JavaScript, file: cli/accounts.js, target: Node.js (ESM), Windows/Linux
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { resolveFromRoot } from '../src/util/runtime_paths.js';

const ENV_PATH = resolveFromRoot(import.meta.url, '.env');
const ACCOUNTS_FILE = resolveFromRoot(import.meta.url, '.deepblack_accounts.json');

/**
 * Parses .env file into key-value map and raw lines
 */
export function readEnvFile() {
  const envMap = {};
  let lines = [];
  if (fs.existsSync(ENV_PATH)) {
    const raw = fs.readFileSync(ENV_PATH, 'utf8');
    lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const k = trimmed.slice(0, eqIdx).trim();
        const v = trimmed.slice(eqIdx + 1).trim();
        envMap[k] = v;
      }
    }
  }
  return { envMap, lines };
}

/**
 * Updates specific keys in .env preserving all comments and other variables
 */
export function updateEnvFile(updates) {
  let content = '';
  if (fs.existsSync(ENV_PATH)) {
    content = fs.readFileSync(ENV_PATH, 'utf8');
  }

  const lines = content ? content.split(/\r?\n/) : [];
  const handledKeys = new Set();
  const newLines = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      newLines.push(line);
      continue;
    }

    const eqIdx = line.indexOf('=');
    if (eqIdx !== -1) {
      const key = line.slice(0, eqIdx).trim();
      if (key in updates) {
        newLines.push(`${key}=${updates[key]}`);
        handledKeys.add(key);
      } else {
        newLines.push(line);
      }
    } else {
      newLines.push(line);
    }
  }

  // Append any keys that did not exist
  for (const [k, v] of Object.entries(updates)) {
    if (!handledKeys.has(k)) {
      newLines.push(`${k}=${v}`);
    }
  }

  fs.writeFileSync(ENV_PATH, newLines.join('\n'), 'utf8');
}

/**
 * Loads accounts from .deepblack_accounts.json.
 * If missing, seeds from current .env.
 */
export function loadAccounts(filePath = ACCOUNTS_FILE) {
  let store = { activeAccountId: 'acc_1', accounts: [] };

  if (fs.existsSync(filePath)) {
    try {
      store = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!Array.isArray(store.accounts)) store.accounts = [];
    } catch {
      store = { activeAccountId: 'acc_1', accounts: [] };
    }
  }

  // If no accounts exist yet, seed from .env
  if (store.accounts.length === 0) {
    const { envMap } = readEnvFile();
    const token = envMap['DEEPSEEK_AUTH_TOKEN'] || '';
    const cookie = envMap['DEEPSEEK_COOKIE'] || '';
    const userAgent = envMap['DEEPSEEK_USER_AGENT'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
    const deviceId = envMap['DEEPSEEK_DEVICE_ID'] || '4c1dd084-b214-4167-84cf-a98f3b998697';

    const defaultAcc = {
      id: 'acc_1',
      name: 'Conta Principal (.env)',
      token,
      cookie,
      userAgent,
      deviceId,
      status: token ? 'untested' : 'empty',
      lastChecked: null,
      createdAt: new Date().toISOString()
    };

    store.activeAccountId = 'acc_1';
    store.accounts = [defaultAcc];
    saveAccounts(store, filePath);
  }

  return store;
}

/**
 * Saves accounts back to .deepblack_accounts.json (or the given filePath —
 * used by tests to avoid touching the real account store, which holds live
 * captured session cookies).
 */
export function saveAccounts(store, filePath = ACCOUNTS_FILE) {
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf8');
}

/**
 * Marks the account matching `token` with a new status (e.g. 'invalid' the
 * moment DeepSeek itself rejects it with an auth error). Without this, the
 * dashboard keeps showing a token as "valid" for however long it's been
 * since the last manual test, even after we've just observed, live, that it
 * no longer works — exactly the gap that turned a simple expired-token
 * situation into a multi-hour debugging session.
 */
export function markAccountStatusByToken(token, status, filePath = ACCOUNTS_FILE) {
  if (!token) return false;
  const store = loadAccounts(filePath);
  const account = store.accounts.find(a => a.token === token);
  if (!account) return false;
  account.status = status;
  account.lastChecked = new Date().toISOString();
  saveAccounts(store, filePath);
  return true;
}

/**
 * Gets the active account object
 */
export function getActiveAccount() {
  const store = loadAccounts();
  return store.accounts.find(a => a.id === store.activeAccountId) || store.accounts[0] || null;
}

/**
 * Switches the active account, updates .env, and notifies the bridge
 */
export async function switchActiveAccount(accountId) {
  const store = loadAccounts();
  const target = store.accounts.find(a => a.id === accountId);
  if (!target) {
    throw new Error(`Conta com ID "${accountId}" não encontrada.`);
  }

  store.activeAccountId = target.id;
  target.lastUsed = new Date().toISOString();
  saveAccounts(store);

  // Sync to .env
  updateEnvFile({
    DEEPSEEK_AUTH_TOKEN: target.token || '',
    DEEPSEEK_COOKIE: target.cookie || '',
    DEEPSEEK_USER_AGENT: target.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
    DEEPSEEK_DEVICE_ID: target.deviceId || '4c1dd084-b214-4167-84cf-a98f3b998697'
  });

  // Try to notify bridge if running
  let bridgeReloaded = false;
  try {
    const res = await fetch('http://127.0.0.1:5050/v1/auth/reload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: target.token,
        cookie: target.cookie,
        userAgent: target.userAgent,
        deviceId: target.deviceId
      }),
      signal: AbortSignal.timeout(1500)
    });
    if (res.ok) bridgeReloaded = true;
  } catch {
    // Bridge might not be running or endpoint not present yet
  }

  return { target, bridgeReloaded };
}

/**
 * Adds a new account and optionally sets it active
 */
export function addAccount({ name, token, cookie, userAgent, deviceId, setAsActive = false }) {
  const store = loadAccounts();
  const id = `acc_${Date.now().toString(36)}`;
  const newAcc = {
    id,
    name: name || `Conta ${store.accounts.length + 1}`,
    token: token?.trim() || '',
    cookie: cookie?.trim() || '',
    userAgent: userAgent?.trim() || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
    deviceId: deviceId?.trim() || '4c1dd084-b214-4167-84cf-a98f3b998697',
    status: 'untested',
    lastChecked: null,
    createdAt: new Date().toISOString()
  };

  store.accounts.push(newAcc);
  if (setAsActive) {
    store.activeAccountId = id;
  }
  saveAccounts(store);

  if (setAsActive) {
    updateEnvFile({
      DEEPSEEK_AUTH_TOKEN: newAcc.token,
      DEEPSEEK_COOKIE: newAcc.cookie,
      DEEPSEEK_USER_AGENT: newAcc.userAgent,
      DEEPSEEK_DEVICE_ID: newAcc.deviceId
    });
  }

  return newAcc;
}

/**
 * Upserts an account based on token.
 * If account already exists with same token, updates cookie/UA/lastChecked.
 * If new, creates new account.
 */
export function upsertAccount({ name, token, cookie, userAgent, deviceId, setAsActive = true }) {
  if (!token || typeof token !== 'string') {
    throw new Error('Token inválido ou vazio.');
  }
  const cleanToken = token.trim();
  const store = loadAccounts();

  let existing = store.accounts.find(a => a.token === cleanToken);
  let isNew = false;

  if (existing) {
    if (name && existing.name.startsWith('Conta Capturada')) existing.name = name;
    if (cookie) existing.cookie = cookie.trim();
    if (userAgent) existing.userAgent = userAgent.trim();
    if (deviceId) existing.deviceId = deviceId.trim();
    existing.status = 'valid';
    existing.lastChecked = new Date().toISOString();
  } else {
    isNew = true;
    const id = `acc_${Date.now().toString(36)}`;
    existing = {
      id,
      name: name || `Conta Capturada ${store.accounts.length + 1}`,
      token: cleanToken,
      cookie: cookie?.trim() || '',
      userAgent: userAgent?.trim() || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      deviceId: deviceId?.trim() || '4c1dd084-b214-4167-84cf-a98f3b998697',
      status: 'valid',
      lastChecked: new Date().toISOString(),
      createdAt: new Date().toISOString()
    };
    store.accounts.push(existing);
  }

  if (setAsActive || store.activeAccountId === existing.id) {
    store.activeAccountId = existing.id;
    updateEnvFile({
      DEEPSEEK_AUTH_TOKEN: existing.token,
      DEEPSEEK_COOKIE: existing.cookie,
      DEEPSEEK_USER_AGENT: existing.userAgent,
      DEEPSEEK_DEVICE_ID: existing.deviceId
    });
  }

  saveAccounts(store);
  return { account: existing, isNew };
}

/**
 * Deletes an account
 */
export function deleteAccount(accountId) {
  const store = loadAccounts();
  if (store.accounts.length <= 1) {
    throw new Error('Não é possível excluir a única conta cadastrada.');
  }

  const idx = store.accounts.findIndex(a => a.id === accountId);
  if (idx === -1) {
    throw new Error('Conta não encontrada.');
  }

  store.accounts.splice(idx, 1);
  if (store.activeAccountId === accountId) {
    store.activeAccountId = store.accounts[0].id;
    // sync fallback to .env
    const fallback = store.accounts[0];
    updateEnvFile({
      DEEPSEEK_AUTH_TOKEN: fallback.token,
      DEEPSEEK_COOKIE: fallback.cookie,
      DEEPSEEK_USER_AGENT: fallback.userAgent,
      DEEPSEEK_DEVICE_ID: fallback.deviceId
    });
  }
  saveAccounts(store);
  return true;
}

/**
 * Tests an account token directly against the DeepSeek Web API
 */
export async function testAccountToken(account) {
  const startTime = Date.now();
  if (!account || !account.token) {
    return { valid: false, error: 'Token vazio', latencyMs: 0 };
  }

  const headers = {
    'authorization': `Bearer ${account.token}`,
    'cookie': account.cookie || '',
    'user-agent': account.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'accept': '*/*',
    'x-client-platform': 'web',
    'x-client-version': '2.5.0',
    'x-client-bundle-id': 'com.deepseek.chat',
    'x-client-locale': 'en_US',
    'x-client-timezone-offset': '-10800',
    'x-device-id': account.deviceId || '4c1dd084-b214-4167-84cf-a98f3b998697'
  };

  try {
    const url = new URL('https://chat.deepseek.com/api/v0/chat_session/fetch_page?lte_cursor.pinned=false');
    const resData = await new Promise((resolve, reject) => {
      const req = https.request(url, {
        method: 'GET',
        headers,
        rejectUnauthorized: false
      }, (res) => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode, body: JSON.parse(raw) });
          } catch {
            resolve({ statusCode: res.statusCode, raw });
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(8000, () => {
        req.destroy(new Error('Timeout ao conectar com DeepSeek'));
      });
      req.end();
    });

    const latencyMs = Date.now() - startTime;
    const isOk = resData.statusCode === 200 && resData.body?.code === 0;
    const sessionCount = resData.body?.data?.biz_data?.chat_sessions?.length ?? 0;

    // Update account record
    const store = loadAccounts();
    const acc = store.accounts.find(a => a.id === account.id);
    if (acc) {
      acc.status = isOk ? 'valid' : 'invalid';
      acc.lastChecked = new Date().toISOString();
      acc.sessionCount = sessionCount;
      saveAccounts(store);
    }

    if (isOk) {
      return { valid: true, sessionCount, latencyMs, code: 0 };
    } else {
      const errMsg = resData.body?.msg || `HTTP ${resData.statusCode}`;
      return { valid: false, error: errMsg, latencyMs, code: resData.body?.code };
    }
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const store = loadAccounts();
    const acc = store.accounts.find(a => a.id === account.id);
    if (acc) {
      acc.status = 'error';
      acc.lastChecked = new Date().toISOString();
      saveAccounts(store);
    }
    return { valid: false, error: err.message, latencyMs };
  }
}

/**
 * Formats token as masked preview: "kjssQwx...DF+"
 */
export function maskToken(token) {
  if (!token || typeof token !== 'string') return '(nenhum)';
  if (token.length <= 12) return token;
  return `${token.slice(0, 8)}...${token.slice(-4)}`;
}
