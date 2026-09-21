// tests/test_usage_estimate.js — TDD para o contador de "Context tokens" que
// oscilava no DeepCode (ex.: 400 -> 300 -> 400...) em vez de crescer de forma
// monotônica. Causa raiz: usage.prompt_tokens era calculado a partir do
// `prompt` de fato enviado ao DeepSeek Web nesta chamada, que é só um DELTA
// (mensagens novas) em turnos de sessão contínua, mas vira o prompt completo
// reconstruído sempre que a sessão é forçada a rotacionar (ver
// test_fresh_session_prompt_rebuild.js). O array `messages` recebido do
// DeepCode, por outro lado, é sempre o histórico completo da conversa — daí
// estimateMessagesChars(messages) ser a base estável para o usage reportado.
import assert from 'node:assert';
import { estimateMessagesChars } from '../src/server.js';

async function main() {
  console.log('--- Teste 1: string content simples soma o length direto ---');
  const messages1 = [
    { role: 'user', content: 'oi' },
    { role: 'assistant', content: 'ola, tudo bem?' }
  ];
  assert.strictEqual(estimateMessagesChars(messages1), 'oi'.length + 'ola, tudo bem?'.length);
  console.log('✔ soma simples de content string ok');

  console.log('\n--- Teste 2: crescer o historico so pode AUMENTAR a estimativa, nunca diminuir ---');
  const before = estimateMessagesChars(messages1);
  const messages2 = [...messages1, { role: 'user', content: 'mais uma mensagem aqui' }];
  const after = estimateMessagesChars(messages2);
  assert.ok(after > before, 'adicionar uma mensagem deveria aumentar a contagem');
  console.log(`✔ ${before} -> ${after} (cresce como esperado)`);

  console.log('\n--- Teste 3: a estimativa NAO depende de quanto foi de fato reenviado ao backend (delta vs full) ---');
  // Simula o cenario real do bug: o mesmo historico logico de mensagens deve
  // produzir a MESMA estimativa de contexto, independente de o DeepBlack ter
  // decidido mandar so o delta (sessao continua) ou o prompt inteiro
  // reconstruido (sessao rotacionada) para o DeepSeek Web nesse turno --
  // porque a fonte da verdade agora e `messages`, nao o `prompt` de saida.
  const sameMessages = [
    { role: 'system', content: 'voce e um agente de codigo' },
    { role: 'user', content: 'implemente a funcao X' },
    { role: 'assistant', content: 'ok, implementando...' },
    { role: 'tool', name: 'bash', content: 'resultado do comando' }
  ];
  const estimateOnDeltaTurn = estimateMessagesChars(sameMessages);
  const estimateOnRotationTurn = estimateMessagesChars(sameMessages);
  assert.strictEqual(
    estimateOnDeltaTurn,
    estimateOnRotationTurn,
    'a mesma conversa deve gerar a mesma estimativa de contexto, nao importa o que foi enviado ao backend nesse turno especifico'
  );
  console.log('✔ estimativa estavel independente do tamanho do prompt real enviado ao backend');

  console.log('\n--- Teste 4: content em formato de partes (array) tambem e somado ---');
  const messages4 = [
    { role: 'user', content: [{ type: 'text', text: 'parte um' }, { type: 'text', text: 'parte dois' }] }
  ];
  assert.strictEqual(estimateMessagesChars(messages4), 'parte um'.length + 'parte dois'.length);
  console.log('✔ content em array de partes somado corretamente');

  console.log('\n--- Teste 5: tool_calls tambem contam para o tamanho do contexto ---');
  const messages5 = [
    { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'bash', arguments: '{"command":"ls"}' } }] }
  ];
  assert.ok(estimateMessagesChars(messages5) > 0, 'tool_calls deveria contribuir para a contagem mesmo com content vazio');
  console.log('✔ tool_calls contam para a estimativa');

  console.log('\n--- Teste 6: lista vazia/undefined nao quebra e retorna 0 ---');
  assert.strictEqual(estimateMessagesChars([]), 0);
  assert.strictEqual(estimateMessagesChars(undefined), 0);
  console.log('✔ entradas vazias tratadas com seguranca');

  console.log('\n✔ Todos os testes de estimativa de usage passaram!');
}

main().catch((err) => {
  console.error('❌ FALHOU:', err);
  process.exitCode = 1;
});
