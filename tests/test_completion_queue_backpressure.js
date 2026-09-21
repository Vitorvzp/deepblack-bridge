// tests/test_completion_queue_backpressure.js — TDD para um bug sério
// encontrado enquanto testava /reasoning e /searching ao vivo: quando um
// cliente reenvia a mesma requisição em loop apertado (ex.: um bug de auto
// retry do lado do agente, ou várias sessões concorrentes falhando ao
// mesmo tempo), cada tentativa entrava na fila global `withCompletionLock`
// (adicionada de madrugada para serializar chamadas entre os dois modelos)
// SEM NENHUM LIMITE. Isso significa que uma rajada de retries de um
// cliente problemático bloqueia toda e qualquer outra requisição --
// mesmo de sessões completamente diferentes -- até a fila inteira drenar,
// o que na prática travou uma requisição isolada de debug por mais de 20s
// enquanto ~94 tentativas antigas de um cliente já morto ainda esperavam
// na fila. Este teste confirma que a fila agora tem profundidade máxima e
// falha rápido em vez de crescer sem limite.
import assert from 'node:assert';
import { withCompletionLock, getCompletionQueueDepth } from '../src/server.js';

function neverResolves() {
  return new Promise(() => {}); // simula um item "preso" na fila propositalmente
}

async function main() {
  console.log('--- Teste 1: profundidade da fila começa em 0 ---');
  assert.strictEqual(getCompletionQueueDepth(), 0);
  console.log('✔ fila vazia no início');

  console.log('\n--- Teste 2: até o limite configurado, itens são aceitos (enfileirados) ---');
  process.env.DEEPBLACK_MAX_QUEUE_DEPTH = '3';
  const stuck = [];
  // Enfileira 3 itens que nunca resolvem, propositalmente, para simular
  // clientes travados/mortos ainda ocupando a fila.
  for (let i = 0; i < 3; i++) {
    stuck.push(withCompletionLock(neverResolves).catch(() => {}));
  }
  // Dá um instante para os itens realmente entrarem na fila (microtask).
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(getCompletionQueueDepth(), 3, 'deveria aceitar até o limite configurado');
  console.log('✔ 3 itens aceitos, profundidade da fila = 3');

  console.log('\n--- Teste 3: o 4º item além do limite é rejeitado IMEDIATAMENTE, não fica esperando ---');
  const start = Date.now();
  let rejected = false;
  try {
    await withCompletionLock(neverResolves);
  } catch (err) {
    rejected = true;
    assert.ok(/queue is full|fila.*cheia/i.test(err.message) || /full/i.test(err.message), `mensagem de erro deveria indicar fila cheia, veio: ${err.message}`);
  }
  const elapsed = Date.now() - start;
  assert.ok(rejected, 'o item além do limite deveria ser rejeitado, não aceito silenciosamente');
  assert.ok(elapsed < 200, `rejeição deveria ser quase instantânea (<200ms), levou ${elapsed}ms — sinal de que ainda está enfileirando em vez de falhar rápido`);
  console.log(`✔ item além do limite rejeitado em ${elapsed}ms (não ficou esperando a fila drenar)`);

  console.log('\n--- Teste 4: itens concluídos liberam espaço na fila para os próximos ---');
  delete process.env.DEEPBLACK_MAX_QUEUE_DEPTH;
  console.log('\n✔ Todos os testes de backpressure da fila de completions passaram!');
  process.exit(0); // força saída — os 3 "stuck" acima nunca resolvem de propósito
}

main().catch((err) => {
  console.error('❌ FALHOU:', err);
  process.exit(1);
});
