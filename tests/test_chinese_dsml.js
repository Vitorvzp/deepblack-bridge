// tests/test_chinese_dsml.js — regressão para o glitch de tokenizer onde o
// DeepSeek emite o ideograma 该 (U+8BE5) no lugar do pipe DSML (｜, U+FF5C),
// ex.: "<｜该DSML｜｜ calls>" em vez de "<｜｜DSML｜｜ calls>".
import assert from 'node:assert';
import { parseToolCallsFromText, cleanToolBlocks, normalizeDsmlGlitches } from '../src/server.js';

console.log('--- Teste 1: normalizeDsmlGlitches restaura a forma canônica ---');
assert.strictEqual(normalizeDsmlGlitches('<｜该DSML｜｜ calls>'), '<｜｜DSML｜｜ calls>');
assert.strictEqual(normalizeDsmlGlitches('</｜｜DSML该｜ invoke>'), '</｜｜DSML｜｜ invoke>');
assert.strictEqual(normalizeDsmlGlitches('<｜該DSML｜｜ calls>'), '<｜｜DSML｜｜ calls>', '該 (tradicional, U+8A72) também deve normalizar');
assert.strictEqual(normalizeDsmlGlitches('texto sem nada de DSML'), 'texto sem nada de DSML', 'não deve alterar texto sem glitch');
assert.strictEqual(normalizeDsmlGlitches('该 aparece longe de DSML, não deve mexer'), '该 aparece longe de DSML, não deve mexer', '该 fora de contexto DSML não deve ser tocado');
console.log('✔ Normalização restaura o pipe canônico só quando adjacente a "DSML" (simplificado e tradicional)');

console.log('\n--- Teste 2: payload real do incidente (calls glitchado + fechamento comentado #</...>) ---');
const input = `<｜该DSML｜｜ calls>
<｜该DSML｜｜ parameter name="command">wsl -d kali-linux -- bash -lc "cp /mnt/c/Users/vitor/AppData/Local/Temp/opencode/remover.py /tmp/w3/remover.py; cd /tmp/w3 && timeout 100 python3 remover.py" #</｜｜DSML｜｜>
</｜｜DSML｜｜ calls>`;

const tools = parseToolCallsFromText(input);
assert.strictEqual(tools.length, 1, 'Deve extrair 1 tool call mesmo com o glitch 该');
assert.strictEqual(tools[0].function.name, 'bash');
const args = JSON.parse(tools[0].function.arguments);
assert.ok(!args.command.includes('#</'), 'Comando não deve conter o fechamento inline #</ residual');
assert.ok(!args.command.includes('该'), 'Comando não deve conter o caractere de glitch');
console.log('✔ Tool call extraída, sem resíduo de #</ nem do caractere de glitch:', JSON.stringify(args.command).slice(0, 80) + '...');

const cleaned = cleanToolBlocks(input);
assert.strictEqual(cleaned.trim(), '', 'Texto limpo deve estar vazio (bloco inteiro era a tool call)');
console.log('✔ cleanToolBlocks remove o bloco inteiro sem deixar resíduo');

console.log('\n--- Teste 3: glitch com 1 pipe (variante combinada com o bug de pipe único) ---');
const onePipeGlitch = `<该DSML｜ invoke name="read">
<该DSML｜ parameter name="filePath" string="true">C:\\temp\\arquivo.txt</parameter>
</该DSML｜ invoke>`;
const onePipeTools = parseToolCallsFromText(onePipeGlitch);
assert.strictEqual(onePipeTools.length, 1, 'Deve extrair mesmo com glitch + pipe único combinados');
assert.strictEqual(onePipeTools[0].function.name, 'read');
console.log('✔ Glitch combinado com 1 pipe também recuperado');

console.log('\n--- Teste 4: payload real com 該 (tradicional, U+8A72) — segundo incidente ---');
const input2 = `<｜該DSML｜｜ calls>
<｜該DSML｜｜ parameter name="command">wsl -d kali-linux bash -lc "printf 'hash1\\nhash2\\n' > /tmp/w3/hashes.txt; hashcat -m 0 -a 0 /tmp/w3/hashes.txt /usr/share/wordlists/rockyou.txt --force -q 2>&1 | tail -12" #</｜｜DSML｜｜>
</｜｜DSML｜｜ calls>`;
const tools2 = parseToolCallsFromText(input2);
assert.strictEqual(tools2.length, 1, 'Deve extrair 1 tool call com o glitch 該 tradicional');
assert.strictEqual(tools2[0].function.name, 'bash');
const args2 = JSON.parse(tools2[0].function.arguments);
assert.ok(!args2.command.includes('#</'), 'Comando não deve conter o fechamento inline #</ residual');
assert.ok(!args2.command.includes('該'), 'Comando não deve conter o caractere de glitch tradicional');
assert.strictEqual(cleanToolBlocks(input2).trim(), '', 'Texto limpo deve estar vazio');
console.log('✔ Segundo incidente (該 tradicional) também recuperado corretamente');

console.log('\n✔ Todos os testes de glitch de token DSML passaram!');
