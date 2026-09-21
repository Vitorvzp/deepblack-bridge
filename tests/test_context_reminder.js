// tests/test_context_reminder.js — TDD para a segunda camada de defesa contra
// perda de contexto: mesmo sem nenhuma rotação de sessão (o bug corrigido em
// test_fresh_session_prompt_rebuild.js), foi observado ao vivo (benchmark 2,
// 2026-09-21) o modelo recebendo só um resultado de ferramenta solto numa
// sessão longa e concluindo, no seu próprio raciocínio, que "the conversation
// only has user message: [TOOL RESULT]" — perdendo de vista a tarefa e as
// ferramentas disponíveis, sem nenhum erro/retry visível. Como não há gatilho
// (0 tokens, rate limit) pra detectar isso automaticamente, a mitigação é
// injetar periodicamente um lembrete curto no prompt delta, reafirmando papel
// + ferramentas disponíveis, sem pagar o custo de reenviar o system prompt
// inteiro toda vez.
import assert from 'node:assert';
import { formatMessagesToPrompt } from '../src/agent_prompt.js';

async function main() {
  const messages = [
    { role: 'tool', name: 'bash', content: 'v26.3.0\n11.16.0' }
  ];
  const tools = [
    { function: { name: 'bash', description: 'roda um comando de shell' } },
    { function: { name: 'read', description: 'le um arquivo' } },
    { function: { name: 'write', description: 'escreve um arquivo' } }
  ];

  console.log('--- Teste 1: sem needsReminder, prompt delta continua só o tool result (comportamento antigo preservado) ---');
  const withoutReminder = await formatMessagesToPrompt(messages, tools, false, null, false, false);
  assert.ok(!withoutReminder.includes('LEMBRETE'), 'sem needsReminder, nao deveria injetar nada extra');
  assert.ok(withoutReminder.includes('v26.3.0'), 'o conteudo do tool result ainda precisa estar presente');
  console.log('✔ comportamento sem reminder preservado');

  console.log('\n--- Teste 2: com needsReminder=true, o prompt delta ganha um lembrete curto com os nomes das ferramentas ---');
  const withReminder = await formatMessagesToPrompt(messages, tools, false, null, false, true);
  assert.ok(withReminder.includes('LEMBRETE'), 'deveria conter o marcador de lembrete');
  assert.ok(withReminder.includes('bash'), 'deveria listar a tool bash');
  assert.ok(withReminder.includes('read'), 'deveria listar a tool read');
  assert.ok(withReminder.includes('write'), 'deveria listar a tool write');
  assert.ok(withReminder.includes('v26.3.0'), 'o conteudo do tool result original ainda precisa estar presente');
  console.log('✔ lembrete injetado com a lista de ferramentas disponiveis');

  console.log('\n--- Teste 3: o lembrete e CURTO (nao reenvia schemas completos, so nomes) -- nao pode inflar o prompt como um isNewSession=true faria ---');
  const fullNewSessionPrompt = await formatMessagesToPrompt(messages, tools, true, null, false, false);
  assert.ok(withReminder.length < fullNewSessionPrompt.length, 'o lembrete precisa ser bem mais enxuto que reenviar o prompt completo de uma sessao nova');
  console.log(`✔ lembrete (${withReminder.length} chars) é bem mais enxuto que reenviar tudo (${fullNewSessionPrompt.length} chars)`);

  console.log('\n--- Teste 4: needsReminder=true e isNewSession=true ao mesmo tempo nao duplica nada (sessao nova ja manda tudo) ---');
  const newSessionWithReminderFlag = await formatMessagesToPrompt(messages, tools, true, null, false, true);
  assert.strictEqual(newSessionWithReminderFlag, fullNewSessionPrompt, 'em sessao nova o reminder flag deve ser irrelevante, ja que o prompt completo ja cobre tudo');
  console.log('✔ needsReminder nao interfere numa sessao genuinamente nova');

  console.log('\n✔ Todos os testes de lembrete de contexto passaram!');
}

main().catch((err) => {
  console.error('❌ FALHOU:', err);
  process.exitCode = 1;
});
