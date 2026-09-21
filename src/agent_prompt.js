import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { resolveImagePart } from './vision.js';
import { resolveFromRoot } from './util/runtime_paths.js';

/**
 * Loads the base system prompt from prompts/system_prompt.md if available
 */
export function loadBaseSystemPrompt() {
  const promptPath = resolveFromRoot(import.meta.url, 'prompts', 'system_prompt.md');
  if (fs.existsSync(promptPath)) {
    try {
      return fs.readFileSync(promptPath, 'utf8').trim();
    } catch {}
  }
  return '';
}

/**
 * Builds rich runtime and OS environment information for tool command targeting
 */
export function getEnvironmentContext(cwd = process.cwd()) {
  const platform = process.platform;
  const isWindows = platform === 'win32';
  const release = os.release();
  const arch = process.arch;
  const shell = isWindows ? 'Windows PowerShell (5.1 / 7)' : (process.env.SHELL || '/bin/bash');
  const homedir = os.homedir();
  let username = 'user';
  try { username = os.userInfo().username; } catch {}

  const isWslWorkspace = cwd.toLowerCase().includes('wsl') || cwd.toLowerCase().includes('kali') || cwd.startsWith('/home/');

  const rules = isWslWorkspace
    ? [
        '- Active Workspace: WSL Linux Environment (Kali Linux).',
        '- For Linux commands (nmap, python3, curl, bash scripts), use standard Bash syntax or invoke via `wsl -d kali-linux -- bash -lc "..."`.',
        '- GNU Coreutils is available natively on both Linux and Windows (C:\\Program Files\\coreutils\\bin in PATH).',
        '- For file operations, use the provided tools directly (read, edit, write, bash).'
      ]
    : [
        '- Host OS: Windows with GNU Coreutils available in PATH (C:\\Program Files\\coreutils\\bin).',
        '- You CAN freely use GNU Coreutils commands on Windows: base64, grep, head, tail, cat, cut, tr, wc, sort, uniq, md5sum, sha256sum, touch, sleep, seq.',
        '- PowerShell syntax reminder: Avoid the reserved `<` redirection operator (use `cat file | command` instead of `command < file`). Use `$env:VAR` for environment variables.',
        '- For file operations, use local tools directly (read, edit, write, bash).'
      ];

  return [
    '=== OPERATING ENVIRONMENT & RUNTIME ===',
    `Operating System: ${isWindows ? 'Windows' : platform} (${release}, ${arch})`,
    `Default Shell: ${shell}`,
    `Current Working Directory: ${cwd}`,
    `Home Directory: ${homedir}`,
    `Current User: ${username}`,
    `Path Separator: ${path.sep}`,
    'Command Execution Rules:',
    ...rules,
    '======================================='
  ].join('\n');
}

/**
 * Discovers project or global instruction files (e.g. AGENTS.md, Claude.md, Gemini.md, shadow.md)
 */
export function loadProjectInstructions(cwd = process.cwd()) {
  const candidateNames = [
    'AGENTS.md',
    'agents.md',
    'Claude.md',
    'claude.md',
    'Gemini.md',
    'gemini.md',
    '.agents/rules/*.md'
  ];

  const loaded = [];

  for (const name of candidateNames) {
    const fullPath = path.resolve(cwd, name);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      try {
        const text = fs.readFileSync(fullPath, 'utf8');
        loaded.push({ file: name, content: text });
      } catch {}
    }
  }

  return loaded;
}

/**
 * Resolves message.content (string or OpenAI content-part array) into a
 * single prompt-safe string. Text parts pass through; image_url parts are
 * routed to the local VLM pipeline (src/vision.js) — raw base64 payloads
 * must NEVER reach this function's return value as literal text.
 */
async function formatContentParts(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  let imageIdx = 0;
  const resolved = await Promise.all(content.map((c) => {
    if (typeof c === 'string') return c;
    if (c && (c.type === 'image_url' || c.type === 'image')) {
      return resolveImagePart(c, imageIdx++);
    }
    if (c && typeof c.text === 'string') return c.text;
    return JSON.stringify(c);
  }));

  return resolved.join('\n');
}

/**
 * Computes a short, order-independent hash of a tools array so the gateway
 * can detect when an MCP toolset actually changed between turns (vs. the
 * same tools arriving in a different order because a server reconnected).
 * Sorting by tool name before hashing is what makes it order-independent.
 */
export function computeToolsHash(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  const sorted = [...tools].sort((a, b) => {
    const nameA = a?.function?.name || a?.name || '';
    const nameB = b?.function?.name || b?.name || '';
    return nameA.localeCompare(nameB);
  });
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 16);
}

const TOOL_DESCRIPTION_MAX_CHARS = 160;
const TOOLS_BLOCK_HARD_CAP_CHARS = 16000; // ~4000 tokens at ~4 chars/token

// JSON Schema fields that cost tokens but add no signal for tool selection
const SCHEMA_NOISE_KEYS = new Set(['$schema', 'title', 'examples', 'additionalProperties']);

function stripSchemaNoise(node) {
  if (Array.isArray(node)) return node.map(stripSchemaNoise);
  if (!node || typeof node !== 'object') return node;

  const cleaned = {};
  for (const [key, value] of Object.entries(node)) {
    if (SCHEMA_NOISE_KEYS.has(key)) continue;
    if (key === 'description' && typeof value === 'string' && value.length > TOOL_DESCRIPTION_MAX_CHARS) {
      cleaned[key] = value.slice(0, TOOL_DESCRIPTION_MAX_CHARS - 1).trimEnd() + '…';
      continue;
    }
    cleaned[key] = stripSchemaNoise(value);
  }
  return cleaned;
}

/**
 * Minifies tool schemas for prompt injection: strips decorative JSON Schema
 * fields, truncates verbose descriptions, and serializes without whitespace.
 * Falls back to a hard character cap so a pathological MCP toolset can never
 * blow the model's context budget.
 */
export function minifyToolsForPrompt(tools = []) {
  const compact = tools.map(stripSchemaNoise);
  let serialized = JSON.stringify(compact);

  if (serialized.length > TOOLS_BLOCK_HARD_CAP_CHARS) {
    console.warn(`[DeepBlack] Tools block exceeds token budget (${serialized.length} chars > ${TOOLS_BLOCK_HARD_CAP_CHARS}). Truncating excess.`);
    serialized = serialized.slice(0, TOOLS_BLOCK_HARD_CAP_CHARS) + '...[TRUNCATED: schemas excederam orçamento de tokens]';
  }

  return serialized;
}

/**
 * Formats incoming OpenAI messages & tools into a unified prompt for DeepSeek Web
 */
export async function formatMessagesToPrompt(messages = [], tools = [], isNewSession = true, deephatAdvice = null, toolsChanged = false, needsReminder = false) {
  // If chaining in an existing session on DeepSeek web:
  // Collect all new messages since the last assistant turn (e.g. all parallel tool results)
  if (!isNewSession && messages.length >= 1) {
    const trailing = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'assistant') {
        break;
      }
      trailing.unshift(m);
    }

    if (trailing.length === 0) {
      trailing.push(messages[messages.length - 1]);
    }

    const formattedParts = [];

    // Defesa em profundidade contra perda de contexto silenciosa: mesmo sem
    // nenhuma rotação/retry de sessão (o bug corrigido separadamente em
    // _recoverFromZeroTokens), foi observado ao vivo o DeepSeek Web "perder o
    // fio" numa sessão longa baseada só em delta, tratando um resultado de
    // ferramenta solto como se fosse a conversa inteira. Como não há erro pra
    // detectar isso automaticamente, o servidor pede periodicamente (a cada N
    // turnos) pra reinjetar um lembrete curto aqui -- só os NOMES das
    // ferramentas, não os schemas completos, pra não anular a economia de
    // tokens que o formato delta existe pra dar.
    if (needsReminder && tools && tools.length > 0) {
      const toolNames = tools
        .map((t) => t?.function?.name || t?.name)
        .filter(Boolean)
        .join(', ');
      if (toolNames) {
        formattedParts.push(
          '[LEMBRETE DE CONTEXTO — não é uma nova tarefa, apenas uma reafirmação]\n' +
          'Você é o DeepBlack, um agente autônomo com acesso direto às ferramentas locais do usuário. ' +
          `Ferramentas disponíveis agora: ${toolNames}. ` +
          'Continue a tarefa em andamento normalmente, usando <tool_call>...</tool_call> quando precisar.'
        );
      }
    }

    // MCP toolset changed mid-conversation (Ataque 2): the full tools block is
    // only sent on a brand-new session, so a delta update keeps R1 in sync
    // without re-sending the whole prompt every turn.
    if (toolsChanged && tools && tools.length > 0) {
      formattedParts.push(
        '[SYSTEM UPDATE: TOOLSET MODIFIED]\n' +
        'As ferramentas disponíveis foram atualizadas neste turno:\n' +
        '<TOOL_USE>\n' +
        minifyToolsForPrompt(tools) +
        '\n</TOOL_USE>'
      );
    }

    for (const msg of trailing) {
      const role = (msg.role || 'user').toUpperCase();
      const content = await formatContentParts(msg.content);

      const toolReminder = '\n\n';

      if (role === 'TOOL') {
        formattedParts.push(`[TOOL RESULT: ${msg.name || msg.tool_call_id || 'tool'}]\n${content}${toolReminder}`);
      } else if (role === 'USER') {
        formattedParts.push(`${content}${toolReminder}`);
      } else {
        formattedParts.push(`[${role}]\n${content}`);
      }
    }

    return formattedParts.join('\n\n');
  }

  const parts = [];

  // 1. Base System Prompt from prompts/system_prompt.md
  const basePrompt = loadBaseSystemPrompt();
  if (basePrompt) {
    parts.push(basePrompt);
  } else {
    parts.push(
      'You are DeepBlack, an autonomous AI software engineering pair programmer.\n' +
      'You have direct access to local execution tools on the user\'s machine.\n' +
      'When the user asks you to inspect files, run commands, or edit code, ALWAYS use the provided tools to inspect and execute rather than declining.'
    );
  }

  // 2. Rich Operating Environment & Shell Context
  parts.push(getEnvironmentContext());

  // 3. Injected Project Guidelines if any
  const instructions = loadProjectInstructions();
  if (instructions.length > 0) {
    parts.push('=== INSTRUCTIONS & PROJECT GUIDELINES ===');
    for (const inst of instructions) {
      parts.push(`[Source: ${inst.file}]\n${inst.content}\n`);
    }
    parts.push('=========================================\n');
  }

  // 4. Tool definitions (if passed by OpenCode)
  if (tools && tools.length > 0) {
    parts.push('=== AVAILABLE TOOLS ===');
    parts.push(
      'You have access to the following tools. To invoke a tool, respond with EXACTLY this unified block:\n' +
      '<tool_call>\n' +
      '{"name": "tool_name", "arguments": {"param1": "value1"}}\n' +
      '</tool_call>\n\n' +
      'STRICT TOOL RULES:\n' +
      '- Use EXCLUSIVELY <tool_call> and </tool_call>. NEVER use <call_call>, </call_call>, <call>, or DSML tags.\n' +
      '- Multiple tools: emit each in its own sequential <tool_call>...</tool_call> block.\n' +
      '- NEVER nest arguments like {"arguments": {...}}. Parameters must be direct properties of arguments (e.g. {"command": "..."}).\n' +
      '- DO NOT emit stray closing tags like </tool_call> before opening a block.'
    );
    parts.push(minifyToolsForPrompt(tools));
    parts.push('=======================\n');
  }

  // 5. Conversation history
  for (const msg of messages) {
    const role = (msg.role || 'user').toUpperCase();
    let content = await formatContentParts(msg.content);

    if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        let tcArgs = {};
        try {
          tcArgs = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || {});
        } catch {
          tcArgs = tc.function?.arguments || {};
        }
        content += `\n<tool_call>\n${JSON.stringify({ name: tc.function?.name, arguments: tcArgs })}\n</tool_call>`;
      }
    }

    if (role === 'TOOL') {
      parts.push(`[TOOL RESULT: ${msg.name || msg.tool_call_id || 'unknown'}]\n${content}`);
    } else {
      parts.push(`[${role}]\n${content}`);
    }
  }

  return parts.join('\n\n');
}
