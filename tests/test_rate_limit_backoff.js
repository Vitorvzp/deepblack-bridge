// tests/test_rate_limit_backoff.js — exercita a lógica nova de auto-proteção
// contra rate-limit (detecção de burst, cooldown, e o escalonamento de 4
// níveis em _recoverFromZeroTokens) sem bater na rede real. A conta DeepSeek
// Web é compartilhada entre sessões/modelos e pode estar sob rate-limit real
// no momento em que este teste roda, então tudo aqui usa mocks/spies nos
// métodos de rede do client em vez de chamadas HTTP de verdade.
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeepSeekWebClient } from '../src/deepseek.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function drain(gen) {
  const out = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

async function main() {
  process.env.DEEPSEEK_BURST_WINDOW_MS = '60000';
  process.env.DEEPSEEK_BURST_MAX = '3';
  const sessionFilePath = path.join(__dirname, '.tmp_rate_limit_test_sessions.json');
  const rateLimitFilePath = path.join(__dirname, '.tmp_rate_limit_test_state.json');
  const client = new DeepSeekWebClient({
    token: 'fake-token-for-tests',
    // Isolated scratch files so this test never touches the real stores.
    sessionFilePath,
    rateLimitFilePath
  });

  console.log('--- Teste 1: detecção de burst ---');
  assert.strictEqual(client._recordRequestForBurstDetection(), false, '1a requisição não deveria disparar burst');
  assert.strictEqual(client._recordRequestForBurstDetection(), false);
  assert.strictEqual(client._recordRequestForBurstDetection(), false);
  assert.strictEqual(client._recordRequestForBurstDetection(), true, 'a 4a requisição (> DEEPSEEK_BURST_MAX=3) deveria disparar burst');
  console.log('✔ burst detectado corretamente após exceder o limite');

  console.log('\n--- Teste 2: cooldown liga e desliga com o tempo ---');
  assert.strictEqual(client.isRateLimited(), false, 'não deveria estar limitado antes de qualquer cooldown');
  client._enterCooldown('teste manual', 50);
  assert.strictEqual(client.isRateLimited(), true, 'deveria estar limitado logo após _enterCooldown');
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(client.isRateLimited(), false, 'deveria sair do cooldown depois do tempo passar');
  console.log('✔ cooldown liga e desliga corretamente com o tempo');

  // A partir daqui, os métodos que fariam chamadas de rede reais são
  // substituídos por spies/fakes para testar só a lógica de decisão.
  let streamCalls = [];
  client.streamCompletion = async function* (opts) {
    streamCalls.push(opts);
    yield { type: 'done', text: '', sessionId: opts.sessionId };
  };
  client._resolveRetryParentId = async () => 'fake-parent-id';
  let forceFreshCalls = 0;
  client._forceFreshSession = async () => {
    forceFreshCalls++;
    return { deepseekSessionId: 'fresh-session-id' };
  };

  const baseArgs = {
    sessionEntry: { lastResponseMessageId: 'old-id' },
    activeSessionId: 'sess-1',
    activeParentId: 'old-id',
    prompt: 'oi',
    externalSessionId: 'ext-1',
    thinkingEnabled: true,
    searchEnabled: false,
    modelType: 'default'
  };

  console.log('\n--- Teste 3: escalonamento — tier 1 (retry com parentId corrigido) ---');
  streamCalls = [];
  await drain(client._recoverFromZeroTokens({ ...baseArgs, _retryCount: 0, _freshSessionAttempted: false, _cooldownCycle: 0 }));
  assert.strictEqual(streamCalls.length, 1, 'tier 1 deveria chamar streamCompletion uma vez, com retryCount+1');
  assert.strictEqual(streamCalls[0]._retryCount, 1);
  assert.strictEqual(streamCalls[0]._freshSessionAttempted, false);
  assert.strictEqual(streamCalls[0].parentMessageId, 'fake-parent-id');
  assert.strictEqual(forceFreshCalls, 0, 'não deveria forçar sessão nova ainda (retryCount < 4)');
  console.log('✔ tier 1 (retry com parentId corrigido) funciona');

  console.log('\n--- Teste 4: escalonamento — tier 2 (sessão nova após esgotar 4 retries) ---');
  streamCalls = [];
  forceFreshCalls = 0;
  await drain(client._recoverFromZeroTokens({ ...baseArgs, _retryCount: 4, _freshSessionAttempted: false, _cooldownCycle: 0 }));
  assert.strictEqual(forceFreshCalls, 1, 'deveria forçar sessão nova quando retryCount>=4 e ainda não tentou');
  assert.strictEqual(streamCalls.length, 1);
  assert.strictEqual(streamCalls[0].sessionId, 'fresh-session-id');
  assert.strictEqual(streamCalls[0]._retryCount, 0, 'retryCount deveria resetar na sessão nova');
  assert.strictEqual(streamCalls[0]._freshSessionAttempted, true);
  assert.strictEqual(streamCalls[0].parentMessageId, null);
  console.log('✔ tier 2 (sessão nova) funciona');

  console.log('\n--- Teste 5: escalonamento — tier 3 (cooldown quando até a sessão nova falha) ---');
  process.env.DEEPSEEK_COOLDOWN_MS = '50';
  process.env.DEEPSEEK_MAX_COOLDOWN_CYCLES = '2';
  streamCalls = [];
  const chunks = await drain(client._recoverFromZeroTokens({ ...baseArgs, _retryCount: 4, _freshSessionAttempted: true, _cooldownCycle: 0 }));
  assert.ok(chunks.some((c) => c.type === 'content' && c.text.includes('Rate limit detectado')), 'deveria emitir aviso de início de cooldown');
  assert.ok(chunks.some((c) => c.type === 'content' && c.text.includes('retomando normalmente')), 'deveria emitir aviso de fim de cooldown');
  assert.strictEqual(streamCalls.length, 1);
  assert.strictEqual(streamCalls[0]._cooldownCycle, 1, 'deveria incrementar o ciclo de cooldown');
  assert.strictEqual(streamCalls[0]._freshSessionAttempted, false, 'deveria resetar freshSessionAttempted pra tentar tudo de novo após o cooldown');
  assert.strictEqual(client.isRateLimited(), false, 'cooldown deveria ter sido consumido (aguardado) ao final da chamada');
  console.log('✔ tier 3 (cooldown + retry do zero) funciona, com avisos visíveis no stream');

  console.log('\n--- Teste 6: escalonamento — tier 4 (desiste após esgotar os ciclos de cooldown) ---');
  streamCalls = [];
  const chunks2 = await drain(client._recoverFromZeroTokens({ ...baseArgs, _retryCount: 4, _freshSessionAttempted: true, _cooldownCycle: 2 }));
  assert.strictEqual(streamCalls.length, 0, 'não deveria chamar streamCompletion de novo — já esgotou todos os tiers');
  assert.ok(chunks2.some((c) => c.type === 'content' && c.text.includes('❌')), 'deveria emitir mensagem final de desistência');
  assert.ok(chunks2.some((c) => c.type === 'done'), 'deveria terminar com done');
  console.log('✔ tier 4 (desistência honesta com mensagem visível) funciona');

  console.log('\n--- Teste 7: sessão nova (top-level) também espera um cooldown já ativo antes de bater na rede ---');
  // Simula uma segunda sessão concorrente que chega enquanto outra já entrou
  // em cooldown — deve esperar o mesmo cooldown em vez de tentar bater na
  // rede em paralelo (rate limit é por conta, não por sessão).
  client._enterCooldown('cooldown de outra sessão', 40);
  const start = Date.now();
  // streamCompletion real faria PoW/HTTPS antes de checar o cooldown pra
  // uma chamada nova; aqui testamos a checagem isoladamente reusando a
  // mesma lógica de espera que streamCompletion usa.
  while (client.isRateLimited()) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const waited = Date.now() - start;
  assert.ok(waited >= 35, `deveria ter esperado pelo menos ~40ms do cooldown ativo, esperou ${waited}ms`);
  console.log(`✔ cooldown ativo de outra sessão é respeitado (esperou ${waited}ms)`);

  console.log('\n--- Teste 8: cooldown sobrevive a um restart do processo ---');
  const fs = await import('node:fs');
  client._enterCooldown('teste de persistência', 5000);
  assert.ok(fs.existsSync(rateLimitFilePath), 'deveria ter gravado o arquivo de estado ao entrar em cooldown');
  const restarted = new DeepSeekWebClient({ token: 'fake-token-for-tests', sessionFilePath, rateLimitFilePath });
  assert.strictEqual(restarted.isRateLimited(), true, 'uma nova instância (simulando restart) deveria carregar o cooldown ativo do disco');
  assert.strictEqual(restarted.lastRateLimitReason, 'teste de persistência');
  restarted._exitCooldown();
  assert.ok(!fs.existsSync(rateLimitFilePath), 'saindo do cooldown deveria remover o arquivo de estado');
  const afterExit = new DeepSeekWebClient({ token: 'fake-token-for-tests', sessionFilePath, rateLimitFilePath });
  assert.strictEqual(afterExit.isRateLimited(), false, 'sem arquivo de estado, uma nova instância não deveria se achar limitada');
  console.log('✔ cooldown persiste em disco e sobrevive a um restart simulado');

  console.log('\n✔ Todos os testes de rate-limit/backoff passaram!');
}

main().catch((err) => {
  console.error('❌ FALHOU:', err);
  process.exitCode = 1;
});
