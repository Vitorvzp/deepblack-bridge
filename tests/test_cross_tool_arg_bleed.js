// tests/test_cross_tool_arg_bleed.js — TDD para o bug ao vivo (2026-09-21):
// o modelo emitiu um <invoke name="bash"> cujo bloco de parametros, por
// causa de tags DSML malformadas/duplicadas, acabou carregando TAMBEM
// filePath/oldString/newString/replaceAll -- o vocabulario da tool "edit".
// parseToolCallsFromText() nao validava se os argumentos capturados faziam
// sentido para a tool realmente nomeada, entao tudo ia junto. Do lado do
// DeepCode isso fez uma chamada bash malformada ser reinterpretada como um
// edit e sobrescrever comparacao.md com o texto do comando de shell.
import assert from 'node:assert';
import { parseToolCallsFromText, coerceParamValue } from '../src/server.js';

function callsByName(text) {
  return parseToolCallsFromText(text).map((tc) => ({
    name: tc.function.name,
    args: JSON.parse(tc.function.arguments),
  }));
}

async function main() {
  console.log('--- Teste 1: bash com parametros de edit vazando fica só com command/workdir ---');
  const text = [
    '<｜｜DSML｜｜ invoke name="bash">',
    '<｜｜DSML｜｜ parameter name="command">python inspect_scca.py</｜｜DSML｜｜ parameter>',
    '<｜｜DSML｜｜ parameter name="workdir">C:\\Pt.2</｜｜DSML｜｜ parameter>',
    '<｜｜DSML｜｜ parameter name="filePath">C:\\Pt.2\\comparacao.md</｜｜DSML｜｜ parameter>',
    '<｜｜DSML｜｜ parameter name="oldString">python inspect_scca.py</｜｜DSML｜｜ parameter>',
    '<｜｜DSML｜｜ parameter name="newString">python inspect_scca.py</｜｜DSML｜｜ parameter>',
    '<｜｜DSML｜｜ parameter name="replaceAll">true</｜｜DSML｜｜ parameter>',
    '</｜｜DSML｜｜ invoke>',
  ].join('\n');

  const calls = callsByName(text);
  assert.strictEqual(calls.length, 1, 'deveria produzir só a chamada bash');
  assert.strictEqual(calls[0].name, 'bash');
  assert.strictEqual(calls[0].args.command, 'python inspect_scca.py');
  assert.strictEqual(calls[0].args.filePath, undefined, 'filePath (de edit) nao pode vazar pra bash');
  assert.strictEqual(calls[0].args.oldString, undefined, 'oldString (de edit) nao pode vazar pra bash');
  assert.strictEqual(calls[0].args.newString, undefined, 'newString (de edit) nao pode vazar pra bash');
  assert.strictEqual(calls[0].args.replaceAll, undefined, 'replaceAll (de edit) nao pode vazar pra bash');
  console.log('✔ args estranhos a bash foram descartados, command/workdir preservados');

  console.log('\n--- Teste 2: uma chamada edit legitima continua com todos os seus proprios campos ---');
  const editText = [
    '<｜｜DSML｜｜ invoke name="edit">',
    '<｜｜DSML｜｜ parameter name="filePath">a.txt</｜｜DSML｜｜ parameter>',
    '<｜｜DSML｜｜ parameter name="oldString">foo</｜｜DSML｜｜ parameter>',
    '<｜｜DSML｜｜ parameter name="newString">bar</｜｜DSML｜｜ parameter>',
    '<｜｜DSML｜｜ parameter name="replaceAll">true</｜｜DSML｜｜ parameter>',
    '</｜｜DSML｜｜ invoke>',
  ].join('\n');
  const editCalls = callsByName(editText);
  assert.strictEqual(editCalls[0].name, 'edit');
  assert.strictEqual(editCalls[0].args.filePath, 'a.txt');
  assert.strictEqual(editCalls[0].args.oldString, 'foo');
  assert.strictEqual(editCalls[0].args.newString, 'bar');
  assert.strictEqual(editCalls[0].args.replaceAll, true);
  console.log('✔ chamada edit legitima preservada por completo');

  console.log('\n--- Teste 3: tool desconhecida (MCP/custom) passa sem filtro (sem schema local pra validar) ---');
  const customText = [
    '<｜｜DSML｜｜ invoke name="minha_tool_mcp">',
    '<｜｜DSML｜｜ parameter name="campo_qualquer">valor</｜｜DSML｜｜ parameter>',
    '<｜｜DSML｜｜ parameter name="outro_campo">42</｜｜DSML｜｜ parameter>',
    '</｜｜DSML｜｜ invoke>',
  ].join('\n');
  const customCalls = callsByName(customText);
  assert.strictEqual(customCalls[0].name, 'minha_tool_mcp');
  assert.strictEqual(customCalls[0].args.campo_qualquer, 'valor');
  assert.strictEqual(customCalls[0].args.outro_campo, 42);
  console.log('✔ tools desconhecidas nao sao filtradas (evita quebrar MCP/custom tools)');

  console.log('\n--- Teste 4: coerceParamValue recupera "true"/"false" mesmo com lixo colado depois ---');
  // Caso real observado ao vivo: SchemaError(Expected boolean | undefined, got "true")
  // porque o valor capturado nao era exatamente "true" -- vinha com lixo de
  // tag colado logo apos (fronteira de <parameter> corrompida pelo modelo).
  assert.strictEqual(coerceParamValue('true'), true);
  assert.strictEqual(coerceParamValue('false'), false);
  assert.strictEqual(coerceParamValue('true\n</｜｜DSML｜｜ parameter name="content">lixo'), true);
  assert.strictEqual(coerceParamValue('TRUE'), true, 'case-insensitive');
  assert.strictEqual(coerceParamValue('42'), 42);
  assert.strictEqual(coerceParamValue('"um texto normal"'), 'um texto normal');
  assert.strictEqual(coerceParamValue('um texto sem aspas'), 'um texto sem aspas', 'texto livre continua string, sem falso-positivo');
  console.log('✔ coerceParamValue robusto a lixo colado apos o valor primitivo');

  console.log('\n✔ Todos os testes de vazamento de argumentos entre tools passaram!');
}

main().catch((err) => {
  console.error('❌ FALHOU:', err);
  process.exitCode = 1;
});
