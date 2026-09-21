import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { solveChallenge } from './pow.js';
import { markAccountStatusByToken } from '../cli/accounts.js';
import { formatMessagesToPrompt } from './agent_prompt.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Simple .env parser if dotenv is not installed
function loadEnv() {
  const envPath = path.resolve(__dirname, '../.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    const parsedKeys = new Set();
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        process.env[key] = val;
        parsedKeys.add(key);
      }
    }
    // If FORCE_DEEPSEEK_SESSION_ID was commented out in .env, remove from process.env
    if (!parsedKeys.has('FORCE_DEEPSEEK_SESSION_ID')) {
      delete process.env.FORCE_DEEPSEEK_SESSION_ID;
    }
  }
}

loadEnv();

export class DeepSeekWebClient {
  constructor(config = {}) {
    this.token = config.token || process.env.DEEPSEEK_AUTH_TOKEN;
    this.cookie = config.cookie || process.env.DEEPSEEK_COOKIE;
    this.userAgent = config.userAgent || process.env.DEEPSEEK_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    this.deviceId = config.deviceId || process.env.DEEPSEEK_DEVICE_ID || '4c1dd084-b214-4167-84cf-a98f3b998697';
    this.useProxy = (config.useProxy ?? process.env.USE_GHOSTWIRE_PROXY) === 'true';
    this.proxyUrl = config.proxyUrl || process.env.GHOSTWIRE_PROXY_URL || 'http://127.0.0.1:8081';

    this.sessionFilePath = config.sessionFilePath || path.resolve(__dirname, '../.deepblack_sessions.json');
    this.sessions = {}; // externalId -> { deepseekSessionId, lastResponseMessageId, title, needsTitleUpdate }

    // Configurable (not just hardcoded to the real .deepblack_accounts.json)
    // so tests can verify the auth-failure -> mark-invalid integration
    // without ever touching the real account store, which holds live
    // captured session cookies. `undefined` here means "use accounts.js's
    // own default real path" — accounts.js's functions already default to
    // that when no explicit path is passed.
    this.accountsFilePath = config.accountsFilePath;

    // Rate-limit self-protection. DeepSeek Web throttles per *account*, not
    // per chat_session_id, so this state is shared across every session and
    // both models (deepseek-reasoner / deepseek-chat) on this client. Kept in
    // a separate file (not inside .deepblack_sessions.json) so it never
    // pollutes session-count metrics or gets clobbered by resetSession(null).
    this.rateLimitFilePath = config.rateLimitFilePath || path.resolve(__dirname, '../.deepblack_ratelimit.json');
    this.rateLimitedUntil = 0; // epoch ms; 0 or past = not currently limited
    this.lastRateLimitReason = null;
    this._requestTimestamps = []; // sliding window for burst detection

    if (!this.token) {
      throw new Error('DEEPSEEK_AUTH_TOKEN is required.');
    }

    this.loadSessions();
    this._loadRateLimit();
  }

  updateCredentials(creds = {}) {
    if (creds.token) this.token = creds.token;
    if (creds.cookie !== undefined) this.cookie = creds.cookie;
    if (creds.userAgent) this.userAgent = creds.userAgent;
    if (creds.deviceId) this.deviceId = creds.deviceId;
    return true;
  }

  loadSessions() {
    try {
      if (fs.existsSync(this.sessionFilePath)) {
        const data = JSON.parse(fs.readFileSync(this.sessionFilePath, 'utf8'));
        if (data && typeof data === 'object') {
          this.sessions = data;
          return true;
        }
      }
    } catch {}
    this.sessions = {};
    return false;
  }

  saveSessions() {
    try {
      fs.writeFileSync(this.sessionFilePath, JSON.stringify(this.sessions, null, 2), 'utf8');
    } catch (err) {
      console.error('Failed to save sessions persistence file:', err.message);
    }
  }

  /**
   * Restores an in-progress cooldown across a server restart. Without this,
   * restarting DeepBlack mid-cooldown (e.g. to deploy a code change) silently
   * discards the wait and immediately resumes hammering an account that's
   * still actively throttled — compounding the exact problem the cooldown
   * exists to avoid.
   */
  _loadRateLimit() {
    try {
      if (fs.existsSync(this.rateLimitFilePath)) {
        const data = JSON.parse(fs.readFileSync(this.rateLimitFilePath, 'utf8'));
        if (data && typeof data.until === 'number' && data.until > Date.now()) {
          this.rateLimitedUntil = data.until;
          this.lastRateLimitReason = data.reason || null;
          console.warn(`[DeepSeek Web] Restored active cooldown from disk — still limited for ${Math.round((data.until - Date.now()) / 1000)}s.`);
        }
      }
    } catch {}
  }

  _saveRateLimit() {
    try {
      if (this.rateLimitedUntil > Date.now()) {
        fs.writeFileSync(this.rateLimitFilePath, JSON.stringify({ until: this.rateLimitedUntil, reason: this.lastRateLimitReason }), 'utf8');
      } else if (fs.existsSync(this.rateLimitFilePath)) {
        fs.unlinkSync(this.rateLimitFilePath);
      }
    } catch (err) {
      console.error('Failed to save rate-limit persistence file:', err.message);
    }
  }

  _exitCooldown() {
    this.rateLimitedUntil = 0;
    this._saveRateLimit();
  }

  getSession(externalId = 'default') {
    return this.sessions[externalId] || null;
  }

  async ensureSession(externalId = 'default', forceNew = false) {
    if (!forceNew && this.sessions[externalId]?.deepseekSessionId) {
      return this.sessions[externalId];
    }

    const id = await this.createSession();
    this.sessions[externalId] = {
      deepseekSessionId: id,
      lastResponseMessageId: null,
      title: 'DeepBlack Agent',
      needsTitleUpdate: true,
      turnCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.saveSessions();
    return this.sessions[externalId];
  }

  async getLatestMessageId(chatSessionId) {
    try {
      const res = await this._request(`https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=${chatSessionId}`, {
        method: 'GET'
      });
      const curId = res?.data?.biz_data?.chat_session?.current_message_id;
      return curId !== undefined ? curId : null;
    } catch {
      return null;
    }
  }

  updateSessionResponse(externalId, messageId) {
    if (this.sessions[externalId]) {
      this.sessions[externalId].lastResponseMessageId = messageId;
      this.sessions[externalId].updatedAt = new Date().toISOString();
      this.saveSessions();
    }
  }

  /**
   * Persists the canonical tools hash for a session (Ataque 2 — MCP delta
   * detection). Only writes if the session already exists: writing earlier
   * would get clobbered by ensureSession()'s create-path, which replaces the
   * whole session object for a brand-new externalId.
   */
  updateToolsHash(externalId, hash) {
    if (!hash || !this.sessions[externalId]) return;
    this.sessions[externalId].lastToolsHash = hash;
    this.sessions[externalId].updatedAt = new Date().toISOString();
    this.saveSessions();
  }

  resetSession(externalId = null) {
    if (externalId) {
      delete this.sessions[externalId];
    } else {
      this.sessions = {};
    }
    this.saveSessions();
  }

  _getHeaders(extra = {}) {
    return {
      'authorization': `Bearer ${this.token}`,
      'cookie': this.cookie,
      'user-agent': this.userAgent,
      'content-type': 'application/json',
      'accept': '*/*',
      'x-client-platform': 'web',
      'x-client-version': '2.5.0',
      'x-client-bundle-id': 'com.deepseek.chat',
      'x-client-locale': 'en_US',
      'x-client-timezone-offset': '-10800',
      'x-device-id': this.deviceId,
      ...extra
    };
  }

  async _request(urlStr, options = {}) {
    const url = new URL(urlStr);
    const method = options.method || 'GET';
    const headers = this._getHeaders(options.headers || {});
    const body = options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : null;

    if (body) {
      headers['content-length'] = Buffer.byteLength(body);
    }

    return new Promise((resolve, reject) => {
      const req = https.request(url, {
        method,
        headers,
        rejectUnauthorized: false
      }, (res) => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(raw));
            } catch {
              resolve(raw);
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${raw}`));
          }
        });
      });

      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  /**
   * Creates a new chat session on chat.deepseek.com
   */
  async createSession() {
    const res = await this._request('https://chat.deepseek.com/api/v0/chat_session/create', {
      method: 'POST',
      body: {}
    });

    if (res?.code !== 0 || !res?.data?.biz_data?.chat_session?.id) {
      // 40003 = "Authorization Failed (invalid token)" — DeepSeek's own
      // signal that our captured session has expired. Without this, the
      // dashboard kept showing the account as "valid" for hours after it
      // genuinely stopped working, since nothing else re-checks status
      // proactively; a live 401-equivalent from the real API is the most
      // trustworthy signal we'll ever get, so record it immediately.
      if (res?.code === 40003) {
        try {
          markAccountStatusByToken(this.token, 'invalid', this.accountsFilePath);
        } catch (markErr) {
          console.error('[DeepSeek Web] Failed to record account as invalid:', markErr.message);
        }
      }
      throw new Error(`Failed to create chat session: ${JSON.stringify(res)}`);
    }
    return res.data.biz_data.chat_session.id;
  }

  /**
   * Updates session title in DeepSeek Web sidebar
   */
  async updateTitle(sessionId, title = 'DeepBlack Agent') {
    if (!sessionId) return false;
    try {
      const res = await this._request('https://chat.deepseek.com/api/v0/chat_session/update_title', {
        method: 'POST',
        body: {
          chat_session_id: sessionId,
          title
        }
      });
      return res?.code === 0 && res?.data?.biz_code === 0;
    } catch (err) {
      console.error('Failed to update session title:', err.message);
    }
    return false;
  }

  /**
   * Deletes one or more chat sessions on chat.deepseek.com
   */
  async deleteSessions(sessionIds = []) {
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) return false;
    try {
      const res = await this._request('https://chat.deepseek.com/api/v0/chat_session/delete', {
        method: 'POST',
        body: { chat_session_ids: sessionIds }
      });
      return res?.code === 0 && res?.data?.biz_code === 0;
    } catch (err) {
      console.error('Failed to delete sessions:', err.message);
      return false;
    }
  }

  /**
   * Checks whether the session's tracked parentMessageId actually matches the
   * real latest message on DeepSeek's side, repairs it if not, and returns
   * whichever parentMessageId the next retry attempt should use. Used when a
   * completion yields 0 tokens — this can be genuine parent-id desync (fixed
   * here) or just transient upstream flakiness (in which case retrying with
   * the same, already-correct parentMessageId is still worth attempting).
   */
  async _resolveRetryParentId(sessionEntry, activeSessionId, currentParentId) {
    const realId = await this.getLatestMessageId(activeSessionId);
    if (realId !== null && realId !== sessionEntry.lastResponseMessageId) {
      console.log(`[DeepSeek Web] Auto-repaired desynced parentMessageId from ${sessionEntry.lastResponseMessageId} to ${realId}`);
      sessionEntry.lastResponseMessageId = realId;
      this.saveSessions();
      return realId;
    }
    return currentParentId;
  }

  /**
   * Last-resort recovery when 4 retries with an auto-repaired parentMessageId
   * still yield 0 tokens: the remote chat_session_id itself appears wedged
   * (observed after ~80-90 turns on a single session — DeepSeek's backend
   * accepts the corrected parentMessageId but current_message_id never
   * advances). Discards only the *remote* DeepSeek session; the caller's own
   * message history is untouched and gets fully replayed into the next
   * prompt via formatMessagesToPrompt's isNew path, so conversation
   * continuity survives from the client's point of view.
   */
  async _forceFreshSession(externalSessionId) {
    console.warn(`[DeepSeek Web] Session ${externalSessionId} appears wedged after exhausting retries — forcing a brand-new remote session.`);
    this.resetSession(externalSessionId);
    return this.ensureSession(externalSessionId, true);
  }

  /**
   * Proactive rate-limit avoidance: records this request in a sliding time
   * window and reports whether the burst threshold was exceeded. Called once
   * per top-level (non-retry) completion. Tunable via env so a slow account
   * can lower the ceiling without a code change.
   */
  _recordRequestForBurstDetection() {
    const now = Date.now();
    const windowMs = parseInt(process.env.DEEPSEEK_BURST_WINDOW_MS || '60000', 10);
    const maxInWindow = parseInt(process.env.DEEPSEEK_BURST_MAX || '10', 10);
    this._requestTimestamps = this._requestTimestamps.filter((t) => now - t < windowMs);
    this._requestTimestamps.push(now);
    return this._requestTimestamps.length > maxInWindow;
  }

  /** Whether a cooldown is currently in effect. */
  isRateLimited() {
    return this.rateLimitedUntil > Date.now();
  }

  _enterCooldown(reason, ms) {
    this.rateLimitedUntil = Date.now() + ms;
    this.lastRateLimitReason = reason;
    this._saveRateLimit();
    console.warn(`[DeepSeek Web] Entering ${ms}ms cooldown — ${reason}.`);
  }

  _cooldownStartMessage(seconds, reason) {
    return `\n\n> ⚠️ **[DeepBlack] Rate limit detectado.** ${reason} Pausando por ${seconds}s antes de tentar de novo...\n\n`;
  }

  _cooldownEndMessage() {
    return `> ✅ **[DeepBlack] Rate limit liberado — retomando normalmente.**\n\n`;
  }

  /**
   * Central recovery decision for a 0-token completion. Replaces three
   * previously-duplicated inline retry blocks (one per place the SSE stream
   * can end: 'data: [DONE]', a 'response/status' FINISHED/STOPPED event, and
   * the stream simply closing). Escalates through four tiers before giving
   * up for real:
   *   1. Auto-repaired parentMessageId retry (up to 4 attempts) — handles
   *      transient upstream flakiness and genuine parent-id desync.
   *   2. Force a brand-new remote DeepSeek session — handles a wedged
   *      chat_session_id (observed after ~80-90 turns on one session).
   *   3. 30s (configurable) cooldown + retry from scratch, up to
   *      DEEPSEEK_MAX_COOLDOWN_CYCLES times — handles real account-level
   *      throttling, which is the only thing left once even a *brand-new*
   *      session (parentMessageId=null) still comes back empty.
   *   4. Give up with a visible, honest error message in the transcript
   *      instead of silently returning an empty response.
   */
  async *_recoverFromZeroTokens({
    sessionEntry,
    activeSessionId,
    activeParentId,
    prompt,
    externalSessionId,
    thinkingEnabled,
    searchEnabled,
    modelType,
    _retryCount,
    _freshSessionAttempted,
    _cooldownCycle,
    messages,
    tools,
    deephatAdvice,
    toolsChanged
  }) {
    if (!sessionEntry) {
      yield { type: 'done', text: '', sessionId: activeSessionId };
      return;
    }

    // Uma sessao remota nova (parentMessageId=null) nao tem NENHUMA memoria --
    // nem system prompt, nem definicao de ferramentas, nem historico. Reusar
    // o `prompt` do turno original e um bug: se esse turno nao era o inicio
    // da conversa do ponto de vista do OpenCode, o prompt e so o "delta" (as
    // ultimas mensagens), sem nenhuma explicacao de que o modelo tem
    // ferramentas disponiveis. O modelo entao "esquece" que tem acesso a
    // bash/read/etc -- nao por limitacao do modelo, mas porque a sessao nova
    // genuinamente nunca recebeu essa informacao. Reconstruir o prompt aqui
    // (com isNewSession=true) resolve isso.
    const rebuildPromptForFreshSession = async () => {
      if (!messages) return prompt; // chamador antigo sem messages -- preserva comportamento anterior
      return formatMessagesToPrompt(messages, tools || [], true, deephatAdvice, toolsChanged);
    };

    const retryParentId = await this._resolveRetryParentId(sessionEntry, activeSessionId, activeParentId);

    if (_retryCount < 4) {
      const delayMs = 500 * (_retryCount + 1);
      console.log(`[DeepSeek Web] 0 tokens yielded — retrying in ${delayMs}ms (attempt ${_retryCount + 1}/4, parentMessageId=${retryParentId})...`);
      await new Promise((r) => setTimeout(r, delayMs));
      yield* this.streamCompletion({
        prompt,
        externalSessionId,
        sessionId: activeSessionId,
        parentMessageId: retryParentId,
        thinkingEnabled,
        searchEnabled,
        modelType,
        _retryCount: _retryCount + 1,
        _freshSessionAttempted,
        _cooldownCycle,
        messages,
        tools,
        deephatAdvice,
        toolsChanged
      });
      return;
    }

    if (!_freshSessionAttempted) {
      const freshEntry = await this._forceFreshSession(externalSessionId);
      yield* this.streamCompletion({
        prompt: await rebuildPromptForFreshSession(),
        externalSessionId,
        sessionId: freshEntry.deepseekSessionId,
        parentMessageId: null,
        thinkingEnabled,
        searchEnabled,
        modelType,
        _retryCount: 0,
        _freshSessionAttempted: true,
        _cooldownCycle,
        messages,
        tools,
        deephatAdvice,
        toolsChanged
      });
      return;
    }

    const maxCycles = parseInt(process.env.DEEPSEEK_MAX_COOLDOWN_CYCLES || '5', 10);
    const cooldownMs = parseInt(process.env.DEEPSEEK_COOLDOWN_MS || '30000', 10);
    if (_cooldownCycle < maxCycles) {
      const reason = 'Até uma sessão remota totalmente nova falhou, sinal de throttling da conta.';
      this._enterCooldown(`${reason} (ciclo ${_cooldownCycle + 1}/${maxCycles})`, cooldownMs);
      yield { type: 'content', text: this._cooldownStartMessage(Math.round(cooldownMs / 1000), reason), sessionId: activeSessionId };
      await new Promise((r) => setTimeout(r, Math.max(0, this.rateLimitedUntil - Date.now())));
      this._exitCooldown();
      yield { type: 'content', text: this._cooldownEndMessage(), sessionId: activeSessionId };
      yield* this.streamCompletion({
        prompt: await rebuildPromptForFreshSession(),
        externalSessionId,
        sessionId: activeSessionId,
        parentMessageId: null,
        thinkingEnabled,
        searchEnabled,
        modelType,
        _retryCount: 0,
        _freshSessionAttempted: false,
        _cooldownCycle: _cooldownCycle + 1,
        messages,
        tools,
        deephatAdvice,
        toolsChanged
      });
      return;
    }

    console.error(`[DeepSeek Web] Session ${externalSessionId} exhausted every recovery tier (retries, fresh session, ${maxCycles} cooldown cycles). Giving up.`);
    yield {
      type: 'content',
      text: `\n\n> ❌ **[DeepBlack] Sem resposta após ${maxCycles} ciclos de espera (~${Math.round((maxCycles * cooldownMs) / 60000)}min).** A conta DeepSeek Web provavelmente está bloqueada temporariamente. Tente de novo mais tarde ou troque de conta.\n\n`,
      sessionId: activeSessionId
    };
    yield { type: 'done', text: '', sessionId: activeSessionId };
  }

  /**
   * Requests a PoW challenge for a target endpoint
   */
  async createPowChallenge(targetPath = '/api/v0/chat/completion') {
    const res = await this._request('https://chat.deepseek.com/api/v0/chat/create_pow_challenge', {
      method: 'POST',
      body: { target_path: targetPath }
    });

    if (res?.code !== 0 || !res?.data?.biz_data?.challenge) {
      throw new Error(`Failed to create PoW challenge: ${JSON.stringify(res)}`);
    }
    return res.data.biz_data.challenge;
  }

  /**
   * Streams completion from DeepSeek Web with thinking and response fragments.
   * Yields: { type: 'think'|'content'|'done'|'ready', text: string, sessionId: string }
   */
  async *streamCompletion({
    prompt,
    externalSessionId = 'default',
    sessionId = null,
    parentMessageId = undefined,
    thinkingEnabled = true,
    searchEnabled = false,
    modelType = 'default',
    _retryCount = 0,
    _freshSessionAttempted = false,
    _cooldownCycle = 0,
    messages = undefined,
    tools = undefined,
    deephatAdvice = undefined,
    toolsChanged = undefined
  }) {
    // Always resolve sessionEntry by externalSessionId, even when activeSessionId
    // was passed explicitly (i.e. this is a recursive retry call). Previously
    // sessionEntry stayed null on retries, which silently disabled the 0-token
    // auto-repair/retry-of-retry logic below (and the needsTitleUpdate flush) —
    // attempt 2/2 was dead code in practice, the generator just gave up after
    // attempt 1/2 with an empty response.
    let sessionEntry = this.sessions[externalSessionId] || null;
    let activeSessionId = sessionId;

    if (!activeSessionId) {
      sessionEntry = await this.ensureSession(externalSessionId);
      activeSessionId = sessionEntry.deepseekSessionId;
    }

    let activeParentId = parentMessageId;
    if (activeParentId === undefined) {
      activeParentId = sessionEntry ? sessionEntry.lastResponseMessageId : null;
    }

    // Proactive burst throttling: only counts genuinely new top-level calls,
    // not this function's own internal retries, so a single wedged turn
    // can't falsely trip the burst detector on its own.
    const isTopLevelCall = _retryCount === 0 && !_freshSessionAttempted && _cooldownCycle === 0;
    if (isTopLevelCall && this._recordRequestForBurstDetection() && !this.isRateLimited()) {
      const cooldownMs = parseInt(process.env.DEEPSEEK_COOLDOWN_MS || '30000', 10);
      this._enterCooldown('Muitas requisições em pouco tempo — pausa preventiva.', cooldownMs);
    }

    // Honor any active cooldown, whether it was set by this call or by a
    // concurrent one on another session (rate limiting is account-wide, not
    // per-session). Runs on every entry, including retries, so a cooldown
    // that starts mid-retry-chain is still respected.
    if (this.isRateLimited()) {
      const waitMs = Math.max(0, this.rateLimitedUntil - Date.now());
      yield { type: 'content', text: this._cooldownStartMessage(Math.round(waitMs / 1000), this.lastRateLimitReason || ''), sessionId: activeSessionId };
      await new Promise((r) => setTimeout(r, waitMs));
      this._exitCooldown();
      yield { type: 'content', text: this._cooldownEndMessage(), sessionId: activeSessionId };
    }

    const challenge = await this.createPowChallenge('/api/v0/chat/completion');
    const powResponseHeader = await solveChallenge(challenge);

    const payload = JSON.stringify({
      chat_session_id: activeSessionId,
      parent_message_id: activeParentId,
      model_type: modelType,
      prompt,
      ref_file_ids: [],
      thinking_enabled: thinkingEnabled,
      search_enabled: searchEnabled,
      action: null,
      preempt: false
    });

    const headers = this._getHeaders({
      'accept': 'text/event-stream',
      'x-ds-pow-response': powResponseHeader,
      'content-length': Buffer.byteLength(payload)
    });

    const url = new URL('https://chat.deepseek.com/api/v0/chat/completion');

    const stream = await new Promise((resolve, reject) => {
      const timeoutMs = parseInt(process.env.DEEPSEEK_TIMEOUT_MS || '120000', 10);
      const req = https.request(url, {
        method: 'POST',
        headers,
        rejectUnauthorized: false
      }, (res) => {
        if (res.statusCode !== 200) {
          let errData = '';
          res.on('data', chunk => { errData += chunk; });
          res.on('end', () => reject(new Error(`Completion HTTP ${res.statusCode}: ${errData}`)));
          return;
        }
        resolve(res);
      });

      // Timeout: prevents indefinite hang on DeepSeek rate-limit or network stall
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`DeepSeek stream timeout after ${timeoutMs}ms. Use POST /v1/session/reset or /v1/session/new to unblock.`));
      });

      req.on('error', reject);
      req.write(payload);
      req.end();
    });

    let buffer = '';
    let currentMode = thinkingEnabled ? 'think' : 'content'; // 'think' or 'content'
    let yieldedTokens = 0;
    // pendingResponseMessageId removed — response_message_id is committed immediately on arrival

    for await (const chunk of stream) {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep remainder

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;

        if (trimmed.startsWith('data:')) {
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === '[DONE]') {
            if (sessionEntry?.needsTitleUpdate) {
              this.updateTitle(activeSessionId, 'DeepBlack Agent').catch(() => {});
              sessionEntry.needsTitleUpdate = false;
              this.saveSessions();
            }
            if (yieldedTokens === 0 && sessionEntry) {
              console.warn(`[DeepSeek Web] Session ${externalSessionId} yielded 0 tokens on [DONE]. Checking for parent desync...`);
              yield* this._recoverFromZeroTokens({
                sessionEntry, activeSessionId, activeParentId, prompt, externalSessionId,
                thinkingEnabled, searchEnabled, modelType, _retryCount, _freshSessionAttempted, _cooldownCycle,
                messages, tools, deephatAdvice, toolsChanged
              });
              return;
            }
            yield { type: 'done', text: '', sessionId: activeSessionId };
            return;
          }

          try {
            const parsed = JSON.parse(dataStr);

            if (parsed.code !== undefined && parsed.code !== 0) {
              console.error(`[DeepSeek API Error] session=${externalSessionId} code=${parsed.code} msg=${parsed.msg}`);
              throw new Error(`DeepSeek API Error (${parsed.code}): ${parsed.msg || 'Unknown error'}`);
            }

            if (parsed.response_message_id) {
              // Commit immediately — don't wait for next token so 0-token responses still save state
              this.updateSessionResponse(externalSessionId, parsed.response_message_id);
              yield { type: 'ready', responseMessageId: parsed.response_message_id, sessionId: activeSessionId };
            }
            if (parsed.v?.response?.message_id) {
              this.updateSessionResponse(externalSessionId, parsed.v.response.message_id);
            }
            
            // Check for initial fragments
            if (parsed.v?.response?.fragments) {
              for (const frag of parsed.v.response.fragments) {
                if (frag.type === 'THINK' && frag.content) {
                  yieldedTokens++;
                  currentMode = 'think';
                  yield { type: 'think', text: frag.content, sessionId: activeSessionId };
                } else if (frag.type === 'RESPONSE' && frag.content) {
                  yieldedTokens++;
                  currentMode = 'content';
                  yield { type: 'content', text: frag.content, sessionId: activeSessionId };
                }
              }
              continue;
            }

            // Check for new response fragment transition
            if (parsed.p === 'response/fragments' && parsed.o === 'APPEND' && Array.isArray(parsed.v)) {
              for (const item of parsed.v) {
                if (item.type === 'RESPONSE') {
                  currentMode = 'content';
                  if (item.content) {
                    yieldedTokens++;
                    yield { type: 'content', text: item.content, sessionId: activeSessionId };
                  }
                }
              }
              continue;
            }

            // Check for finish or stop status
            if (parsed.p === 'response/status') {
              if (parsed.v === 'FINISHED' || parsed.v === 'STOPPED') {
                if (sessionEntry?.needsTitleUpdate) {
                  this.updateTitle(activeSessionId, 'DeepBlack Agent').catch(() => {});
                  sessionEntry.needsTitleUpdate = false;
                  this.saveSessions();
                }
                if (yieldedTokens === 0 && sessionEntry) {
                  console.warn(`[DeepSeek Web] Session ${externalSessionId} finished with 0 tokens. Checking for parent desync...`);
                  yield* this._recoverFromZeroTokens({
                    sessionEntry, activeSessionId, activeParentId, prompt, externalSessionId,
                    thinkingEnabled, searchEnabled, modelType, _retryCount, _freshSessionAttempted, _cooldownCycle,
                    messages, tools, deephatAdvice, toolsChanged
                  });
                  return;
                }
                yield { type: 'done', text: '', sessionId: activeSessionId };
                return;
              }
            }

            // Check for incremental delta
            if (typeof parsed.v === 'string') {
              yieldedTokens++;
              yield { type: currentMode, text: parsed.v, sessionId: activeSessionId };
              continue;
            }
          } catch (err) {
            if (err.message?.includes('DeepSeek API Error')) throw err;
          }
        }
      }
    }

    if (sessionEntry?.needsTitleUpdate) {
      this.updateTitle(activeSessionId, 'DeepBlack Agent').catch(() => {});
      sessionEntry.needsTitleUpdate = false;
      this.saveSessions();
    }
    if (yieldedTokens === 0 && sessionEntry) {
      console.warn(`[DeepSeek Web] Session ${externalSessionId} stream ended with 0 tokens. Checking for parent desync...`);
      yield* this._recoverFromZeroTokens({
        sessionEntry, activeSessionId, activeParentId, prompt, externalSessionId,
        thinkingEnabled, searchEnabled, modelType, _retryCount, _freshSessionAttempted, _cooldownCycle,
        messages, tools, deephatAdvice, toolsChanged
      });
      return;
    }
    yield { type: 'done', text: '', sessionId: activeSessionId };
  }
}
