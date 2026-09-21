// tests/test_balanced_json_trailing_garbage.js — TDD para o bug ao vivo
// (2026-09-21, "todowrite" preso em SchemaError(Missing key at ["todos"])
// repetido): o modelo emitiu um bloco <tool_call>{...JSON valido...}</call_call>
// mas com lixo de DSML sobrando DEPOIS do JSON valido (uma tag
// <|DSML| parameter> duplicada, um </invoke> perdido). robustParseJson()
// tentava JSON.parse() na string inteira (JSON + lixo) e falhava, caindo no
// fallback por regex campo-a-campo que so conhece filePath/content/command/
// oldString/newString -- nunca "todos" (nem qualquer array arbitrario) --
// entao o argumento sumia e o schema rejeitava a chamada, travando o agente
// num loop de retry identico.
import assert from 'node:assert';
import { robustParseJson, extractBalancedJson } from '../src/server.js';

async function main() {
  console.log('--- Teste 1: extractBalancedJson ignora lixo apos o objeto balanceado ---');
  const withGarbage = '{"name": "todowrite", "arguments": {"todos": [{"content": "a", "status": "pending", "priority": "high"}]}}</｜｜DSML｜｜ parameter>\n</invoke>\n</call_call>';
  const balanced = extractBalancedJson(withGarbage);
  assert.ok(balanced, 'deveria extrair algo');
  const parsed = JSON.parse(balanced);
  assert.strictEqual(parsed.name, 'todowrite');
  assert.strictEqual(parsed.arguments.todos.length, 1);
  console.log('✔ extractBalancedJson corta exatamente no fechamento do objeto');

  console.log('\n--- Teste 2: robustParseJson recupera o caso real do bug (todowrite com todos array) ---');
  const raw = '{"name": "todowrite", "arguments": {"todos": [' +
    '{"content": "Descobrir offsets SCCA v31", "status": "in_progress", "priority": "high"},' +
    '{"content": "Parser de file metrics", "status": "pending", "priority": "high"}' +
    ']}}</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ parameter name="todos">[...]</｜｜DSML｜｜ parameter>\n</invoke>\n</call_call>';
  const result = robustParseJson(raw);
  assert.ok(result, 'robustParseJson nao deveria retornar null');
  assert.strictEqual(result.name, 'todowrite');
  assert.ok(Array.isArray(result.arguments.todos), 'arguments.todos precisa ser um array');
  assert.strictEqual(result.arguments.todos.length, 2, 'os 2 todos precisam estar presentes');
  assert.strictEqual(result.arguments.todos[0].content, 'Descobrir offsets SCCA v31');
  console.log('✔ robustParseJson recupera "todos" mesmo com lixo de DSML apos o JSON');

  console.log('\n--- Teste 3: JSON genuinamente truncado (sem fechamento) ainda cai no fallback por campo, nao quebra ---');
  const truncated = '{"name": "write", "arguments": {"filePath": "a.txt", "content": "linha 1\\nlinha 2 sem fim';
  const resultTrunc = robustParseJson(truncated);
  assert.ok(resultTrunc, 'deveria recuperar algo do fallback por campo');
  assert.strictEqual(resultTrunc.name, 'write');
  console.log('✔ truncamento genuino ainda usa o fallback por campo existente (sem regressao)');

  console.log('\n--- Teste 4: JSON limpo sem nenhum lixo continua funcionando normalmente (fast path) ---');
  const clean = '{"name": "bash", "arguments": {"command": "ls"}}';
  const resultClean = robustParseJson(clean);
  assert.strictEqual(resultClean.name, 'bash');
  assert.strictEqual(resultClean.arguments.command, 'ls');
  console.log('✔ JSON limpo nao regride (ainda usa o parse direto)');

  console.log('\n✔ Todos os testes de extracao de JSON balanceado passaram!');
}

main().catch((err) => {
  console.error('❌ FALHOU:', err);
  process.exitCode = 1;
});
