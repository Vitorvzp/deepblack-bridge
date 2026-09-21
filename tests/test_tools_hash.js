// tests/test_tools_hash.js — Ataque 2/3: hash canônico de tools + token diet
import assert from 'node:assert';
import { computeToolsHash, minifyToolsForPrompt, formatMessagesToPrompt } from '../src/agent_prompt.js';

const toolRead = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Reads a file from disk',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  }
};

const toolWrite = {
  type: 'function',
  function: {
    name: 'write_file',
    description: 'Writes a file to disk',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } }
  }
};

const toolMcpGithub = {
  type: 'function',
  function: {
    name: 'mcp__github__create_pull_request',
    description: 'Creates a pull request on GitHub. '.repeat(10), // > 160 chars on purpose
    parameters: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      title: 'CreatePullRequestParams',
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string', examples: ['example body text'] }
      },
      additionalProperties: false
    }
  }
};

console.log('--- Teste 1: reordenação não gera falso-positivo de hash ---');
const hashOrderA = computeToolsHash([toolRead, toolWrite, toolMcpGithub]);
const hashOrderB = computeToolsHash([toolMcpGithub, toolRead, toolWrite]);
const hashOrderC = computeToolsHash([toolWrite, toolMcpGithub, toolRead]);
assert.strictEqual(hashOrderA, hashOrderB, 'Reordenar tools não deveria mudar o hash');
assert.strictEqual(hashOrderA, hashOrderC, 'Reordenar tools não deveria mudar o hash');
console.log(`✔ Hash estável entre reordenações: ${hashOrderA}`);

console.log('\n--- Teste 2: nova tool dispara hash diferente ---');
const hashBefore = computeToolsHash([toolRead, toolWrite]);
const hashAfter = computeToolsHash([toolRead, toolWrite, toolMcpGithub]);
assert.notStrictEqual(hashBefore, hashAfter, 'Adicionar uma tool nova deveria mudar o hash');
console.log(`✔ Hash muda ao adicionar tool: ${hashBefore} -> ${hashAfter}`);

console.log('\n--- Teste 3: tools vazias/undefined retornam null ---');
assert.strictEqual(computeToolsHash([]), null);
assert.strictEqual(computeToolsHash(undefined), null);
console.log('✔ Hash de conjunto vazio é null (nunca dispara "changed")');

console.log('\n--- Teste 4: minificação remove ruído e trunca description ---');
const minified = minifyToolsForPrompt([toolMcpGithub]);
assert.ok(!minified.includes('$schema'), 'não deveria conter $schema');
assert.ok(!minified.includes('"title"'), 'não deveria conter title');
assert.ok(!minified.includes('examples'), 'não deveria conter examples');
assert.ok(!minified.includes('additionalProperties'), 'não deveria conter additionalProperties');
assert.ok(!minified.includes('\n'), 'serialização deveria ser sem whitespace/indentação');
const parsedMinified = JSON.parse(minified);
assert.ok(parsedMinified[0].function.description.length <= 160, 'description deveria estar truncada para ~160 chars');
console.log(`✔ Schema minificado (${minified.length} chars), description truncada para ${parsedMinified[0].function.description.length} chars`);

console.log('\n--- Teste 5: reinjeção de [SYSTEM UPDATE: TOOLSET MODIFIED] em continuação ---');
const continuationMessages = [
  { role: 'user', content: 'primeira pergunta' },
  { role: 'assistant', content: 'primeira resposta' },
  { role: 'user', content: 'segunda pergunta' }
];

const promptChanged = await formatMessagesToPrompt(continuationMessages, [toolRead, toolWrite], false, null, true);
assert.ok(promptChanged.includes('[SYSTEM UPDATE: TOOLSET MODIFIED]'), 'deveria reinjetar aviso de toolset modificado');
assert.ok(promptChanged.includes('<TOOL_USE>'), 'deveria incluir bloco <TOOL_USE>');
assert.ok(promptChanged.includes('read_file') && promptChanged.includes('write_file'), 'deveria incluir as tools atualizadas');
console.log('✔ toolsChanged=true reinjeta o bloco de toolset modificado com as tools atuais');

const promptUnchanged = await formatMessagesToPrompt(continuationMessages, [toolRead, toolWrite], false, null, false);
assert.ok(!promptUnchanged.includes('[SYSTEM UPDATE: TOOLSET MODIFIED]'), 'não deveria reinjetar quando toolsChanged=false');
console.log('✔ toolsChanged=false não reinjeta nada (economiza tokens no caso estável)');

console.log('\n✔ Todos os testes de hash/token-diet passaram!');
