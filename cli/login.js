#!/usr/bin/env node
// cli/login.js — Login via browser e captura automática de credenciais DeepSeek
// language: Node.js ESM, target: Windows 11, Playwright (chromium)

import { chromium } from 'playwright';
import readline from 'readline';
import { loadAccounts, maskToken, switchActiveAccount, upsertAccount } from './accounts.js';

const BRIDGE_URL = 'http://127.0.0.1:5050';
const TARGET_URL = 'https://chat.deepseek.com';
const POLL_INTERVAL_MS = 1500;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutos

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  magenta:'\x1b[35m',
  blue:   '\x1b[34m',
};

function banner(msg) {
  const line = '─'.repeat(Math.min(process.stdout.columns || 72, 72));
  console.log(`\n${C.cyan}${line}${C.reset}`);
  console.log(`${C.bold}${C.cyan}  ${msg}${C.reset}`);
  console.log(`${C.cyan}${line}${C.reset}\n`);
}

function info(msg)    { console.log(`${C.blue}  ℹ  ${C.reset}${msg}`); }
function ok(msg)      { console.log(`${C.green}  ✓  ${C.reset}${msg}`); }
function warn(msg)    { console.log(`${C.yellow}  ⚠  ${C.reset}${msg}`); }
function err(msg)     { console.log(`${C.red}  ✗  ${C.reset}${msg}`); }
function label(k, v)  { console.log(`${C.dim}      ${k}:${C.reset} ${v}`); }

// ── Bridge health check ───────────────────────────────────────────────────────
async function isBridgeRunning() {
  try {
    const res = await fetch(`${BRIDGE_URL}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Sync credenciais via bridge ou direto ─────────────────────────────────────
async function syncCredentials({ token, cookie, userAgent, deviceId, name, makeActive }) {
  const bridgeUp = await isBridgeRunning();

  if (bridgeUp) {
    const res = await fetch(`${BRIDGE_URL}/api/account/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, cookie, userAgent, deviceId, name, makeActive })
    });
    if (!res.ok) throw new Error(`Bridge retornou ${res.status}`);
    const data = await res.json();
    return data;
  } else {
    // Bridge offline — persiste direto via accounts.js
    warn('Bridge offline — salvando conta direto no arquivo de contas.');
    const { account, isNew } = upsertAccount({
      token, cookie, userAgent, deviceId, name,
      setAsActive: false // não ativa ainda — deixa o usuário escolher
    });
    return { account, isNew, bridgeUpdated: false };
  }
}

// ── Readline prompt ───────────────────────────────────────────────────────────
function prompt(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

// ── Extrai credenciais da página Playwright ───────────────────────────────────
async function extractCredentials(page, context) {
  const creds = await page.evaluate(() => {
    // Token
    let token = null;
    try {
      const raw = localStorage.getItem('userToken');
      if (raw) {
        const parsed = JSON.parse(raw);
        token = parsed?.value ?? parsed;
      }
    } catch {}

    // DeviceId — procura chave com "device" no nome
    let deviceId = null;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.toLowerCase().includes('device')) {
        try {
          const v = JSON.parse(localStorage.getItem(k));
          deviceId = v?.value ?? v;
        } catch {
          deviceId = localStorage.getItem(k);
        }
        if (deviceId) break;
      }
    }

    // UserName — tenta pegar do store do usuário
    let userName = null;
    try {
      const uRaw = localStorage.getItem('user');
      if (uRaw) {
        const u = JSON.parse(uRaw);
        userName = u?.value?.name ?? u?.name ?? null;
      }
    } catch {}

    return { token, deviceId, userName, userAgent: navigator.userAgent };
  });

  // Cookies via contexto Playwright
  const cookies = await context.cookies([TARGET_URL]);
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  return { ...creds, cookie: cookieStr };
}

// ── Polling: aguarda token aparecer no localStorage ───────────────────────────
async function waitForLogin(page, context) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let dots = 0;

  process.stdout.write(`\n  ${C.yellow}Aguardando login${C.reset}`);

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    process.stdout.write('.');
    dots++;

    let token = null;
    try {
      token = await page.evaluate(() => {
        const raw = localStorage.getItem('userToken');
        if (!raw) return null;
        try {
          const p = JSON.parse(raw);
          return p?.value ?? p;
        } catch { return raw; }
      });
    } catch {
      // página pode estar em navegação — ignora
    }

    if (token && typeof token === 'string' && token.length > 20) {
      process.stdout.write(' ✓\n\n');
      // Aguarda mais 1,5s para cookies e localStorage finalizarem
      await new Promise(r => setTimeout(r, 1500));
      return await extractCredentials(page, context);
    }
  }

  process.stdout.write('\n');
  throw new Error('Timeout: nenhum login detectado em 10 minutos.');
}

// ── Tabela de contas ──────────────────────────────────────────────────────────
function renderAccountsTable(accounts, activeId, newAccountId = null) {
  const colW = [4, 28, 20, 10];
  const sep  = `  +${colW.map(w => '-'.repeat(w + 2)).join('+')}+`;

  function row(cols) {
    return '  |' + cols.map((c, i) => ` ${String(c).padEnd(colW[i])} `).join('|') + '|';
  }

  console.log(sep);
  console.log(row(['#', 'Nome', 'Token', 'Status']));
  console.log(sep);

  accounts.forEach((acc, idx) => {
    const isActive = acc.id === activeId;
    const isNew    = acc.id === newAccountId;
    const num      = `[${idx + 1}]`;
    const name     = (acc.name || '—').substring(0, colW[1]);
    const tok      = maskToken(acc.token);
    const status   = acc.status || '—';

    let color = C.reset;
    if (isActive) color = C.green + C.bold;
    if (isNew && !isActive) color = C.cyan;

    const tags = (isActive ? ' ★ ativo' : '') + (isNew ? ' ← novo' : '');
    console.log(`${color}${row([num, name + tags, tok, status])}${C.reset}`);
  });

  console.log(sep);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  banner('DeepBlack — Login via Browser');

  // Contas existentes
  const store = loadAccounts();
  info(`${store.accounts.length} conta(s) existente(s):`);
  renderAccountsTable(store.accounts, store.activeAccountId);

  // Abre browser
  info('Abrindo Chromium em modo headed...');
  const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
  const context = await browser.newContext({ viewport: null });
  const page    = await context.newPage();

  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
  info(`Navegador aberto em: ${TARGET_URL}`);
  info('Faça login normalmente no site. O script detectará automaticamente.');
  warn('Não feche o navegador até a captura concluir.');

  let creds;
  try {
    creds = await waitForLogin(page, context);
  } catch (e) {
    err(e.message);
    await browser.close();
    process.exit(1);
  }

  await browser.close();
  ok('Navegador fechado.');

  // Exibe o que capturou
  console.log('');
  ok('Credenciais capturadas:');
  label('Token',     maskToken(creds.token));
  label('DeviceId',  creds.deviceId || '(não encontrado)');
  label('UserAgent', creds.userAgent?.substring(0, 60) + '...');
  label('Cookies',   creds.cookie ? `${creds.cookie.split(';').length} cookies` : '(nenhum)');
  label('UserName',  creds.userName || '(não detectado)');

  // Sincroniza — makeActive: false; dj escolhe abaixo
  info('Sincronizando com o sistema de contas...');
  let syncResult;
  try {
    syncResult = await syncCredentials({
      token:      creds.token,
      cookie:     creds.cookie,
      userAgent:  creds.userAgent,
      deviceId:   creds.deviceId || undefined,
      name:       creds.userName ? `DeepSeek (${creds.userName})` : undefined,
      makeActive: false
    });
  } catch (e) {
    err(`Falha ao sincronizar: ${e.message}`);
    process.exit(1);
  }

  const newAccountId = syncResult?.account?.id;
  if (syncResult.isNew) {
    ok(`Nova conta adicionada: ${syncResult.account?.name}`);
  } else {
    ok(`Conta existente atualizada: ${syncResult.account?.name}`);
  }

  // Recarrega lista atualizada
  const updatedStore = loadAccounts();

  // Pergunta qual conta ativar
  console.log('');
  banner('Qual conta deve ficar ativa?');
  renderAccountsTable(updatedStore.accounts, updatedStore.activeAccountId, newAccountId);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let chosen;
  while (true) {
    const answer = await prompt(rl, `\n  ${C.cyan}Digite o número da conta [1–${updatedStore.accounts.length}] ou Enter para manter atual: ${C.reset}`);
    const trimmed = answer.trim();

    if (trimmed === '') {
      chosen = null;
      break;
    }

    const idx = parseInt(trimmed, 10) - 1;
    if (!isNaN(idx) && idx >= 0 && idx < updatedStore.accounts.length) {
      chosen = updatedStore.accounts[idx];
      break;
    }

    warn(`Número inválido. Digite entre 1 e ${updatedStore.accounts.length}.`);
  }

  rl.close();

  if (!chosen) {
    info(`Conta ativa mantida: ${C.bold}${updatedStore.accounts.find(a => a.id === updatedStore.activeAccountId)?.name}${C.reset}`);
  } else {
    info(`Ativando: ${C.bold}${chosen.name}${C.reset}...`);
    try {
      const { target, bridgeReloaded } = await switchActiveAccount(chosen.id);
      ok(`Conta ativa: ${C.bold}${target.name}${C.reset}`);
      if (bridgeReloaded) {
        ok('Bridge atualizado em tempo real (sem restart necessário).');
      } else {
        warn('Bridge offline ou endpoint /v1/auth/reload indisponível. Reinicie o bridge para aplicar.');
      }
    } catch (e) {
      err(`Falha ao ativar conta: ${e.message}`);
      process.exit(1);
    }
  }

  console.log('');
  ok('Concluído.');
}

main().catch(e => {
  console.error(`\n${C.red}  Erro fatal:${C.reset}`, e.message);
  process.exit(1);
});
