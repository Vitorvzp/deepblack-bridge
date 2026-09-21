// tests/test_edit_oldstring_recovery.js — TDD para o achado do benchmark 2
// (session-ses_f3b0.md, 2026-09-21): a ferramenta `edit` falhou duas vezes com
// `SchemaError(Missing key at ["oldString"])` num bloco de tool_call grande.
// Causa raiz: quando o JSON de um tool_call vem truncado/corrompido pelos
// tokens nativos do DeepSeek (comum em blocos longos, como um `oldString`
// multi-linha de diff), `JSON.parse` falha duas vezes em `robustParseJson` e
// cai no extrator de fallback via regex -- que sabia extrair `filePath`,
// `content` e `command`, mas NUNCA soube extrair `oldString`/`newString`.
// Resultado: a chamada de `edit` chegava ao DeepCode sem `oldString` nenhum,
// e o schema do tool rejeitava a chamada inteira.
import assert from 'node:assert';
import { parseToolCallsFromText, robustParseJson } from '../src/server.js';

async function main() {
  console.log('--- Teste 1: robustParseJson extrai oldString/newString de um edit truncado (sem JSON valido) ---');
  // JSON genuinamente truncado -- sem fechar a string do oldString nem o objeto,
  // simulando o corte que os tokens nativos do DeepSeek causam num bloco longo.
  const truncated = `{"name": "edit", "arguments": {"filePath": "C:\\\\test\\\\REPORT.md", "oldString": "linha 1\\nlinha 2\\nlinha 3 do diff antigo`;
  const parsed = robustParseJson(truncated);
  assert.ok(parsed, 'deveria conseguir recuperar algo do JSON truncado');
  assert.strictEqual(parsed.name, 'edit');
  assert.strictEqual(parsed.arguments.filePath, 'C:\\test\\REPORT.md');
  assert.ok(parsed.arguments.oldString, 'oldString precisa ter sido extraido, mesmo truncado');
  assert.ok(parsed.arguments.oldString.includes('linha 1'), 'conteudo parcial do oldString deveria estar presente');
  console.log('✔ oldString recuperado mesmo com JSON truncado:', JSON.stringify(parsed.arguments.oldString));

  console.log('\n--- Teste 2: recupera oldString E newString quando ambos estao presentes mas o JSON e invalido ---');
  // Aqui o JSON tem um erro de sintaxe no meio (virgula sobrando + quebra de linha
  // crua dentro de uma string) que o reparo em duas etapas do robustParseJson
  // nao consegue consertar sozinho, forcando o fallback regex.
  const brokenButComplete = `{"name": "edit", "arguments": {"filePath": "C:\\\\test\\\\REPORT.md", "oldString": "linha antiga`  + '\n' + `mais uma linha crua sem escape", "newString": "linha nova substituida"}}`;
  const parsed2 = robustParseJson(brokenButComplete);
  assert.ok(parsed2, 'deveria recuperar mesmo com quebra de linha crua dentro da string');
  assert.strictEqual(parsed2.arguments.filePath, 'C:\\test\\REPORT.md');
  assert.ok(parsed2.arguments.oldString, 'oldString deveria estar presente');
  assert.ok(parsed2.arguments.newString, 'newString deveria estar presente');
  assert.strictEqual(parsed2.arguments.newString, 'linha nova substituida');
  console.log('✔ oldString e newString recuperados de JSON com quebra de linha crua');

  console.log('\n--- Teste 3: parseToolCallsFromText produz um tool_call de edit utilizavel a partir do bloco truncado ---');
  const rawBlock = `Vou corrigir o REPORT.md agora.\n<tool_call>\n${truncated}`;
  const toolCalls = parseToolCallsFromText(rawBlock);
  assert.strictEqual(toolCalls.length, 1, 'deveria produzir exatamente 1 tool call');
  assert.strictEqual(toolCalls[0].function.name, 'edit');
  const finalArgs = JSON.parse(toolCalls[0].function.arguments);
  assert.ok(finalArgs.oldString, 'a chamada final de edit precisa ter oldString -- essa e a causa raiz do bug real observado');
  assert.strictEqual(finalArgs.filePath, 'C:\\test\\REPORT.md');
  console.log('✔ parseToolCallsFromText entrega um edit com oldString presente, ponta a ponta');

  console.log('\n--- Teste 4: nao quebra o comportamento existente de write (filePath + content) ---');
  const writeBroken = `{"name": "write", "arguments": {"filePath": "C:\\\\test\\\\novo.md", "content": "conteudo qualquer`;
  const parsedWrite = robustParseJson(writeBroken);
  assert.ok(parsedWrite);
  assert.strictEqual(parsedWrite.name, 'write');
  assert.strictEqual(parsedWrite.arguments.filePath, 'C:\\test\\novo.md');
  assert.ok(parsedWrite.arguments.content.includes('conteudo qualquer'));
  console.log('✔ comportamento existente de write preservado');

  console.log('\n✔ Todos os testes de recuperacao de oldString/newString passaram!');
}

main().catch((err) => {
  console.error('❌ FALHOU:', err);
  process.exitCode = 1;
});
