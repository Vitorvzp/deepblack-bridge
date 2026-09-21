#!/usr/bin/env node
// cli/resume.js — Abre o OpenCode conectado a um chat existente do DeepSeek Web
// language: Node.js (ESM), target: Windows 11 / Linux

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import https from 'node:https';
import { spawn, execSync } from 'node:child_process';
import { getActiveAccount } from './accounts.js';
import { fetchSessionHistory } from './sessions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const SESSIONS_FILE = path.join(ROOT_DIR, '.deepblack_sessions.json');
const SCRATCH_DIR = path.join(ROOT_DIR, 'scratch');
const BRIDGE_URL = 'http://127.0.0.1:5050';

const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  cyan:    '\x1b[36m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  red:     '\x1b[31m',
  magenta: '\x1b[35m',
  blue:    '\x1b[34m',
  bCyan:   '\x1b[96m',
  bGreen:  '\x1b[92m'
};

function banner(msg) {
  const line = '─'.repeat(Math.min(process.stdout.columns || 72, 72));
  console.log(`\n${C.cyan}${line}${C.reset}`);
  console.log(`${C.bold}${C.bCyan}  ${msg}${C.reset}`);
  console.log(`${C.cyan}${line}${C.reset}\n`);
}

function info(msg)   { console.log(`${C.blue}  ℹ  ${C.reset}${msg}`); }
function ok(msg)     { console.log(`${C.bGreen}  ✔  ${C.reset}${msg}`); }
function warn(msg)   { console.log(`${C.yellow}  ⚠  ${C.reset}${msg}`); }
function err(msg)    { console.log(`${C.red}  ✘  ${C.reset}${msg}`); }
function label(k, v) { console.log(`${C.dim}      ${k}:${C.reset} ${v}`); }

function prompt(rl, question) {
  if (!process.stdin.isTTY && !process.stdin.readable) {
    return Promise.resolve('');
  }
  return new Promise(resolve => {
    try {
      rl.question(question, ans => resolve(ans || ''));
    } catch {
      resolve('');
    }
  });
}

function extractUuid(input) {
  if (!input || typeof input !== 'string') return null;
  const match = input.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return match ? match[0].toLowerCase() : null;
}

/**
 * Fetches recent sessions from DeepSeek Web API for interactive selection
 */
async function fetchRecentWebSessions() {
  const activeAcc = getActiveAccount();
  if (!activeAcc || !activeAcc.token) {
    throw new Error('Nenhuma conta DeepSeek configurada no sistema.');
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

  return new Promise((resolve, reject) => {
    const req = https.request('https://chat.deepseek.com/api/v0/chat_session/fetch_page?lte_cursor.pinned=false', {
      method: 'GET',
      headers,
      rejectUnauthorized: false
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.code === 0) {
            resolve(parsed.data?.biz_data?.chat_sessions || []);
          } else {
            resolve([]);
          }
        } catch {
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
    req.setTimeout(6000, () => { req.destroy(); resolve([]); });
    req.end();
  });
}

/**
 * Converts DeepSeek messages into OpenCode session import JSON format
 */
function buildOpenCodeSessionJson(openCodeSessionId, dsSessionId, title, messages) {
  const now = Date.now();
  let lastMsgId = null;

  const ocMessages = messages.map((msg, idx) => {
    const ocMsgId = `msg_${idx.toString().padStart(6, '0')}_${Math.random().toString(36).slice(2, 8)}`;
    const msgTime = msg.createdAt ? new Date(msg.createdAt).getTime() : now - (messages.length - idx) * 1000;

    const ocMsg = {
      info: {
        id: ocMsgId,
        sessionID: openCodeSessionId,
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        time: { created: msgTime }
      },
      parts: [
        {
          id: `prt_${ocMsgId}`,
          type: 'text',
          text: msg.content || '',
          sessionID: openCodeSessionId,
          messageID: ocMsgId
        }
      ]
    };

    if (msg.role === 'assistant') {
      ocMsg.info.mode = 'build';
      ocMsg.info.agent = 'build';
      ocMsg.info.modelID = 'deepseek-reasoner';
      ocMsg.info.providerID = 'deepblack';
      ocMsg.info.finish = 'stop';
      ocMsg.info.path = { cwd: process.cwd(), root: process.cwd() };
      ocMsg.info.cost = 0;
      ocMsg.info.tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
      if (lastMsgId) ocMsg.info.parentID = lastMsgId;
    } else {
      ocMsg.info.agent = 'build';
      ocMsg.info.model = { providerID: 'deepblack', modelID: 'deepseek-reasoner' };
    }

    lastMsgId = ocMsgId;
    return ocMsg;
  });

  return {
    info: {
      id: openCodeSessionId,
      slug: `deepseek-${dsSessionId.slice(0, 8)}`,
      projectID: 'db84786e9610862925e36dce0e8c62d4ed968432',
      directory: process.cwd(),
      path: '',
      title: title || 'Chat DeepSeek Retomado',
      agent: 'build',
      model: { id: 'deepseek-reasoner', providerID: 'deepblack' },
      version: '1.18.31',
      summary: { additions: 0, deletions: 0, files: 0 },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: now - 3600000, updated: now }
    },
    messages: ocMessages
  };
}

/**
 * Links the session in .deepblack_sessions.json and notifies bridge via API
 */
async function registerBridgeSession(openCodeSessionId, dsSessionId, lastMsgId, title) {
  // 1. Update local .deepblack_sessions.json
  let sessionsMap = {};
  if (fs.existsSync(SESSIONS_FILE)) {
    try {
      sessionsMap = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) || {};
    } catch {}
  }

  const entry = {
    deepseekSessionId: dsSessionId,
    lastResponseMessageId: lastMsgId,
    title: title || 'DeepSeek Resumed Chat',
    needsTitleUpdate: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  sessionsMap[openCodeSessionId] = entry;
  sessionsMap['default'] = { ...entry }; // Also set as default for fallback
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessionsMap, null, 2), 'utf8');

  // 2. Notify running bridge if online
  let bridgeUpdated = false;
  try {
    const res = await fetch(`${BRIDGE_URL}/v1/session/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        externalSessionId: openCodeSessionId,
        deepseekSessionId: dsSessionId,
        lastResponseMessageId: lastMsgId,
        title: title
      }),
      signal: AbortSignal.timeout(1500)
    });
    if (res.ok) {
      bridgeUpdated = true;
      // Also link default on bridge
      await fetch(`${BRIDGE_URL}/v1/session/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          externalSessionId: 'default',
          deepseekSessionId: dsSessionId,
          lastResponseMessageId: lastMsgId,
          title: title
        }),
        signal: AbortSignal.timeout(1000)
      }).catch(() => {});
    }
  } catch {}

  return { bridgeUpdated };
}

async function main() {
  banner('DeepBlack — Retomar Chat do DeepSeek no OpenCode');

  let rawArg = process.argv[2]?.trim() || '';
  let targetUuid = extractUuid(rawArg);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // Se não foi fornecido UUID na linha de comando, lista as sessões recentes ou pergunta
  if (!targetUuid) {
    info('Buscando conversas recentes no DeepSeek Web...');
    const recent = await fetchRecentWebSessions();

    if (recent.length > 0) {
      console.log(`\n${C.bold}  Conversas recentes encontradas no chat.deepseek.com:${C.reset}\n`);
      recent.slice(0, 10).forEach((s, i) => {
        const title = s.title || '(sem título)';
        console.log(`    ${C.bold}[${i + 1}]${C.reset} ${title} ${C.dim}(${s.id})${C.reset}`);
      });
      console.log('');
    }

    const answer = await prompt(rl, `  ${C.cyan}Digite o número da conversa acima OU cole o link/UUID do DeepSeek: ${C.reset}`);
    const trimmed = answer.trim();

    const idx = parseInt(trimmed, 10) - 1;
    if (!isNaN(idx) && idx >= 0 && idx < recent.length) {
      targetUuid = recent[idx].id;
    } else {
      targetUuid = extractUuid(trimmed);
    }

    if (!targetUuid) {
      err('Nenhum link ou UUID válido do DeepSeek fornecido. Operação cancelada.');
      rl.close();
      process.exit(1);
    }
  }

  info(`UUID da conversa selecionada: ${C.bold}${targetUuid}${C.reset}`);
  info('Obtendo histórico completo via API do DeepSeek Web...');

  let history;
  try {
    history = await fetchSessionHistory(targetUuid);
  } catch (e) {
    err(`Falha ao carregar histórico: ${e.message}`);
    rl.close();
    process.exit(1);
  }

  const title = history.title || 'Chat DeepSeek Retomado';
  const msgCount = history.messages.length;
  const currentMsgId = history.currentMessageId !== undefined ? history.currentMessageId : (msgCount > 0 ? history.messages[msgCount - 1].id : null);

  ok(`Conversa carregada: "${C.bold}${title}${C.reset}"`);
  label('Mensagens recuperadas', msgCount);
  label('Último ID no servidor', currentMsgId ?? 'Nenhum');

  // Gera Session ID para o OpenCode
  const shortUuid = targetUuid.slice(0, 8);
  const openCodeSessionId = `ses_ds_${shortUuid}_${Date.now().toString(36).slice(-4)}`;

  // Garante diretório scratch
  if (!fs.existsSync(SCRATCH_DIR)) {
    fs.mkdirSync(SCRATCH_DIR, { recursive: true });
  }

  // Gera arquivo de importação
  info('Convertendo formato para o banco de dados do OpenCode...');
  const ocSessionData = buildOpenCodeSessionJson(openCodeSessionId, targetUuid, title, history.messages);
  const tempImportPath = path.join(SCRATCH_DIR, `import_${openCodeSessionId}.json`);
  fs.writeFileSync(tempImportPath, JSON.stringify(ocSessionData, null, 2), 'utf8');

  // Importa no OpenCode
  info(`Importando sessão "${openCodeSessionId}" no OpenCode...`);
  try {
    execSync(`opencode import "${tempImportPath}"`, { stdio: 'pipe', encoding: 'utf8' });
    ok(`Sessão importada no OpenCode com sucesso!`);
  } catch (e) {
    warn(`Aviso ao importar no OpenCode: ${e.message}`);
    info('Tentando registrar mapeamento mesmo assim...');
  }

  // Limpa arquivo temporário
  try { fs.unlinkSync(tempImportPath); } catch {}

  // Registra no DeepBlack Bridge
  info('Registrando vinculação no DeepBlack Bridge (.deepblack_sessions.json)...');
  const { bridgeUpdated } = await registerBridgeSession(openCodeSessionId, targetUuid, currentMsgId, title);
  if (bridgeUpdated) {
    ok('DeepBlack Bridge atualizado via hot-reload em tempo real!');
  } else {
    ok('Mapeamento persistido no disco. (O bridge lerá na próxima requisição)');
  }

  console.log('');
  banner('VINCULAÇÃO CONCLUÍDA');
  label('OpenCode Session ID', `${C.bold}${C.bGreen}${openCodeSessionId}${C.reset}`);
  label('DeepSeek Web Chat', `${targetUuid} ("${title}")`);
  label('Comando para abrir', `${C.bold}opencode -s ${openCodeSessionId}${C.reset}`);

  // Pergunta se deseja abrir imediatamente
  const launchAns = await prompt(rl, `\n  ${C.cyan}Deseja abrir o OpenCode nesta conversa agora? (S/n): ${C.reset}`);
  rl.close();

  if (!launchAns.trim() || launchAns.trim().toLowerCase().startsWith('s')) {
    info(`Iniciando: opencode -s ${openCodeSessionId}\n`);
    const isWin = process.platform === 'win32';
    const child = spawn(isWin ? 'opencode.cmd' : 'opencode', ['-s', openCodeSessionId], {
      stdio: 'inherit',
      shell: true,
      cwd: process.cwd()
    });

    child.on('close', (code) => {
      console.log(`\n${C.dim}OpenCode finalizado (código ${code}).${C.reset}`);
    });
  } else {
    console.log(`\n  ${C.green}Pronto! Quando quiser continuar, execute:${C.reset}`);
    console.log(`  ${C.bold}${C.cyan}opencode -s ${openCodeSessionId}${C.reset}\n`);
  }
}

main().catch(e => {
  console.error(`\n${C.red}  Erro fatal:${C.reset}`, e.message);
  process.exit(1);
});
