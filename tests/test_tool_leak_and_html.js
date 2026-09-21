// tests/test_tool_leak_and_html.js — regressão para o bug de vazamento de
// tool calls no SSE e destruição de HTML legítimo por cleanToolBlocks.
import assert from 'node:assert';
import { cleanToolBlocks, parseToolCallsFromText, inferFilePathFromContent } from '../src/server.js';

console.log('--- Teste 0: <calls> órfão com só parameter name="content" (sem <invoke>, sem filePath) ---');
const orphanSnippet = 'Vou testar o endpoint.\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ parameter name="content" string="true">import requests\nprint("test")\n</｜｜DSML｜｜>\n</｜｜DSML｜｜>\n</｜｜DSML｜｜ calls>';
const orphanTools = parseToolCallsFromText(orphanSnippet);
assert.strictEqual(orphanTools.length, 1, 'deveria recuperar 1 tool call mesmo sem <invoke>/filePath');
assert.strictEqual(orphanTools[0].function.name, 'write');
const orphanArgs = JSON.parse(orphanTools[0].function.arguments);
assert.strictEqual(orphanArgs.filePath, 'temp_script.py', 'deveria inferir temp_script.py pelo conteúdo Python');
assert.ok(orphanArgs.content.includes('import requests'), 'conteúdo do script deve ser preservado');
assert.strictEqual(cleanToolBlocks(orphanSnippet), 'Vou testar o endpoint.', 'texto de introdução deve sobreviver');
console.log('✔ DSML órfão recuperado como write com filePath inferido:', orphanArgs.filePath);

console.log('\n--- Teste 0b: inferFilePathFromContent cobre os casos pedidos ---');
assert.strictEqual(inferFilePathFromContent('import os\nprint(1)'), 'temp_script.py');
assert.strictEqual(inferFilePathFromContent('#!/bin/bash\necho hi'), 'temp_script.sh');
assert.strictEqual(inferFilePathFromContent('curl -s https://x.com'), 'temp_script.sh');
assert.strictEqual(inferFilePathFromContent('# filename: relatorio.md\nConteúdo'), 'relatorio.md');
assert.strictEqual(inferFilePathFromContent('texto qualquer sem pista nenhuma'), 'temp_file.txt');
console.log('✔ Heurísticas de extensão e dica de nome no comentário funcionando');

console.log('\n--- Teste 1: HTML legítimo deve sobreviver a cleanToolBlocks ---');
const html = 'Encontrei isso no HTML: <table><tr><td>Admin</td></tr></table> e <form action="login.aspx"><input name="user"/></form>';
const htmlResult = cleanToolBlocks(html);
assert.ok(htmlResult.includes('<table>') && htmlResult.includes('<tr>') && htmlResult.includes('<td>'), 'tags de tabela devem sobreviver');
assert.ok(htmlResult.includes('<form') && htmlResult.includes('<input'), 'tags de formulário devem sobreviver');
assert.ok(htmlResult.includes('Admin'), 'conteúdo interno deve sobreviver');
console.log('✔ HTML preservado:', htmlResult);

console.log('\n--- Teste 2: tags de tool (DSML e não-DSML) removidas sem resíduo ---');
const mixedInput = `Antes.
<｜DSML｜calls>
<invoke name="bash">
<｜｜DSML｜｜ write>
<parameter name="command">echo hi</parameter>
</｜｜DSML｜｜>
Depois.`;
const mixedResult = cleanToolBlocks(mixedInput);
assert.ok(!/DSML/i.test(mixedResult), 'não deve sobrar "DSML"');
assert.ok(!mixedResult.includes('<invoke'), 'não deve sobrar tag <invoke>');
assert.ok(!mixedResult.includes('<parameter'), 'não deve sobrar tag <parameter>');
assert.ok(mixedResult.includes('Antes.'), 'texto anterior deve sobreviver');
assert.ok(mixedResult.includes('Depois.'), 'texto posterior deve sobreviver');
console.log('✔ Tags de tool limpas, texto ao redor preservado:', JSON.stringify(mixedResult));

console.log('\n--- Teste 3: bloco json markdown de tool call é removido ---');
const mdBlock = 'Vou rodar:\n```json\n{"name": "bash", "arguments": {"command": "ls"}}\n```\nPronto.';
const mdResult = cleanToolBlocks(mdBlock);
assert.ok(!mdResult.includes('"name"'), 'bloco json de tool não deve sobrar');
assert.ok(mdResult.includes('Vou rodar:') && mdResult.includes('Pronto.'), 'texto ao redor deve sobreviver');
console.log('✔ Bloco markdown json removido:', JSON.stringify(mdResult));

console.log('\n--- Teste 4: DSML com 1 pipe é parseado corretamente ---');
const onePipeInvoke = `<|DSML| invoke name="read">
<|DSML| parameter name="filePath" string="true">C:\\temp\\arquivo.txt</parameter>
</|DSML| invoke>`;
const onePipeTools = parseToolCallsFromText(onePipeInvoke);
assert.strictEqual(onePipeTools.length, 1, 'deveria extrair 1 tool call mesmo com 1 pipe');
assert.strictEqual(onePipeTools[0].function.name, 'read');
const onePipeArgs = JSON.parse(onePipeTools[0].function.arguments);
assert.strictEqual(onePipeArgs.filePath, 'C:\\temp\\arquivo.txt');
console.log('✔ DSML de 1 pipe parseado:', JSON.stringify(onePipeTools[0].function));

console.log('\n--- Teste 5: fullwidth de 1 pipe (｜ sozinho) também funciona ---');
const oneFullwidthPipe = `<｜DSML｜ invoke name="bash">
<｜DSML｜ parameter name="command" string="true">echo teste</parameter>
</｜DSML｜ invoke>`;
const fwTools = parseToolCallsFromText(oneFullwidthPipe);
assert.strictEqual(fwTools.length, 1);
assert.strictEqual(fwTools[0].function.name, 'bash');
const fwArgs = JSON.parse(fwTools[0].function.arguments);
assert.strictEqual(fwArgs.command, 'echo teste');
console.log('✔ DSML fullwidth de 1 pipe parseado:', JSON.stringify(fwTools[0].function));

console.log('\n--- Teste 6: texto de introdução antes de um <invoke> não é descartado ---');
// Este é o invariante do qual o flush do handler `done` em server.js depende:
// cleanToolBlocks(texto_completo_incluindo_intro_e_tool) deve preservar a
// introdução, já que é isso que o SSE agora envia como fallback quando há
// tool calls (ver Fix 4 — flush independente de toolCalls.length).
const introPlusTool = `Delego uma busca enquanto testo outra via:

<｜｜DSML｜｜ invoke name="bash">
<｜｜DSML｜｜ parameter name="command" string="true">ssh -i 'vps_key' root@72.61.35.211 'echo test'</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>

Done.`;
const introResult = cleanToolBlocks(introPlusTool);
assert.ok(introResult.includes('Delego uma busca enquanto testo outra via:'), 'texto de introdução não pode ser descartado');
assert.ok(introResult.includes('Done.'), 'texto posterior não pode ser descartado');
assert.ok(!introResult.includes('DSML') && !introResult.includes('<invoke'), 'a tag de tool deve ter sumido');
console.log('✔ Introdução e texto final preservados ao redor da tool call:', JSON.stringify(introResult));

console.log('\n✔ Todos os testes de vazamento de tool/HTML passaram!');
