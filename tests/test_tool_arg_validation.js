// tests/test_tool_arg_validation.js — rede de segurança pós-parse: detecta
// tool calls com argumentos obrigatórios ausentes (sem alterar o que é
// enviado ao cliente, só para logging/observabilidade no dashboard).
import assert from 'node:assert';
import { findMissingRequiredArgs } from '../src/server.js';

function tc(name, args) {
  return { function: { name, arguments: JSON.stringify(args) } };
}

console.log('--- Teste 1: tool nativa com argumento obrigatório ausente ---');
let missing = findMissingRequiredArgs(tc('write', { filePath: 'a.txt' }));
assert.deepStrictEqual(missing, ['content'], 'deveria acusar "content" ausente');
console.log('✔ write sem content detectado:', missing);

console.log('\n--- Teste 2: tool nativa completa não acusa nada ---');
missing = findMissingRequiredArgs(tc('write', { filePath: 'a.txt', content: 'oi' }));
assert.deepStrictEqual(missing, [], 'write completo não deveria acusar nada');
console.log('✔ write completo -> sem avisos');

console.log('\n--- Teste 3: bash sem command ---');
missing = findMissingRequiredArgs(tc('bash', {}));
assert.deepStrictEqual(missing, ['command']);
console.log('✔ bash sem command detectado:', missing);

console.log('\n--- Teste 4: tool desconhecida sem schema declarado -> não acusa nada (evita falso-positivo) ---');
missing = findMissingRequiredArgs(tc('mcp__github__create_pull_request', {}));
assert.deepStrictEqual(missing, [], 'tool sem schema declarado e sem fallback nativo não deveria ser validada');
console.log('✔ tool MCP desconhecida sem schema -> sem avisos (não temos como saber o que é obrigatório)');

console.log('\n--- Teste 5: tool MCP com schema declarado pelo cliente é respeitado ---');
const mcpSchema = [{
  type: 'function',
  function: {
    name: 'mcp__github__create_pull_request',
    parameters: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'body'] }
  }
}];
missing = findMissingRequiredArgs(tc('mcp__github__create_pull_request', { title: 'PR' }), mcpSchema);
assert.deepStrictEqual(missing, ['body'], 'deveria usar o required do schema declarado pelo cliente');
console.log('✔ schema MCP declarado respeitado, "body" ausente detectado:', missing);

console.log('\n--- Teste 6: string vazia conta como ausente ---');
missing = findMissingRequiredArgs(tc('read', { filePath: '' }));
assert.deepStrictEqual(missing, ['filePath'], 'string vazia deveria contar como ausente');
console.log('✔ filePath="" tratado como ausente');

console.log('\n✔ Todos os testes de validação de argumentos passaram!');
