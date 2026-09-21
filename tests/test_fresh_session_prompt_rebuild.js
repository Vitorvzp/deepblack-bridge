// tests/test_fresh_session_prompt_rebuild.js — TDD para o achado da "amnesia":
// quando uma sessao remota do DeepSeek Web e considerada emperrada (0 tokens
// apos esgotar as tentativas de retry), o codigo forca uma sessao remota nova
// (tier 2, _forceFreshSession) ou reinicia do zero apos um cooldown (tier 3).
// Em ambos os casos o parentMessageId vira null -- ou seja, a sessao remota
// nova NAO TEM NENHUMA MEMORIA (nem system prompt, nem definicao de
// ferramentas, nem historico). Antes deste fix, o codigo reaproveitava o
// `prompt` ja formatado pelo turno original, que (quando a sessao NAO era
// nova do ponto de vista do OpenCode) e so o "delta" das ultimas mensagens --
// sem system prompt, sem "AVAILABLE TOOLS", sem nada. O modelo entao recebe
// um trecho de conversa fora de contexto e genuinamente nao sabe que tem
// ferramentas disponiveis. Isso explica o padrao de "amnesia de capacidade"
// observado no benchmark: nao e o modelo esquecendo, e a sessao nova nunca
// tendo recebido a informacao.
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeepSeekWebClient } from '../src/deepseek.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const client = new DeepSeekWebClient({
    token: 'fake-token',
    sessionFilePath: path.join(__dirname, '.tmp_fresh_session_test_sessions.json')
  });

  // Simula o estado de uma sessao ja em andamento (varios turnos anteriores).
  const externalSessionId = 'test-session';
  client.sessions[externalSessionId] = {
    deepseekSessionId: 'remote-old-session',
    lastResponseMessageId: 'msg-42',
    lastToolsHash: null
  };

  const messages = [
    { role: 'system', content: 'irrelevant, o system prompt de verdade vem do agent_prompt.js' },
    { role: 'user', content: 'liste os arquivos da pasta atual' },
    { role: 'assistant', content: 'vou rodar o bash', tool_calls: [{ function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
    { role: 'tool', name: 'bash', content: 'arquivo1.txt\narquivo2.txt' }
  ];
  const tools = [
    { function: { name: 'bash', description: 'roda um comando de shell', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }
  ];

  // Simula o prompt "delta" que o server.js teria construido para um turno
  // NAO-novo (isNewSession=false) -- exatamente o que o codigo antigo reusava
  // cegamente ao forcar uma sessao nova.
  const staleDeltaPrompt = '[TOOL RESULT: bash]\narquivo1.txt\narquivo2.txt\n\n';

  console.log('--- Teste 1: tier 2 (_forceFreshSession) reconstroi o prompt com system prompt + ferramentas ---');
  client._forceFreshSession = async () => ({ deepseekSessionId: 'remote-fresh-session', lastResponseMessageId: null });

  const capturedCalls = [];
  client.streamCompletion = function (args) {
    capturedCalls.push(args);
    return (async function* () {
      yield { type: 'done', text: '', sessionId: args.sessionId };
    })();
  };

  const sessionEntry = client.sessions[externalSessionId];
  const gen1 = client._recoverFromZeroTokens({
    sessionEntry,
    activeSessionId: 'remote-old-session',
    activeParentId: 'msg-42',
    prompt: staleDeltaPrompt,
    externalSessionId,
    thinkingEnabled: true,
    searchEnabled: false,
    modelType: 'default',
    _retryCount: 4,              // ja esgotou as 4 tentativas do tier 1
    _freshSessionAttempted: false,
    _cooldownCycle: 0,
    messages,
    tools,
    deephatAdvice: null,
    toolsChanged: false
  });
  for await (const _ of gen1) { /* drain */ }

  assert.strictEqual(capturedCalls.length, 1, 'deveria ter chamado streamCompletion exatamente uma vez (tier 2)');
  const rebuiltPrompt = capturedCalls[0].prompt;
  assert.notStrictEqual(rebuiltPrompt, staleDeltaPrompt, 'o prompt da sessao nova NAO pode ser o delta antigo reaproveitado');
  assert.ok(rebuiltPrompt.includes('AVAILABLE TOOLS'), 'a sessao nova precisa receber o bloco de ferramentas, senao o modelo genuinamente nao sabe que tem ferramentas');
  assert.ok(rebuiltPrompt.includes('bash'), 'a definicao da tool "bash" precisa estar presente no prompt reconstruido');
  assert.strictEqual(capturedCalls[0].parentMessageId, null, 'sessao nova deveria comecar sem parentMessageId (comportamento original preservado)');
  console.log('✔ tier 2 reconstroi o prompt com system prompt + ferramentas em vez de reusar o delta stale');

  console.log('\n--- Teste 2: tier 1 (retry simples, mesma sessao) NAO deve reconstruir o prompt ---');
  capturedCalls.length = 0;
  const gen2 = client._recoverFromZeroTokens({
    sessionEntry,
    activeSessionId: 'remote-old-session',
    activeParentId: 'msg-42',
    prompt: staleDeltaPrompt,
    externalSessionId,
    thinkingEnabled: true,
    searchEnabled: false,
    modelType: 'default',
    _retryCount: 0,              // ainda dentro do tier 1
    _freshSessionAttempted: false,
    _cooldownCycle: 0,
    messages,
    tools,
    deephatAdvice: null,
    toolsChanged: false
  });
  for await (const _ of gen2) { /* drain */ }
  assert.strictEqual(capturedCalls.length, 1);
  assert.strictEqual(capturedCalls[0].prompt, staleDeltaPrompt, 'tier 1 continua na mesma sessao remota (so corrige parentMessageId) -- o prompt delta original continua correto aqui, nao deveria mudar');
  console.log('✔ tier 1 preserva o prompt original (sessao remota continua a mesma, nao ha perda de memoria)');

  console.log('\n--- Teste 3: sem messages/tools (chamador antigo), cai de volta pro comportamento anterior sem quebrar ---');
  capturedCalls.length = 0;
  const gen3 = client._recoverFromZeroTokens({
    sessionEntry,
    activeSessionId: 'remote-old-session',
    activeParentId: 'msg-42',
    prompt: staleDeltaPrompt,
    externalSessionId,
    thinkingEnabled: true,
    searchEnabled: false,
    modelType: 'default',
    _retryCount: 4,
    _freshSessionAttempted: false,
    _cooldownCycle: 0
    // messages/tools omitidos de proposito
  });
  for await (const _ of gen3) { /* drain */ }
  assert.strictEqual(capturedCalls.length, 1);
  assert.strictEqual(capturedCalls[0].prompt, staleDeltaPrompt, 'sem messages disponiveis, deve cair pro comportamento anterior (reusar o prompt) em vez de quebrar');
  console.log('✔ chamada sem messages/tools nao quebra e preserva o comportamento anterior');

  console.log('\n✔ Todos os testes de reconstrucao de prompt em sessao nova passaram!');
}

main().catch((err) => {
  console.error('❌ FALHOU:', err);
  process.exitCode = 1;
});
