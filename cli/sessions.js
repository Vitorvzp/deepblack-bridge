// language: JavaScript, file: cli/sessions.js, target: Node.js (ESM), Windows/Linux
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { getActiveAccount } from './accounts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const SESSIONS_FILE = path.join(ROOT_DIR, '.deepblack_sessions.json');
const SINGLE_SESSION_FILE = path.join(ROOT_DIR, '.deepblack_session.json');

export function formatRelativeTime(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const now = new Date();
  const diffSec = Math.floor((now - d) / 1000);

  if (diffSec < 60) return 'agora há pouco';
  if (diffSec < 3600) return `há ${Math.floor(diffSec / 60)} min`;
  if (diffSec < 86400) return `há ${Math.floor(diffSec / 3600)}h`;
  const day = String(d.getDate()).padStart(2, '0');
  const mon = String(d.getMonth() + 1).padStart(2, '0');
  const hr = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${day}/${mon} ${hr}:${min}`;
}

/**
 * Loads all active sessions from disk and optionally merges from running bridge
 */
export async function loadSessions(includeBridge = true) {
  let sessionsMap = {};

  // 1. Read .deepblack_sessions.json
  if (fs.existsSync(SESSIONS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      if (data && typeof data === 'object') {
        sessionsMap = { ...data };
      }
    } catch {}
  }

  // 2. Also check single .deepblack_session.json if not present
  if (fs.existsSync(SINGLE_SESSION_FILE)) {
    try {
      const s = JSON.parse(fs.readFileSync(SINGLE_SESSION_FILE, 'utf8'));
      if (s?.sessionId && !sessionsMap['default']) {
        sessionsMap['default'] = {
          deepseekSessionId: s.sessionId,
          lastResponseMessageId: s.lastResponseMessageId,
          title: s.title || 'Default Session',
          updatedAt: s.updatedAt || new Date().toISOString()
        };
      }
    } catch {}
  }

  // 3. Try to merge from running bridge server if available
  if (includeBridge) {
    try {
      const res = await fetch('http://127.0.0.1:5050/v1/session', {
        signal: AbortSignal.timeout(1000)
      });
      if (res.ok) {
        const body = await res.json();
        if (body?.sessions && typeof body.sessions === 'object') {
          sessionsMap = { ...sessionsMap, ...body.sessions };
        }
      }
    } catch {}
  }

  const list = Object.entries(sessionsMap).map(([key, s]) => {
    return {
      key,
      deepseekSessionId: s.deepseekSessionId || '-',
      title: s.title || 'Sem título',
      lastResponseMessageId: s.lastResponseMessageId ?? '-',
      createdAt: s.createdAt || null,
      updatedAt: s.updatedAt || null,
      relativeTime: formatRelativeTime(s.updatedAt || s.createdAt),
      raw: s
    };
  });

  // Sort descending by updatedAt
  list.sort((a, b) => {
    const timeA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const timeB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return timeB - timeA;
  });

  return list;
}

/**
 * Resets / deletes a session locally and on bridge
 */
export async function resetSession(sessionKey) {
  // 1. Notify bridge
  try {
    await fetch(`http://127.0.0.1:5050/v1/session/reset?id=${encodeURIComponent(sessionKey)}`, {
      signal: AbortSignal.timeout(1500)
    });
  } catch {}

  // 2. Remove from local .deepblack_sessions.json
  if (fs.existsSync(SESSIONS_FILE)) {
    try {
      const map = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      if (sessionKey === 'all') {
        fs.writeFileSync(SESSIONS_FILE, '{}', 'utf8');
      } else if (map[sessionKey]) {
        delete map[sessionKey];
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(map, null, 2), 'utf8');
      }
    } catch {}
  }

  return true;
}

/**
 * Fetches message history from DeepSeek Web API for a given deepseekSessionId
 */
export async function fetchSessionHistory(deepseekSessionId) {
  const activeAcc = getActiveAccount();
  if (!activeAcc || !activeAcc.token) {
    throw new Error('Nenhuma conta ativa para consultar o DeepSeek.');
  }

  const headers = {
    'authorization': `Bearer ${activeAcc.token}`,
    'cookie': activeAcc.cookie || '',
    'user-agent': activeAcc.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'accept': '*/*',
    'x-client-platform': 'web',
    'x-client-version': '2.5.0',
    'x-device-id': activeAcc.deviceId || '4c1dd084-b214-4167-84cf-a98f3b998697'
  };

  const url = new URL(`https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=${deepseekSessionId}`);

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET',
      headers,
      rejectUnauthorized: false
    }, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.code === 0) {
            const biz = parsed.data?.biz_data || {};
            const messages = (biz.chat_messages || []).map(m => {
              let content = m.content || '';
              let thinking = m.thinking_content || '';
              if (Array.isArray(m.fragments)) {
                for (const f of m.fragments) {
                  if (f.type === 'REQUEST' || f.type === 'RESPONSE') {
                    content += (content ? '\n' : '') + (f.content || '');
                  } else if (f.type === 'THINK') {
                    thinking += (thinking ? '\n' : '') + (f.content || '');
                  }
                }
              }
              return {
                id: m.message_id !== undefined ? m.message_id : m.id,
                parentId: m.parent_id !== undefined ? m.parent_id : null,
                role: (m.role || 'USER').toLowerCase(),
                content,
                thinking,
                model: m.model || '',
                createdAt: m.inserted_at ? new Date(m.inserted_at * 1000).toISOString() : (m.created_at ? new Date(m.created_at * 1000).toISOString() : null)
              };
            });
            resolve({
              currentMessageId: biz.chat_session?.current_message_id,
              title: biz.chat_session?.title,
              messages
            });
          } else {
            reject(new Error(parsed.msg || `DeepSeek error code ${parsed.code}`));
          }
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => {
      req.destroy(new Error('Timeout ao buscar histórico'));
    });
    req.end();
  });
}

/**
 * Scans remote DeepSeek chat sessions and cleans automated test sessions
 */
export async function cleanTestSessions(execute = false) {
  const activeAcc = getActiveAccount();
  if (!activeAcc || !activeAcc.token) {
    throw new Error('Conta ativa não configurada.');
  }

  const testPatterns = [
    'guardar número secreto',
    'node version',
    'título node -v',
    'por que não funcionou',
    'ler package.json',
    'capital da frança',
    'ignore injected policy',
    'initial test',
    'deepblack_live_ok',
    'lembre-se do número secreto',
    'teste de parent null'
  ];

  const headers = {
    'authorization': `Bearer ${activeAcc.token}`,
    'cookie': activeAcc.cookie || '',
    'user-agent': activeAcc.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'content-type': 'application/json',
    'accept': '*/*',
    'x-client-platform': 'web',
    'x-client-version': '2.5.0',
    'x-device-id': activeAcc.deviceId || '4c1dd084-b214-4167-84cf-a98f3b998697'
  };

  const fetchRes = await new Promise((resolve, reject) => {
    const req = https.request('https://chat.deepseek.com/api/v0/chat_session/fetch_page?lte_cursor.pinned=false', {
      method: 'GET',
      headers,
      rejectUnauthorized: false
    }, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });

  const remoteSessions = fetchRes.data?.biz_data?.chat_sessions || [];
  const toDelete = remoteSessions.filter(s => {
    const t = (s.title || '').toLowerCase();
    return testPatterns.some(p => t.includes(p));
  });

  if (execute && toDelete.length > 0) {
    const ids = toDelete.map(s => s.id);
    const postBody = JSON.stringify({ chat_session_ids: ids });
    const delHeaders = { ...headers, 'content-length': Buffer.byteLength(postBody) };

    await new Promise((resolve, reject) => {
      const req = https.request('https://chat.deepseek.com/api/v0/chat_session/delete', {
        method: 'POST',
        headers: delHeaders,
        rejectUnauthorized: false
      }, (res) => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => resolve(raw));
      });
      req.on('error', reject);
      req.write(postBody);
      req.end();
    });
  }

  return { found: toDelete, executed: execute };
}
