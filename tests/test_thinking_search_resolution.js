// tests/test_thinking_search_resolution.js — TDD para o bug encontrado ao
// testar /reasoning e /searching de ponta a ponta: (1) search_enabled do
// corpo da requisição era completamente ignorado (hardcoded como `false`
// duas vezes em server.js); (2) thinking_enabled só conseguia ser forçado
// para `false`, nunca para `true`, então /reasoning nunca tinha efeito
// algum no modelo deepseek-chat (onde o default já é `false`).
import assert from 'node:assert';
import { resolveThinkingAndSearch } from '../src/server.js';

console.log('--- Teste 1: defaults por modelo (sem override nenhum) ---');
delete process.env.DEEPSEEK_THINKING;
assert.strictEqual(resolveThinkingAndSearch({}, 'deepseek-reasoner').thinkingEnabled, true, 'reasoner deveria ter thinking=true por padrão');
assert.strictEqual(resolveThinkingAndSearch({}, 'deepseek-chat').thinkingEnabled, false, 'chat deveria ter thinking=false por padrão');
assert.strictEqual(resolveThinkingAndSearch({}, 'deepseek-reasoner').searchEnabled, false, 'search deveria ser false por padrão em qualquer modelo');
console.log('✔ defaults corretos por modelo');

console.log('\n--- Teste 2: body.thinking_enabled=true LIGA reasoning mesmo no deepseek-chat (bug original) ---');
const chatWithThinkingOn = resolveThinkingAndSearch({ thinking_enabled: true }, 'deepseek-chat');
assert.strictEqual(chatWithThinkingOn.thinkingEnabled, true, 'thinking_enabled:true no body deveria LIGAR reasoning mesmo no chat — este era o bug: só conseguia desligar, nunca ligar');
console.log('✔ thinking_enabled:true agora liga reasoning no deepseek-chat (antes era impossível)');

console.log('\n--- Teste 3: body.thinking_enabled=false DESLIGA reasoning mesmo no deepseek-reasoner ---');
const reasonerWithThinkingOff = resolveThinkingAndSearch({ thinking_enabled: false }, 'deepseek-reasoner');
assert.strictEqual(reasonerWithThinkingOff.thinkingEnabled, false, 'thinking_enabled:false deveria desligar reasoning mesmo no reasoner');
console.log('✔ thinking_enabled:false continua desligando reasoning no reasoner');

console.log('\n--- Teste 4: body.search_enabled é respeitado (bug original: era sempre hardcoded false) ---');
assert.strictEqual(resolveThinkingAndSearch({ search_enabled: true }, 'deepseek-chat').searchEnabled, true, 'search_enabled:true no body deveria LIGAR search — este era o bug: nunca chegava a ser lido');
assert.strictEqual(resolveThinkingAndSearch({ search_enabled: false }, 'deepseek-chat').searchEnabled, false, 'search_enabled:false deveria manter search desligado');
assert.strictEqual(resolveThinkingAndSearch({}, 'deepseek-chat').searchEnabled, false, 'sem search_enabled no body, deveria continuar false');
console.log('✔ search_enabled do body agora é lido e respeitado de verdade');

console.log('\n--- Teste 5: reasoning_effort="none" ainda desliga thinking (comportamento antigo preservado) ---');
assert.strictEqual(resolveThinkingAndSearch({ reasoning_effort: 'none' }, 'deepseek-reasoner').thinkingEnabled, false);
console.log('✔ reasoning_effort:none continua desligando thinking');

console.log('\n--- Teste 6: valor explícito no body tem prioridade sobre DEEPSEEK_THINKING (env) ---');
process.env.DEEPSEEK_THINKING = 'false';
assert.strictEqual(resolveThinkingAndSearch({ thinking_enabled: true }, 'deepseek-chat').thinkingEnabled, true, 'body explícito deveria vencer o env override');
delete process.env.DEEPSEEK_THINKING;
console.log('✔ prioridade correta: body explícito > env > default por modelo');

console.log('\n--- Teste 7: DEEPSEEK_THINKING=true ainda funciona como override de env quando o body não diz nada ---');
process.env.DEEPSEEK_THINKING = 'true';
assert.strictEqual(resolveThinkingAndSearch({}, 'deepseek-chat').thinkingEnabled, true, 'env override deveria ligar thinking mesmo no chat, se o body não especificar nada');
delete process.env.DEEPSEEK_THINKING;
console.log('✔ env override continua funcionando quando o body não especifica nada');

console.log('\n✔ Todos os testes de resolução thinking/search passaram!');
