import http from 'node:http';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DeepSeekWebClient } from './deepseek.js';
import { formatMessagesToPrompt, computeToolsHash } from './agent_prompt.js';
import { enqueueDeepHatObservation, consumeDeepHatAdvice, consultDeepHatDirect, isDeepHatAlive } from './deephat.js';
import { upsertAccount } from '../cli/accounts.js';
import { emitActivity } from './activity.js';

const PORT = parseInt(process.env.PORT || '5050', 10);
const HOST = process.env.HOST || '0.0.0.0';

const client = new DeepSeekWebClient();

// The DeepSeek Web account underlying `client` cannot run two generations at
// once — firing concurrent /v1/chat/completions for different models/sessions
// (e.g. deepseek-reasoner and deepseek-chat running side by side) silently
// starves one of them: it comes back with 0 tokens and a desynced
// parentMessageId instead of an explicit error. Serializing every completion
// through this single-slot queue, regardless of which session/model, avoids
// the collision entirely at the cost of true parallelism between models.
//
// Bounded depth (backpressure): a client stuck retrying in a tight loop —
// or several sessions failing at once — used to pile every attempt onto
// this queue with no limit. Since the queue is strictly FIFO and global,
// that backlog head-of-line-blocked every *other* request too, including
// ones on completely unrelated sessions: a single isolated debug request
// was observed waiting 20+ seconds behind ~94 already-abandoned retries
// from a dead client. Past DEEPBLACK_MAX_QUEUE_DEPTH, new requests are
// rejected immediately with a clear error instead of silently queueing —
// callers can see it's their own retry storm and back off, rather than
// everyone hanging with no signal.
let completionQueue = Promise.resolve();
let completionQueueDepth = 0;
export function getCompletionQueueDepth() {
  return completionQueueDepth;
}
export function withCompletionLock(fn) {
  const maxDepth = parseInt(process.env.DEEPBLACK_MAX_QUEUE_DEPTH || '5', 10);
  if (completionQueueDepth >= maxDepth) {
    return Promise.reject(new Error(
      `DeepBlack completion queue is full (${completionQueueDepth} requests already waiting, limit ${maxDepth}) — ` +
      `refusing to enqueue another to avoid unbounded head-of-line blocking. This usually means a client is ` +
      `retrying in a tight loop without backoff; check its retry logic before retrying again.`
    ));
  }
  completionQueueDepth++;
  const run = completionQueue.then(fn, fn);
  completionQueue = run.then(() => {}, () => {});
  run.finally(() => { completionQueueDepth--; });
  return run;
}

// Rough token estimate (chars / 4) used to populate `usage` for both the
// non-streaming response and the streaming `usage` chunk below. DeepSeek Web
// doesn't expose real token counts, so this is an approximation — good enough
// for clients (like OpenCode) that just want a non-zero, roughly-proportional
// number instead of a hardcoded 0.
//
// `promptChars` MUST be derived from the full `messages` array (see
// estimateMessagesChars below), not from the `prompt` string actually sent to
// DeepSeek Web this turn. That `prompt` is frequently just a *delta* (new
// messages only — see formatMessagesToPrompt's isNewSession=false branch),
// which is far shorter than the real conversation. Using it here made the
// client-visible "Context" meter (packages/tui's sidebar) swing wildly on
// every turn — e.g. ~400 tokens on a session-rotation turn (full prompt
// rebuilt) dropping to ~300 on the very next turn (delta only), then back up
// — instead of growing monotonically like the rest of the ecosystem expects
// from `usage.prompt_tokens`. messages.length only grows across a
// conversation, so keying off it keeps the estimate stable and meaningful
// regardless of DeepBlack's internal session-continuation optimizations.
function estimateUsage(promptChars, thinkingText, contentText) {
  return {
    prompt_tokens: Math.round(promptChars / 4),
    completion_tokens: Math.round((thinkingText.length + contentText.length) / 4),
    total_tokens: Math.round((promptChars + thinkingText.length + contentText.length) / 4)
  };
}

// Sums the character length of every message's content (string or
// content-part array) plus any tool_calls payload, giving a stable proxy for
// "how big is the full conversation so far" independent of how much of it
// DeepBlack actually had to re-send to DeepSeek Web this turn.
export function estimateMessagesChars(messages) {
  let total = 0;
  for (const m of messages || []) {
    if (typeof m.content === 'string') {
      total += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (typeof part === 'string') total += part.length;
        else if (part && typeof part.text === 'string') total += part.text.length;
        else if (part) total += JSON.stringify(part).length;
      }
    }
    if (m.tool_calls) total += JSON.stringify(m.tool_calls).length;
  }
  return total;
}

function setCors(res, req) {
  const origin = req?.headers?.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Session-Id, x-device-id');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (origin !== '*') {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data, req = null) {
  if (res.headersSent) return;
  setCors(res, req);
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// DeepSeek's tokenizer occasionally emits a CJK character instead of the
// DSML control pipe (｜, U+FF5C) immediately next to the literal "DSML"
// token — observed glitches: 该 (U+8BE5, simplified) and 該 (U+8A72,
// traditional — same word, different codepoint, both seen in production),
// e.g. "<｜该DSML｜｜ calls>" or "<｜該DSML｜｜ calls>" instead of
// "<｜｜DSML｜｜ calls>". Normalizing this ONCE, up front, means every
// existing DSML regex in this file keeps working unmodified instead of
// duplicating a tolerant character class across a dozen patterns — and if
// another glitch glyph shows up later, it's a one-line addition here.
const DSML_GLITCH_CHARS = '该該';

export function normalizeDsmlGlitches(text) {
  if (typeof text !== 'string' || !text.includes('DSML')) return text;
  const glitchClass = `[${DSML_GLITCH_CHARS}]`;
  return text
    .replace(new RegExp(`${glitchClass}(?=DSML)`, 'g'), '｜')
    .replace(new RegExp(`(?<=DSML)${glitchClass}`, 'g'), '｜');
}

function sanitizeArg(val, isFileContent = false) {
  if (typeof val !== 'string') return val;
  let cleaned = val
    .replace(/<\/?(?:[|｜]{1,2}DSML[|｜]{1,2}\s*)?(?:calls|invoke|parameter|workdir|write|bash|read|edit|filePath|content)[^>]*>/gi, '')
    .replace(/[<\\/]*[|｜]{1,2}DSML[|｜]{1,2}[^>]*>?/gi, '')
    .replace(/<\/?(?:tool_call|call_call|call|tool|tools)>/gi, '')
    .replace(/\s*#\s*(?:[<\\/]*[|｜]{1,2}DSML[|｜]{1,2}[^>]*>?.*)?$/gi, '')
    .replace(/\s*#\s*<\/?(?:tool_call|call_call|call|tool|invoke|parameter|calls)[^>\n\r]*$/gi, '');

  if (!isFileContent) {
    cleaned = cleaned
      .replace(/\s*#\s*$/g, '')
      .trim();
  } else {
    cleaned = cleaned.trimEnd();
  }
  return cleaned;
}

// Undoes standard JSON string escaping (\\ -> \, \n -> newline, \uXXXX, ...)
// on text captured directly out of raw model output by a regex (not via
// JSON.parse). Without this, a correctly-escaped "\\Users\\vitor" in the raw
// text becomes a literal double backslash in the final argument value —
// corrupting Windows paths in the args JSON.parse() itself couldn't recover.
function unescapeJsonString(raw) {
  if (typeof raw !== 'string') return raw;
  return raw.replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})/g, (match, esc) => {
    switch (esc[0]) {
      case '"': return '"';
      case '\\': return '\\';
      case '/': return '/';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'u': return String.fromCharCode(parseInt(esc.slice(1), 16));
      default: return match;
    }
  });
}

// Scans from the first `{` or `[` and tracks bracket depth (respecting
// string literals and escapes) to find the exact matching closing bracket,
// returning just that substring. Used when the model appends trailing
// garbage after an otherwise well-formed JSON object/array — e.g. a stray
// duplicated <|DSML| parameter> block, a leftover </invoke>, or another tool
// call bleeding into the same text. A plain JSON.parse() on the full string
// fails on that trailing data even though the actual tool call was fine.
export function extractBalancedJson(text) {
  if (!text || typeof text !== 'string') return null;
  let start = -1;
  let open, close;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{' || text[i] === '[') {
      start = i;
      open = text[i];
      close = open === '{' ? '}' : ']';
      break;
    }
  }
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (ch === '\\') { escapeNext = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // never closed (genuinely truncated) -- let other fallbacks handle it
}

export function robustParseJson(str) {
  if (!str || typeof str !== 'string') return null;
  const trimmed = str.trim();
  try {
    return JSON.parse(trimmed);
  } catch (err1) {
    // 1. Fix unescaped raw newlines inside string literals
    let fixed = trimmed.replace(/(?<!\\)(?:\\\\)*"((?:[^"\\]|\\.)*)"/gs, (match) => {
      return match.replace(/\r?\n/g, '\\n');
    });

    // 2. Fix invalid Windows backslashes like C:\Users (not followed by ", \, /, b, f, n, r, t, u).
    // Pair-aware: a valid 2+ char escape (\\, \n, \uXXXX...) is matched and left
    // untouched as a whole; only a truly lone backslash falls through to the
    // second alternative and gets doubled. A naive per-character check here
    // would "fix" the second backslash of an already-valid \\ pair too,
    // corrupting real Windows paths that were already correctly escaped.
    fixed = fixed.replace(/\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})|\\/g, (m) => (m.length > 1 ? m : '\\\\'));

    // 3. Fix trailing commas
    fixed = fixed.replace(/,\s*([\}\]])/g, '$1');

    try {
      return JSON.parse(fixed);
    } catch (err2) {
      // 3.5. The model often appends trailing garbage AFTER an otherwise
      // well-formed JSON object (a stray duplicated <|DSML| parameter> block,
      // a leftover </invoke>, another tool call bleeding into the same text —
      // see tests/test_balanced_json_trailing_garbage.js, root-caused live
      // 2026-09-21 from a todowrite call whose `todos` array got dropped this
      // way). Try extracting just the first balanced {...}/[...] and parsing
      // THAT — this is general-purpose (works for any tool/field shape)
      // unlike the per-field regex fallback below, which only knows about a
      // fixed set of field names and silently drops anything else.
      const balanced = extractBalancedJson(trimmed);
      if (balanced && balanced !== trimmed) {
        try {
          let balancedFixed = balanced.replace(/(?<!\\)(?:\\\\)*"((?:[^"\\]|\\.)*)"/gs, (match) => {
            return match.replace(/\r?\n/g, '\\n');
          });
          balancedFixed = balancedFixed.replace(/\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})|\\/g, (m) => (m.length > 1 ? m : '\\\\'));
          balancedFixed = balancedFixed.replace(/,\s*([\}\]])/g, '$1');
          return JSON.parse(balancedFixed);
        } catch (err3) {
          // fall through to the field-by-field fallback below
        }
      }

      // 4. Fallback regex field extractor if JSON is completely mangled
      const nameMatch = trimmed.match(/"(?:name|tool)"\s*:\s*"([^"]+)"/i);
      const name = nameMatch ? nameMatch[1] : null;

      const fileMatch = trimmed.match(/"(?:filePath|path)"\s*:\s*"([^"\n\r]+?)(?:[<\\/]*[|｜]{1,2}DSML[|｜]{1,2}[^>]*>?)?"/i);

      const content = extractQuotedFieldFallback(trimmed, 'content|fileContent');
      const command = extractQuotedFieldFallback(trimmed, 'command|cmd');
      // edit's oldString/newString hit the exact same truncation failure mode
      // as content/command (long multi-line diff body, cut off mid-string by
      // DeepSeek's own native tokens) but were never extracted here — the
      // tool call reached the CLI missing oldString entirely, and the edit
      // schema rejected the whole call. See tests/test_edit_oldstring_recovery.js
      // (root-caused from session-ses_f3b0.md, benchmark 2, 2026-09-21).
      const oldString = extractQuotedFieldFallback(trimmed, 'oldString|oldStr|old_string');
      const newString = extractQuotedFieldFallback(trimmed, 'newString|newStr|new_string');

      if (name || fileMatch || command || oldString) {
        const args = {};
        if (fileMatch) args.filePath = sanitizeArg(unescapeJsonString(fileMatch[1]));
        if (content !== null) args.content = unescapeJsonString(content);
        if (command !== null) args.command = sanitizeArg(unescapeJsonString(command));
        if (oldString !== null) args.oldString = unescapeJsonString(oldString);
        if (newString !== null) args.newString = unescapeJsonString(newString);
        return { name, arguments: args };
      }
      return null;
    }
  }
}

// Shared by robustParseJson's mangled-JSON fallback: extracts the raw text of
// a quoted field's value even when the surrounding JSON is truncated/invalid,
// by finding the field's opening quote and reading until the next field key
// (or a closing brace, or the last quote in the string as a last resort).
function extractQuotedFieldFallback(trimmed, keyAlternation) {
  const prefixMatch = trimmed.match(new RegExp(`"(?:${keyAlternation})"\\s*:\\s*"`, 'i'));
  if (!prefixMatch) return null;
  const startIdx = prefixMatch.index + prefixMatch[0].length;
  const endSuffixMatch = trimmed.slice(startIdx).match(/"\s*(?:,\s*"[a-zA-Z0-9_-]+"\s*:|\}\s*\}|\}\s*$)/);
  if (endSuffixMatch) {
    return trimmed.slice(startIdx, startIdx + endSuffixMatch.index);
  }
  const lastQuote = trimmed.lastIndexOf('"');
  return lastQuote > startIdx ? trimmed.slice(startIdx, lastQuote) : trimmed.slice(startIdx);
}

function inferToolFromParams(params) {
  if (!params || typeof params !== 'object') return null;
  const keys = Object.keys(params).map(k => k.toLowerCase());
  if (keys.includes('command')) return 'bash';
  if (keys.includes('question') || keys.includes('questions')) return 'question';
  if (keys.includes('filepath') && keys.includes('content')) return 'write';
  if (keys.includes('filepath') && (keys.includes('oldstr') || keys.includes('oldstring') || keys.includes('newstr'))) return 'edit';
  // Model emitted a script/content block but omitted <invoke name="write">
  // and filePath entirely (orphan DSML). Still infer 'write' — dropping the
  // tool call here means the whole script silently vanishes from the turn.
  // normalizeToolNameAndArgs() backfills a placeholder filePath below.
  if (keys.includes('content')) return 'write';
  if (keys.includes('filepath') || (keys.includes('path') && !keys.includes('command'))) return 'read';
  if (keys.includes('pattern')) return 'grep';
  if (keys.includes('url')) return 'webfetch';
  if (keys.includes('subagent_type') || keys.includes('prompt')) return 'task';
  if (keys.includes('todos')) return 'todowrite';
  return null;
}

/**
 * Infers a placeholder filePath when the model emits a 'write' with content
 * but no filePath at all (orphan DSML, no <invoke>). Checks for an explicit
 * hint comment first, then falls back to a generic name by content sniffing.
 */
export function inferFilePathFromContent(content) {
  const firstLine = (content.split('\n', 1)[0] || '').trim();

  const hintMatch = firstLine.match(/^(?:#|\/\/)\s*(?:filename|file|path)\s*:\s*(\S+)/i);
  if (hintMatch) return hintMatch[1];

  if (/^#!.*python/i.test(firstLine) || /\b(import\s+\w+|from\s+\w+\s+import\s+|def\s+\w+\s*\(|print\s*\(|class\s+\w+\s*[:(])/.test(content)) {
    return 'temp_script.py';
  }
  if (/^#!.*\b(bash|sh|zsh)\b/i.test(firstLine) || content.includes('#!/bin/') || /(^|\n)\s*(curl\s|wget\s|chmod\s)/.test(content)) {
    return 'temp_script.sh';
  }
  return 'temp_file.txt';
}

export function transformWslCommand(cmd) {
  if (typeof cmd !== 'string') return cmd;
  const trimmed = cmd.trim();

  // Match: wsl [-d distro] [--|-e] bash [-lc|-c] "..." or '...'
  const wslMatch = trimmed.match(/^wsl(?:\.exe)?\s+(-d\s+[a-zA-Z0-9_\-\.]+\s+)?(?:--\s+|-e\s+)?bash\s+(-[a-zA-Z]*c)\s+((?:"[\s\S]*")|(?:'[\s\S]*'))$/i);
  let distroPart = '';
  let flags = '-lc';
  let rawQuotedScript = '';

  if (wslMatch) {
    distroPart = wslMatch[1] ? wslMatch[1].trim() : '';
    flags = wslMatch[2] || '-lc';
    rawQuotedScript = wslMatch[3].trim();
  } else {
    // Also match standalone bash -c "..." or bash -lc "..."
    const bashMatch = trimmed.match(/^bash(?:\.exe)?\s+(-[a-zA-Z]*c)\s+((?:"[\s\S]*")|(?:'[\s\S]*'))$/i);
    if (bashMatch) {
      flags = bashMatch[1] || '-c';
      rawQuotedScript = bashMatch[2].trim();
    } else {
      return cmd;
    }
  }

  // Strip outer quotes
  let script = rawQuotedScript.slice(1, -1);
  
  // If outer quotes were double quotes, unescape \" to "
  if (rawQuotedScript.startsWith('"') && rawQuotedScript.endsWith('"')) {
    script = script.replace(/\\"/g, '"');
  }

  // If the script contains characters that break PowerShell ($p, ", ', @, 2>, etc.)
  if (/[\$@"'\`\n\r<>|;&]/.test(script)) {
    const b64 = Buffer.from(script, 'utf8').toString('base64');
    const distroArg = distroPart ? `${distroPart} ` : '';
    const bashFlags = flags.includes('l') ? '-l' : '';
    if (wslMatch) {
      return `wsl ${distroArg}-- bash -c "echo ${b64} | base64 -d | bash ${bashFlags}"`.trim();
    } else {
      return `bash -c "echo ${b64} | base64 -d | bash ${bashFlags}"`.trim();
    }
  }

  return cmd;
}

export function normalizeToolNameAndArgs(name, args) {
  let toolName = (name || '').trim();
  let cleanArgs = (args && typeof args === 'object') ? { ...args } : {};

  // Map hallucinated tool names
  const lowerName = toolName.toLowerCase();
  if (lowerName === 'filepath' || lowerName === 'path') {
    if (cleanArgs.content !== undefined || (typeof cleanArgs.input === 'string' && cleanArgs.input.includes('\n'))) {
      toolName = 'write';
    } else {
      toolName = 'read';
    }
  } else if (lowerName === 'command' || lowerName === 'cmd') {
    toolName = 'bash';
  } else if (lowerName === 'question' || lowerName === 'questions') {
    toolName = 'question';
  }

  // Handle single "input" string passed to write, read, or bash
  if (cleanArgs.input && typeof cleanArgs.input === 'string') {
    const rawInput = cleanArgs.input;
    if (toolName === 'write') {
      if (!cleanArgs.filePath || !cleanArgs.content) {
        const lines = rawInput.split('\n');
        const firstLine = lines[0].trim();
        // If first line looks like a file path
        if (firstLine.includes('\\') || firstLine.includes('/') || /\.[a-zA-Z0-9_-]+$/.test(firstLine)) {
          cleanArgs.filePath = cleanArgs.filePath || firstLine;
          cleanArgs.content = cleanArgs.content || lines.slice(1).join('\n');
          delete cleanArgs.input;
        } else if (cleanArgs.filePath && !cleanArgs.content) {
          cleanArgs.content = rawInput;
          delete cleanArgs.input;
        }
      }
    } else if (toolName === 'read') {
      if (!cleanArgs.filePath) {
        cleanArgs.filePath = rawInput.trim();
        delete cleanArgs.input;
      }
    } else if (toolName === 'bash') {
      if (!cleanArgs.command) {
        cleanArgs.command = rawInput.trim();
        delete cleanArgs.input;
      }
    }
  }

  // If write is missing content or filePath, infer from other keys
  if (toolName === 'write') {
    if (!cleanArgs.filePath && cleanArgs.path) {
      cleanArgs.filePath = cleanArgs.path;
      delete cleanArgs.path;
    }
    if (!cleanArgs.content && cleanArgs.fileContent) {
      cleanArgs.content = cleanArgs.fileContent;
      delete cleanArgs.fileContent;
    }
    // Model omitted filePath entirely (orphan DSML content block). Without
    // this, downstream tool executors reject "missing required argument:
    // filePath" and the whole script is lost.
    if (!cleanArgs.filePath && typeof cleanArgs.content === 'string' && cleanArgs.content.length > 0) {
      cleanArgs.filePath = inferFilePathFromContent(cleanArgs.content);
    }
  }

  // If read is missing filePath
  if (toolName === 'read') {
    if (!cleanArgs.filePath && cleanArgs.path) {
      cleanArgs.filePath = cleanArgs.path;
      delete cleanArgs.path;
    }
  }

  // If bash is missing command
  if (toolName === 'bash') {
    if (!cleanArgs.command && cleanArgs.cmd) {
      cleanArgs.command = cleanArgs.cmd;
      delete cleanArgs.cmd;
    }
  }

  return { name: toolName, args: cleanArgs };
}

export function cleanToolBlocks(text) {
  if (!text || typeof text !== 'string') return '';
  text = normalizeDsmlGlitches(text);
  return text
    .replace(/<[|｜]{1,2}DSML[|｜]{1,2}\s*calls>[\s\S]*?<\/[|｜]{1,2}DSML[|｜]{1,2}\s*calls>/gi, '')
    .replace(/<(?:[|｜]{1,2}DSML[|｜]{1,2}\s*)?invoke[\s\S]*?(?:<\/(?:[|｜]{1,2}DSML[|｜]{1,2}\s*)?invoke>|<\/invoke>|(?=<[|｜]{1,2}DSML)|$)/gi, '')
    .replace(/<[|｜]{1,2}DSML[|｜]{1,2}\s*(?:parameter\s+[^>]*?name=["']?[^"'\s>=]+["']?[^>]*|[a-zA-Z0-9_]+[^>]*)>[\s\S]*?(?:<\/(?:[|｜]{1,2}DSML[|｜]{1,2}\s*)?(?:parameter|[a-zA-Z0-9_]+)?>|<\/parameter>|(?=<[|｜]{1,2}DSML)|$)/gi, '')
    .replace(/<(?:tool_call|call_call|call|tool)>[\s\S]*?(?:<\/(?:tool_call|call_call|call|tool|tools)>|<\/[|｜]{1,2}DSML[|｜]{1,2}\s*calls>|$)/gi, '')
    .replace(/```(?:json)?\s*\{[\s\S]*?"(?:name|tool)"\s*:\s*"[^"]+"[\s\S]*?\}\s*```/gi, '')
    .replace(/<\/?(?:tool_call|call_call|call|tool|tools)>/gi, '')
    // Reserved tool vocabulary WITHOUT a DSML prefix — strict allowlist only,
    // never a generic [a-zA-Z0-9_]+ catch-all. The old catch-all matched ANY
    // bare tag name (table, form, input, div, td...) whenever the DSML
    // prefix was absent, silently destroying legitimate HTML the model
    // quoted or generated (e.g. while analyzing a scraped page).
    .replace(/<\/?(?:calls|invoke|parameter|question)[^>]*>/gi, '')
    // Anything that DOES carry the DSML prefix is unambiguously tool
    // machinery regardless of the word after it — safe to strip broadly.
    .replace(/<\/?[|｜]{1,2}DSML[|｜]{1,2}\s*[a-zA-Z0-9_]*[^>]*>/gi, '')
    .replace(/[<\\/]*[|｜]{1,2}DSML[|｜]{1,2}[^>]*>?/gi, '')
    .trim();
}

// Strict allowlist for the small set of NATIVE tools whose cross-tool param
// bleed has actually corrupted files live: when the model emits a malformed
// or duplicated tool-call block, `args` can end up carrying keys that
// plainly belong to a DIFFERENT tool than the one actually named (e.g.
// name="bash" also picking up filePath/oldString/newString/replaceAll — the
// edit tool's vocabulary, from a stray/merged <parameter> block). Forwarding
// those extras unfiltered let a bash call get reinterpreted downstream as an
// edit and silently overwrite an unrelated file with the bash command text
// as its new content (root-caused live 2026-09-21: comparacao.md got
// replaced by a shell one-liner this way). Only native tools with a small,
// well-known schema are listed — unknown tool names (MCP, user-declared)
// pass through unfiltered since there's no local schema to check them against.
const NATIVE_TOOL_ALLOWED_ARGS = {
  bash: ['command', 'workdir', 'timeout'],
  write: ['filePath', 'content'],
  edit: ['filePath', 'oldString', 'newString', 'replaceAll'],
  todowrite: ['todos'],
};

function filterArgsForTool(name, args) {
  const allowed = NATIVE_TOOL_ALLOWED_ARGS[name];
  if (!allowed || !args || typeof args !== 'object') return args;
  const filtered = {};
  const dropped = [];
  for (const [k, v] of Object.entries(args)) {
    if (allowed.includes(k)) filtered[k] = v;
    else dropped.push(k);
  }
  if (dropped.length > 0) {
    console.warn(`[Bridge Parser] tool="${name}" dropped foreign args (cross-tool bleed): ${dropped.join(', ')}`);
  }
  return filtered;
}

// Coerces a raw <parameter> text value to its JSON primitive when possible,
// tolerating trailing garbage after the value itself (same malformed-DSML
// class as extractBalancedJson above) by falling back to matching just a
// leading true/false/null/number token instead of giving up and leaving the
// whole thing as a string. Without this, a value like `true` immediately
// followed by leftover tag fragments (JSON.parse fails on the trailing
// junk) reached the client as the STRING "true" instead of the boolean the
// schema required — e.g. edit's `replaceAll`, observed live 2026-09-21
// (SchemaError: Expected boolean | undefined, got "true").
export function coerceParamValue(raw) {
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const m = trimmed.match(/^(true|false|null|-?\d+(?:\.\d+)?)\b/i);
    if (m) {
      try { return JSON.parse(m[1].toLowerCase()); } catch { /* fall through */ }
    }
    return raw;
  }
}

export function parseToolCallsFromText(text) {
  if (!text || typeof text !== 'string') return [];
  text = normalizeDsmlGlitches(text);
  const toolCalls = [];
  let idx = 0;

  function pushTool(name, args) {
    const norm = normalizeToolNameAndArgs(name, args);
    name = norm.name;
    args = norm.args;

    if (!name || name === 'tool_call' || name === 'call_call' || name === 'call') {
      name = inferToolFromParams(args);
      if (!name) return;
    }

    args = filterArgsForTool(name, args);

    // Sanitize arguments
    const cleanArgs = {};
    if (args && typeof args === 'object') {
      for (const [k, v] of Object.entries(args)) {
        if (typeof v === 'string') {
          // Check if command has embedded workdir
          if (k === 'command') {
            const workdirMatch = v.match(/(?:<|\b)workdir(?:\s*=\s*|["'\s>]*)(?:["']?string["']?>\s*)?([^#<\n\r"']+)/i);
            if (workdirMatch && !args.workdir) {
              cleanArgs['workdir'] = sanitizeArg(workdirMatch[1]);
            }
            cleanArgs[k] = transformWslCommand(sanitizeArg(v));
          } else {
            cleanArgs[k] = sanitizeArg(v, k === 'content');
          }
        } else {
          cleanArgs[k] = v;
        }
      }
    }

    toolCalls.push({
      index: idx++,
      id: `call_${Date.now()}_${idx}`,
      type: 'function',
      function: {
        name,
        arguments: JSON.stringify(cleanArgs)
      }
    });
  }

  function normalizeAndPush(parsed) {
    if (!parsed || typeof parsed !== 'object') return;
    let name = parsed.name || parsed.tool || parsed.function?.name;
    let args = parsed.arguments ?? parsed.parameters ?? parsed.args ?? {};

    if (typeof args === 'string') {
      const parsedArgs = robustParseJson(args);
      if (parsedArgs && typeof parsedArgs === 'object') {
        args = parsedArgs;
      }
    }

    const norm = normalizeToolNameAndArgs(name, args);
    name = norm.name;
    args = norm.args;

    // Unwrap nested structures (e.g. { arguments: { command: "..." } } or { name: ..., arguments: ... })
    let depth = 0;
    while (args && typeof args === 'object' && depth < 5) {
      depth++;
      if (args.name && (args.arguments || args.parameters)) {
        name = args.name;
        args = args.arguments || args.parameters;
        continue;
      }
      if (args.arguments && typeof args.arguments === 'object') {
        args = args.arguments;
        continue;
      }
      break;
    }

    if (typeof args === 'string') {
      const parsedArgs = robustParseJson(args);
      if (parsedArgs && typeof parsedArgs === 'object') {
        args = parsedArgs;
      }
    }

    // CRITICAL: Extract parameters if packed into args.input or args.command as XML/DSML
    if (args && typeof args === 'object') {
      for (const key of ['input', 'command']) {
        if (typeof args[key] === 'string' && (args[key].includes('parameter') || args[key].includes('DSML'))) {
          const raw = args[key];
          const extracted = {};
          const innerParamRegex = /<(?:[|｜]{1,2}DSML[|｜]{1,2}\s*)?parameter\s+[^>]*?name=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)(?:<\/(?:[|｜]{1,2}DSML[|｜]{1,2}\s*)?parameter>|<\/parameter>|(?=<(?:[|｜]{1,2}DSML[|｜]{1,2}\s*)?parameter\s+)|$)/gi;
          let ipMatch;
          while ((ipMatch = innerParamRegex.exec(raw)) !== null) {
            const pName = ipMatch[1];
            const pVal = coerceParamValue(ipMatch[2].trim());
            extracted[pName] = pVal;
          }
          if (Object.keys(extracted).length > 0) {
            delete args[key];
            Object.assign(args, extracted);
            break;
          }
        }
      }
    }

    if (!name && args && typeof args === 'object') {
      name = inferToolFromParams(args);
    }

    pushTool(name, args);
  }

  // 1. Check for standard DeepSeek DSML tool calls (<invoke name="...">)
  // NOTE: the lazy content group below must not terminate on a *nested*
  // <...DSML...parameter> tag — those are legitimate children of this same
  // <invoke> block. The lookahead only exists to bail out early when a
  // genuinely different DSML construct starts (e.g. a stray new invoke from
  // a truncated stream), hence the `(?!parameter\b)` guard. Without it,
  // paramsBlock gets cut off right after the opening tag whenever the first
  // nested parameter happens to carry the DSML prefix, silently producing a
  // tool call with empty arguments (see tests/test_f4f2_recovery.js).
  const dsmlInvokeRegex = /<(?:[|｜]{1,2}DSML[|｜]{1,2}\s*)?invoke\s+[^>]*?name=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)(?:<\/(?:[|｜]{1,2}DSML[|｜]{1,2}\s*)?invoke>|<\/invoke>|(?=<[|｜]{1,2}DSML[|｜]{1,2}(?![|｜])(?!\s*parameter\b))|$)/gi;
  let match;

  while ((match = dsmlInvokeRegex.exec(text)) !== null) {
    const name = match[1];
    const paramsBlock = match[2];
    const args = {};
    const prefixMatch = paramsBlock.match(/^([\s\S]*?)<(?:[|｜]{1,2}DSML[|｜]{1,2}\s*)?parameter/i);
    if (prefixMatch) {
      const prefix = sanitizeArg(prefixMatch[1]);
      if (prefix.length > 0) {
        if (name.toLowerCase() === 'filepath' || name.toLowerCase() === 'path' || prefix.includes('\\') || prefix.includes('/') || /\.[a-zA-Z0-9_-]+$/.test(prefix)) {
          args['filePath'] = prefix;
        }
      }
    }

    const paramRegex = /<(?:[|｜]{1,2}DSML[|｜]{1,2}\s*)?(?:parameter\s+[^>]*?name=["']?([^"'\s>=]+)["']?[^>]*|([a-zA-Z0-9_]+)[^>]*)>([\s\S]*?)(?:<\/(?:[|｜]{1,2}DSML[|｜]{1,2}\s*)?(?:parameter|[a-zA-Z0-9_]+)?>|<\/parameter>|(?=<[|｜]{1,2}DSML)|(?=<\/[|｜]{1,2}DSML)|(?=<parameter)|$)/gi;
    let pMatch;
    let foundParams = Object.keys(args).length > 0;
    while ((pMatch = paramRegex.exec(paramsBlock)) !== null) {
      foundParams = true;
      const pName = pMatch[1] || pMatch[2];
      if (!pName || pName === 'calls' || pName === 'invoke') continue;
      const pVal = coerceParamValue(pMatch[3].trim());
      args[pName] = sanitizeArg(pVal, pName === 'content');
    }

    // If no <parameter> tags matched, check if paramsBlock contains a direct JSON object
    if (!foundParams || Object.keys(args).length === 0) {
      const jsonMatch = paramsBlock.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const directParsed = robustParseJson(jsonMatch[0]);
        if (directParsed) {
          normalizeAndPush({ name, arguments: directParsed });
          continue;
        }
      }
      // Fallback: clean out closing tags and use clean text
      const cleanBlock = sanitizeArg(paramsBlock);
      if (cleanBlock.length > 0) {
        if (name === 'bash') {
          normalizeAndPush({ name, arguments: { command: cleanBlock } });
        } else {
          normalizeAndPush({ name, arguments: { input: cleanBlock } });
        }
        continue;
      }
    }

    normalizeAndPush({ name, arguments: args });
  }

  // 2. Check for DSML <calls> WITHOUT <invoke> (directly containing parameters / tool closing tag)
  if (toolCalls.length === 0) {
    const dsmlCallsRegex = /<[|｜]{1,2}DSML[|｜]{1,2}\s*calls>([\s\S]*?)(?:<\/[|｜]{1,2}DSML[|｜]{1,2}\s*calls>|$)/gi;
    while ((match = dsmlCallsRegex.exec(text)) !== null) {
      const callsBlock = match[1];

      // Check if callsBlock has tool closing tag like </｜｜DSML｜｜ write> or </｜｜DSML｜｜ bash>
      const toolCloseMatch = callsBlock.match(/<\/[|｜]{1,2}DSML[|｜]{1,2}\s*([a-zA-Z0-9_]+)>/i);
      let blockToolName = toolCloseMatch ? toolCloseMatch[1] : null;
      if (blockToolName && ['calls', 'invoke', 'parameter'].includes(blockToolName.toLowerCase())) {
        blockToolName = null;
      }

      const paramRegex = /<(?:[|｜]{1,2}DSML[|｜]{1,2}\s*)?(?:parameter\s+[^>]*?name=["']?([^"'\s>=]+)["']?[^>]*|([a-zA-Z0-9_]+)[^>]*)>([\s\S]*?)(?:<\/(?:[|｜]{1,2}DSML[|｜]{1,2}\s*)?(?:parameter|[a-zA-Z0-9_]+)?>|<\/parameter>|(?=<[|｜]{1,2}DSML)|(?=<\/[|｜]{1,2}DSML)|(?=<parameter)|$)/gi;
      let pMatch;
      const args = {};
      while ((pMatch = paramRegex.exec(callsBlock)) !== null) {
        const pName = pMatch[1] || pMatch[2];
        if (!pName || pName === 'calls' || pName === 'invoke') continue;
        if (['write', 'bash', 'read', 'edit'].includes(pName.toLowerCase()) && !pMatch[3].trim()) continue;

        const pVal = coerceParamValue(pMatch[3].trim());
        args[pName] = sanitizeArg(pVal, pName === 'content');
      }

      const finalName = blockToolName || inferToolFromParams(args);
      if (finalName && Object.keys(args).length > 0) {
        normalizeAndPush({ name: finalName, arguments: args });
      }
    }
  }

  // 3. Check for standalone <parameter> tags anywhere in text if still empty
  if (toolCalls.length === 0) {
    const standaloneParamRegex = /<(?:[|｜]{1,2}DSML[|｜]{1,2}\s*)?parameter\s+[^>]*?name=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)(?:<\/(?:[|｜]{1,2}DSML[|｜]{1,2}\s*)?parameter>|<\/parameter>|(?=<(?:[|｜]{1,2}DSML[|｜]{1,2}\s*)?parameter)|<\/[|｜]{1,2}DSML[|｜]{1,2}|<\\\/[|｜]{1,2}DSML[|｜]{1,2}|$)/gi;
    let sMatch;
    const args = {};
    while ((sMatch = standaloneParamRegex.exec(text)) !== null) {
      const pName = sMatch[1];
      const pVal = coerceParamValue(sMatch[2].trim());
      args[pName] = sanitizeArg(pVal, pName === 'content');
    }
    if (Object.keys(args).length > 0) {
      const inferredName = inferToolFromParams(args);
      if (inferredName) {
        normalizeAndPush({ name: inferredName, arguments: args });
      }
    }
  }

  // 4. Check for <tool_call>, <call_call>, <call> blocks with ANY closing tag
  const jsonCallRegex = /<(?:tool_call|call_call|call|tool)>([\s\S]*?)(?:<\/(?:tool_call|call_call|call|tool|tools)>|<\/[|｜]{1,2}DSML[|｜]{1,2}\s*calls>|$)/gi;
  while ((match = jsonCallRegex.exec(text)) !== null) {
    const parsed = robustParseJson(match[1]);
    if (parsed) {
      normalizeAndPush(parsed);
    }
  }

  // 5. Check for unclosed <tool_call> or <call_call> block at the end
  if (toolCalls.length === 0) {
    const unclosedMatch = text.match(/<(?:tool_call|call_call|call|tool)>([\s\S]*)$/i);
    if (unclosedMatch) {
      const parsed = robustParseJson(unclosedMatch[1]);
      if (parsed) {
        normalizeAndPush(parsed);
      }
    }
  }

  // 6. Check for markdown code blocks with JSON tool calls
  if (toolCalls.length === 0) {
    const mdBlockRegex = /```(?:json)?\s*(\{[\s\S]*?"(?:name|tool)"\s*:\s*"[^"]+"[\s\S]*?\})\s*```/gi;
    let mdMatch;
    while ((mdMatch = mdBlockRegex.exec(text)) !== null) {
      const parsed = robustParseJson(mdMatch[1]);
      if (parsed) {
        normalizeAndPush(parsed);
      }
    }
  }

  // 7. Check for shorthand Read calls e.g. "Read cols.txt<\｜｜DSML｜｜>"
  if (toolCalls.length === 0) {
    const readMatch = text.match(/(?:^|\n)\s*Read\s+["']?([^"'\n\r<]+)["']?\s*(?:<[\\|｜]{1,2}DSML|<\\[|｜]{1,2}DSML|$)/i);
    if (readMatch) {
      normalizeAndPush({ name: 'read', arguments: { filePath: sanitizeArg(readMatch[1]) } });
    }
  }

  return toolCalls;
}

// Built-in fallback: required arg names for native tools, used only when the
// client didn't declare a JSON Schema for that tool name (e.g. it's a
// hardcoded local tool rather than something passed via `tools`).
const NATIVE_TOOL_REQUIRED_ARGS = {
  bash: ['command'],
  write: ['filePath', 'content'],
  edit: ['filePath'],
  read: ['filePath'],
  grep: ['pattern'],
  glob: ['pattern'],
  webfetch: ['url'],
  task: ['prompt'],
  todowrite: ['todos']
};

/**
 * Resolves the effective thinking_enabled/search_enabled flags for a
 * completion, given the raw request body and the target model name.
 *
 * Priority (most to least specific):
 *   1. An explicit boolean in the request body (`thinking_enabled` /
 *      `search_enabled`) — this is the client's live, per-turn intent, e.g.
 *      DeepCode's /reasoning and /searching commands, and must be able to
 *      turn a flag ON as well as OFF regardless of model or env defaults.
 *   2. `reasoning_effort: 'none'` or `thinking.type: 'disabled'` — OpenAI-ish
 *      shorthand for "no thinking", still honored even without an explicit
 *      boolean.
 *   3. DEEPSEEK_THINKING env override, if set.
 *   4. Model-based default: deepseek-reasoner defaults to thinking on,
 *      deepseek-chat defaults to thinking off. search_enabled has no
 *      model-based default — it's off unless the client asks for it.
 *
 * Previously thinking_enabled could only ever be forced to `false` from the
 * request body (never `true`), which meant /reasoning had zero effect on
 * deepseek-chat (whose default is already false). And search_enabled was
 * never read from the body at all — hardcoded to `false` at both call
 * sites — so /searching never had any effect on any model.
 */
export function resolveThinkingAndSearch(body, model) {
  const isChatModel = model.includes('chat') && !model.includes('reasoner');
  const envThinking = process.env.DEEPSEEK_THINKING !== undefined ? process.env.DEEPSEEK_THINKING === 'true' : null;

  let thinkingEnabled = envThinking !== null ? envThinking : !isChatModel;
  if (typeof body.thinking_enabled === 'boolean') {
    thinkingEnabled = body.thinking_enabled;
  } else if (body.reasoning_effort === 'none' || body.thinking?.type === 'disabled') {
    thinkingEnabled = false;
  }

  const searchEnabled = typeof body.search_enabled === 'boolean' ? body.search_enabled : false;

  return { thinkingEnabled, searchEnabled };
}

/**
 * Returns the list of required argument names still missing from a parsed
 * tool call. Prefers the real JSON Schema `required` array declared by the
 * client for that tool name (covers MCP tools too); falls back to
 * NATIVE_TOOL_REQUIRED_ARGS for known local tools with no declared schema.
 */
export function findMissingRequiredArgs(toolCall, toolsSchema = []) {
  let args;
  try {
    args = JSON.parse(toolCall?.function?.arguments || '{}');
  } catch {
    args = {};
  }
  if (!args || typeof args !== 'object') args = {};

  const toolName = toolCall?.function?.name;
  const declared = toolsSchema.find(t => (t?.function?.name || t?.name) === toolName);
  const required = declared?.function?.parameters?.required || NATIVE_TOOL_REQUIRED_ARGS[toolName];

  if (!required || required.length === 0) return [];

  return required.filter(key => {
    const v = args[key];
    return v === undefined || v === null || v === '';
  });
}

/**
 * Parser resilience net (does NOT alter what's sent to the client): logs a
 * console warning + activity event whenever a parsed tool call is missing
 * required arguments — almost always a sign of a malformed/truncated DSML
 * tag the parser couldn't fully recover. Surfaces the pattern in the
 * dashboard instead of failing silently.
 */
function logToolParseWarnings(toolCalls, toolsSchema, externalSessionId, rawText = '') {
  for (const tc of toolCalls) {
    const missing = findMissingRequiredArgs(tc, toolsSchema);
    if (missing.length === 0) continue;

    console.warn(`[Bridge Parser Warning] session=${externalSessionId} tool="${tc.function.name}" está faltando argumentos obrigatórios: ${missing.join(', ')} (possível tag DSML malformada/truncada)`);
    emitActivity({
      sessionId: externalSessionId,
      type: 'tool_parse_warning',
      detail: {
        name: tc.function.name,
        missing,
        argsPreview: typeof tc.function.arguments === 'string' ? tc.function.arguments.slice(0, 160) : ''
      }
    });
    // TEMP DEBUG: dump raw model output whenever a warning fires, for
    // offline root-cause analysis of malformed tool calls.
    if (process.env.DEEPBLACK_DEBUG_RAW_DUMP) {
      try {
        fs.appendFileSync(process.env.DEEPBLACK_DEBUG_RAW_DUMP, `\n===== ${new Date().toISOString()} session=${externalSessionId} tool=${tc.function.name} missing=${missing.join(',')} =====\n${rawText}\n`);
      } catch {}
    }
  }
}

const server = http.createServer(async (req, res) => {
  setCors(res, req);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Health check
  if (url.pathname === '/' || url.pathname === '/health') {
    sendJson(res, 200, {
      status: 'ok',
      service: 'DeepBlack',
      version: '1.0.0',
      description: 'DeepSeek Web Chat to OpenAI/OpenCode Agent Bridge'
    });
    return;
  }

  // GET /v1/models
  if (url.pathname === '/v1/models') {
    sendJson(res, 200, {
      object: 'list',
      data: [
        {
          id: 'deepseek-reasoner',
          object: 'model',
          created: 1789660000,
          owned_by: 'deepseek',
          permission: [],
          root: 'deepseek-reasoner'
        },
        {
          id: 'deepseek-chat',
          object: 'model',
          created: 1789660000,
          owned_by: 'deepseek',
          permission: [],
          root: 'deepseek-chat'
        }
      ]
    });
    return;
  }

  // GET /v1/session
  if (url.pathname === '/v1/session' || url.pathname === '/session') {
    const extId = req.headers['x-session-id'] || url.searchParams.get('id') || 'default';
    const entry = client.getSession(extId);
    sendJson(res, 200, {
      externalSessionId: extId,
      session: entry,
      sessions: client.sessions
    });
    return;
  }

  // POST /v1/session/title
  if (url.pathname === '/v1/session/title' && req.method === 'POST') {
    const body = await parseJsonBody(req);
    const extId = req.headers['x-session-id'] || body.externalSessionId || 'default';
    const entry = client.getSession(extId);
    const title = body.title || 'DeepBlack Agent';
    let ok = false;
    if (entry?.deepseekSessionId) {
      ok = await client.updateTitle(entry.deepseekSessionId, title);
      if (ok) entry.title = title;
    }
    sendJson(res, ok ? 200 : 400, {
      status: ok ? 'ok' : 'error',
      title,
      sessionId: entry?.deepseekSessionId
    });
    return;
  }

  // GET or POST /v1/session/reset
  if (url.pathname === '/v1/session/reset' || url.pathname === '/session/reset') {
    const extId = req.headers['x-session-id'] || url.searchParams.get('id') || null;
    client.resetSession(extId);
    sendJson(res, 200, {
      status: 'ok',
      message: `Active session ${extId || 'all'} reset. Next turn will create a new channel.`
    });
    return;
  }

  // POST /v1/session/new - force-create a fresh DeepSeek session for an externalId
  // Useful when a session is stuck, corrupted, or you want to start fresh without /reset
  if (url.pathname === '/v1/session/new') {
    try {
      const body = req.method === 'POST' ? await parseJsonBody(req) : {};
      const extId = req.headers['x-session-id'] || body.externalSessionId || url.searchParams.get('id') || 'default';
      client.resetSession(extId);
      const newEntry = await client.ensureSession(extId);
      console.log(`[DeepBlack Bridge] Force-created new DeepSeek session for extId="${extId}" -> dsId="${newEntry.deepseekSessionId}"`);
      sendJson(res, 200, {
        status: 'ok',
        message: `New DeepSeek session created for "${extId}"`,
        externalSessionId: extId,
        deepseekSessionId: newEntry.deepseekSessionId
      });
    } catch (err) {
      sendJson(res, 500, { status: 'error', message: err.message });
    }
    return;
  }

  // POST /v1/session/link
  if (url.pathname === '/v1/session/link' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const dsId = body.deepseekSessionId || body.sessionId;
      if (!dsId) {
        sendJson(res, 400, { status: 'error', message: 'Missing deepseekSessionId' });
        return;
      }
      const extId = req.headers['x-session-id'] || body.externalSessionId || 'default';
      const realId = body.lastResponseMessageId !== undefined ? body.lastResponseMessageId : await client.getLatestMessageId(dsId);
      client.sessions[extId] = {
        deepseekSessionId: dsId,
        lastResponseMessageId: realId,
        title: body.title || 'Linked ChatSession',
        needsTitleUpdate: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      client.saveSessions();
      console.log(`[DeepBlack Bridge] Linked externalSessionId "${extId}" -> DeepSeek chat "${dsId}" (parentMsgId=${realId})`);
      sendJson(res, 200, {
        status: 'ok',
        externalSessionId: extId,
        deepseekSessionId: dsId,
        lastResponseMessageId: realId
      });
    } catch (err) {
      sendJson(res, 500, { status: 'error', message: err.message });
    }
    return;
  }

  // POST /v1/auth/reload
  if (url.pathname === '/v1/auth/reload' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      client.updateCredentials({
        token: body.token,
        cookie: body.cookie,
        userAgent: body.userAgent,
        deviceId: body.deviceId
      });
      console.log(`[DeepBlack Bridge] Credentials dynamically reloaded in active client.`);
      sendJson(res, 200, { status: 'ok', message: 'Credentials reloaded' });
    } catch (err) {
      sendJson(res, 500, { error: { message: err.message } });
    }
    return;
  }

  // GET or POST /api/account/sync
  if (url.pathname === '/api/account/sync') {
    if (req.method === 'GET') {
      sendJson(res, 200, {
        status: 'ready',
        endpoint: '/api/account/sync',
        description: 'POST your DeepSeek Bearer token, cookie, and deviceId here to auto-sync with DeepBlack.'
      });
      return;
    }

    if (req.method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const { token, cookie, userAgent, deviceId, name, makeActive = true } = body;

        if (!token) {
          sendJson(res, 400, { status: 'error', message: 'Missing token in sync payload' });
          return;
        }

        const { account, isNew } = upsertAccount({
          token,
          cookie,
          userAgent,
          deviceId,
          name: name || (body.userName ? `DeepSeek (${body.userName})` : undefined),
          setAsActive: makeActive !== false
        });

        if (makeActive !== false) {
          client.updateCredentials({
            token: account.token,
            cookie: account.cookie,
            userAgent: account.userAgent,
            deviceId: account.deviceId
          });
        }

        console.log(`[DeepBlack Bridge] Auto-captured account synced: "${account.name}" (${account.id}) [${isNew ? 'NEW' : 'UPDATED'}]`);

        sendJson(res, 200, {
          status: 'ok',
          message: isNew ? 'Account registered and activated' : 'Account credentials refreshed',
          account: {
            id: account.id,
            name: account.name,
            isNew
          }
        });
      } catch (err) {
        console.error('[DeepBlack Bridge] Sync error:', err);
        sendJson(res, 500, { status: 'error', message: err.message });
      }
      return;
    }
  }

  // POST /v1/chat/completions
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    const requestStartTime = Date.now();
    let activitySessionId = 'default';
    // Hoisted above the try block (not destructured with `const` inside it)
    // so the catch handler below can still reference it when building an
    // error chunk. `const model = ...` inside `try { }` is block-scoped to
    // the try block only — the catch block is a *separate* scope in JS, so
    // referencing `model` there throws `ReferenceError: model is not
    // defined`. That threw inside the catch's own inner try/catch around
    // res.write(), which silently swallowed it, so the "visible error
    // chunk" fix never actually wrote anything — it just called res.end()
    // on an empty stream, exactly the hang it was meant to prevent.
    let model = 'deepseek-reasoner';
    try {
      const body = await parseJsonBody(req);
      const externalSessionId = req.headers['x-session-id'] || req.headers['session-id'] || body.user || 'default';
      activitySessionId = externalSessionId;

      const {
        messages = [],
        tools = [],
        stream = false
      } = body;
      model = body.model || 'deepseek-reasoner';

      // OpenCode fires a stateless "title generator" completion using the
      // SAME x-session-id as the real chat turn, often concurrently with it.
      // Both requests racing to read/create the DeepSeek session under that
      // one key caused two separate remote sessions to be created — whichever
      // finished last silently overwrote the other's tracked deepseekSessionId
      // and parent message id, corrupting continuity for the real
      // conversation. Detected via OpenCode's own fixed prompt prefix;
      // isolated onto a disposable session key so it never touches the real
      // session's state.
      const isTitleGenRequest = typeof messages[0]?.content === 'string' && messages[0].content.startsWith('You are a title generator');
      const dsSessionKey = isTitleGenRequest
        ? `${externalSessionId}__titlegen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        : externalSessionId;

      // Detect if user sent a /reset or /new command in prompt
      const lastMsgText = messages[messages.length - 1]?.content || '';
      if (typeof lastMsgText === 'string' && (lastMsgText.trim() === '/new' || lastMsgText.trim() === '/reset')) {
        client.resetSession(dsSessionKey);
        const freshEntry = await client.ensureSession(dsSessionKey, true);
        console.log(`[DeepBlack Bridge] Reset requested. Created fresh DeepSeek session: ${freshEntry.deepseekSessionId}`);
        if (stream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          });
          const reqId = `chatcmpl-${Date.now()}`;
          const chunk = {
            id: reqId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { content: 'Nova sessão iniciada com sucesso.' }, finish_reason: 'stop' }]
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        } else {
          sendJson(res, 200, {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'Nova sessão iniciada com sucesso.' }, finish_reason: 'stop' }]
          });
          return;
        }
      }

      const { thinkingEnabled, searchEnabled } = resolveThinkingAndSearch(body, model);

      // Truly new session only if client has no entry or no message history yet for this externalSessionId
      const sessionEntry = client.getSession(dsSessionKey);
      const isNew = !sessionEntry || !sessionEntry.deepseekSessionId || sessionEntry.lastResponseMessageId === null;

      // MCP toolset delta detection (Ataque 2): canonical hash (sorted by tool
      // name) so reordering the same tools across turns never false-positives.
      const currentToolsHash = computeToolsHash(tools);
      const toolsChanged = !isNew && currentToolsHash !== null && currentToolsHash !== sessionEntry?.lastToolsHash;

      // Defesa em profundidade contra perda de contexto silenciosa numa
      // sessão longa baseada só em delta (observado ao vivo em 2026-09-21,
      // sem nenhum retry/rotação de sessão envolvido -- ver
      // tests/test_context_reminder.js). A cada N turnos continuando a mesma
      // sessão, reinjeta um lembrete curto (só nomes de ferramentas, não os
      // schemas inteiros) em vez de confiar 100% na memória remota do
      // DeepSeek Web.
      const reminderInterval = parseInt(process.env.DEEPBLACK_REMINDER_INTERVAL || '6', 10);
      let needsReminder = false;
      if (!isNew && sessionEntry) {
        sessionEntry.turnCount = (sessionEntry.turnCount || 0) + 1;
        needsReminder = reminderInterval > 0 && sessionEntry.turnCount % reminderInterval === 0;
      }

      // DeepHat advice auto-injection disabled per operator instruction.
      // DeepHat is accessible on-demand via consult_deephat tool or CLI.
      const deephatAdvice = null;

      // Log last incoming message summary for deep visibility
      if (messages.length > 0) {
        const last = messages[messages.length - 1];
        const lastSnippet = typeof last.content === 'string' ? last.content.replace(/\r?\n/g, ' ').slice(0, 160) : '[structured]';
        console.log(`[Bridge In] role=${last.role} name=${last.name || last.tool_call_id || '-'} | text: ${lastSnippet}...`);
      }

      console.log(`\n[Bridge Req] ${model} | session=${externalSessionId} | thinking=${thinkingEnabled} | searching=${searchEnabled} | isNew=${isNew} | msgs=${messages.length} | tools=${tools.length} | toolsChanged=${toolsChanged} | reminder=${needsReminder}${deephatAdvice ? ' | [DeepHat Intel Injected]' : ''}`);
      emitActivity({ sessionId: externalSessionId, type: 'request_start', model, detail: { messages: messages.length, tools: tools.length, isNew, thinkingEnabled, toolsChanged } });
      const prompt = await formatMessagesToPrompt(messages, tools, isNew, deephatAdvice, toolsChanged, needsReminder);

      if (stream) {
        // SSE Streaming Response
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });

        const reqId = `chatcmpl-${Date.now()}`;
        let contentAccumulator = '';
        let thinkAccumulator = '';
        let streamedChars = 0;
        let emittedToolCalls = false;

        await withCompletionLock(async () => {
        for await (const chunk of client.streamCompletion({
          prompt,
          externalSessionId: dsSessionKey,
          thinkingEnabled,
          searchEnabled,
          messages,
          tools,
          deephatAdvice,
          toolsChanged
        })) {
          if (chunk.type === 'think') {
            thinkAccumulator += chunk.text;
            const sseData = {
              id: reqId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [
                {
                  index: 0,
                  delta: {
                    reasoning_content: chunk.text
                  },
                  finish_reason: null
                }
              ]
            };
            res.write(`data: ${JSON.stringify(sseData)}\n\n`);
            emitActivity({ sessionId: externalSessionId, type: 'thinking', model, detail: { preview: chunk.text.slice(0, 140) } });
          } else if (chunk.type === 'content') {
            contentAccumulator += chunk.text;
            contentAccumulator = normalizeDsmlGlitches(contentAccumulator);

            // Determine how much text can be safely streamed without leaking tool tags.
            // Covers 1- and 2-pipe DSML variants (the model doesn't always emit both
            // pipes), orphan <parameter> tags without a wrapping <invoke>, and the
            // start of a markdown ```json tool-call block — all previously missed,
            // which let raw tool-call syntax stream through as visible chat text.
            const toolCallIdx = contentAccumulator.search(/<tool_call\b|<call_call\b|<call\b|<tool\b|<[\\/]*[|｜]{1,2}DSML|<invoke\b|<parameter\b|```(?:json)?\s*\{\s*"?(?:name|tool)"?\s*:/i);
            let safeToStream = '';

            if (toolCallIdx === -1) {
              // No tool call tag detected so far. Only hold back the trailing
              // '<' if what follows it could plausibly start a tool tag
              // (letter, '/', or a DSML pipe) — otherwise math/comparisons
              // like "x < 10" or "count < 5" stall the stream for no reason.
              const lastLt = contentAccumulator.lastIndexOf('<');
              const afterLt = lastLt !== -1 ? contentAccumulator[lastLt + 1] : undefined;
              const looksLikeTagStart = afterLt === undefined || /[\/a-zA-Z|｜]/.test(afterLt);
              if (lastLt !== -1 && contentAccumulator.length - lastLt < 15 && looksLikeTagStart) {
                safeToStream = contentAccumulator.slice(0, lastLt);
              } else {
                safeToStream = contentAccumulator;
              }
            } else {
              // Tool call tag detected; only stream preceding text
              safeToStream = contentAccumulator.slice(0, toolCallIdx);
            }

            if (safeToStream.length > streamedChars) {
              const deltaText = safeToStream.slice(streamedChars);
              streamedChars = safeToStream.length;
              const sseData = {
                id: reqId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      content: deltaText
                    },
                    finish_reason: null
                  }
                ]
              };
              res.write(`data: ${JSON.stringify(sseData)}\n\n`);
              emitActivity({ sessionId: externalSessionId, type: 'content', model, detail: { preview: deltaText.slice(0, 140) } });
            }
          } else if (chunk.type === 'done') {
            // Check for tool calls in the full accumulated content
            const toolCalls = parseToolCallsFromText(contentAccumulator);
            logToolParseWarnings(toolCalls, tools, externalSessionId, contentAccumulator);

            // Flush whatever the live streaming lookahead held back. This runs
            // REGARDLESS of toolCalls.length — text the model wrote before/around
            // a tool call block (e.g. "Delego uma busca enquanto testo outra via:")
            // must still reach the client even when a tool call follows it.
            // When there are tool calls, clean the remainder (it may still contain
            // tool-tag fragments); otherwise stream it raw.
            if (contentAccumulator.length > streamedChars) {
              const rawRemaining = contentAccumulator.slice(streamedChars);
              const remainingText = toolCalls.length > 0 ? cleanToolBlocks(rawRemaining) : rawRemaining;
              streamedChars = contentAccumulator.length;
              if (remainingText.length > 0) {
                const sseData = {
                  id: reqId,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        content: remainingText
                      },
                      finish_reason: null
                    }
                  ]
                };
                res.write(`data: ${JSON.stringify(sseData)}\n\n`);
              }
            }

            if (toolCalls.length > 0) {
              emittedToolCalls = true;
              const toolsDesc = toolCalls.map(t => {
                const argPreview = typeof t.function.arguments === 'string' ? t.function.arguments.slice(0, 80) : JSON.stringify(t.function.arguments).slice(0, 80);
                return `${t.function.name}(${argPreview}...)`;
              }).join(' | ');
              console.log(`[Bridge Out] session=${externalSessionId} Tools: ${toolsDesc}`);
              for (const tc of toolCalls) {
                const toolChunk = {
                  id: reqId,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [tc]
                      },
                      finish_reason: null
                    }
                  ]
                };
                res.write(`data: ${JSON.stringify(toolChunk)}\n\n`);
                emitActivity({ sessionId: externalSessionId, type: 'tool_call', model, detail: { name: tc.function.name, argsPreview: typeof tc.function.arguments === 'string' ? tc.function.arguments.slice(0, 120) : '' } });
              }
            }

            const finishReason = emittedToolCalls ? 'tool_calls' : 'stop';
            console.log(`[Bridge Done] session=${externalSessionId} finishReason=${finishReason}`);
            const finishChunk = {
              id: reqId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: finishReason
                }
              ]
            };
            res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
            // Usage chunk (OpenAI stream_options.include_usage convention):
            // empty `choices` + top-level `usage`, sent right before [DONE].
            // Without this the client (OpenCode) always sees tokens:0/cost:0,
            // even on fully successful turns, because usage was previously
            // only ever computed in the non-streaming branch below.
            const usageChunk = {
              id: reqId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [],
              usage: estimateUsage(estimateMessagesChars(messages), thinkAccumulator, contentAccumulator)
            };
            res.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            emitActivity({ sessionId: externalSessionId, type: 'request_end', model, detail: { finishReason, durationMs: Date.now() - requestStartTime } });
            if (currentToolsHash) client.updateToolsHash(dsSessionKey, currentToolsHash);
            if (isTitleGenRequest) client.resetSession(dsSessionKey);
            return;
          }
        }
        });
      } else {
        // Non-streaming response
        let fullThinking = '';
        let fullContent = '';

        await withCompletionLock(async () => {
        for await (const chunk of client.streamCompletion({
          prompt,
          externalSessionId: dsSessionKey,
          thinkingEnabled,
          searchEnabled,
          messages,
          tools,
          deephatAdvice,
          toolsChanged
        })) {
          if (chunk.type === 'think') {
            fullThinking += chunk.text;
          } else if (chunk.type === 'content') {
            fullContent += chunk.text;
          }
        }
        });

        const toolCalls = parseToolCallsFromText(fullContent);
        const cleanedText = cleanToolBlocks(fullContent);
        logToolParseWarnings(toolCalls, tools, externalSessionId, fullContent);
        const finishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';

        for (const tc of toolCalls) {
          emitActivity({ sessionId: externalSessionId, type: 'tool_call', model, detail: { name: tc.function.name, argsPreview: typeof tc.function.arguments === 'string' ? tc.function.arguments.slice(0, 120) : '' } });
        }
        emitActivity({ sessionId: externalSessionId, type: 'request_end', model, detail: { finishReason, durationMs: Date.now() - requestStartTime } });
        if (currentToolsHash) client.updateToolsHash(dsSessionKey, currentToolsHash);
        if (isTitleGenRequest) client.resetSession(dsSessionKey);

        sendJson(res, 200, {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: toolCalls.length > 0 ? (cleanedText || null) : fullContent,
                reasoning_content: fullThinking,
                ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
              },
              finish_reason: finishReason
            }
          ],
          usage: estimateUsage(estimateMessagesChars(messages), fullThinking, fullContent)
        });
      }
    } catch (err) {
      console.error('API Error:', err);
      emitActivity({ sessionId: activitySessionId, type: 'request_error', detail: { message: err.message, durationMs: Date.now() - requestStartTime } });
      if (res.headersSent) {
        // SSE headers already went out (stream:true path) — sendJson() below
        // would silently no-op on its own headersSent guard, leaving the
        // connection open forever from the client's point of view (opencode
        // would just hang waiting for a [DONE] that never arrives, with no
        // indication anything went wrong). Surface the error as a final
        // visible chunk and close the stream instead of hanging it.
        try {
          const errorChunk = {
            id: `chatcmpl-error-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                delta: { content: `\n\n> ❌ **[DeepBlack] Erro interno:** ${err.message || 'Internal DeepBlack error'}\n\n` },
                finish_reason: 'stop'
              }
            ]
          };
          res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
          res.write('data: [DONE]\n\n');
        } catch (writeErr) {
          // If writing the error chunk itself fails, at least log it loudly
          // instead of swallowing it silently — that silence is exactly
          // what hid the `model` scoping bug above for hours.
          console.error('[DeepBlack] Failed to write SSE error chunk:', writeErr);
        }
        res.end();
      } else {
        sendJson(res, 500, {
          error: {
            message: err.message || 'Internal DeepBlack error',
            type: 'internal_error'
          }
        });
      }
    }
    return;
  }

  sendJson(res, 404, { error: { message: 'Not found' } });
});

process.on('uncaughtException', (err) => {
  console.error('[DeepBlack Fatal] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[DeepBlack Warning] Unhandled Rejection:', reason);
});

export function startServer() {
  server.listen(PORT, HOST, async () => {
    console.log(`\n======================================================`);
    console.log(` DeepBlack Agent Bridge listening on http://${HOST}:${PORT}`);
    console.log(` OpenAI Base URL: http://${HOST}:${PORT}/v1`);
    console.log(` Models: deepseek-reasoner, deepseek-chat`);
    const deephatOnline = await isDeepHatAlive();
    console.log(` DeepHat 7B Tactical Scout: ${deephatOnline ? 'ONLINE (:11435, RTX 4050 Active)' : 'OFFLINE'}`);
    console.log(`======================================================\n`);
  });
  return server;
}

// Only auto-start the listener when this file is run directly (`node src/server.js`),
// not when it's imported (e.g. by tests that only need parseToolCallsFromText/cleanToolBlocks).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
