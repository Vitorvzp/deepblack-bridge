// tests/test_backslash_unescape.js — regressão para o bug de path Windows
// com barra duplicada, achado no teste profundo (fila de tarefas + retry):
// o extrator de fallback do robustParseJson usava o texto capturado cru
// (com "\\" literal de 2 caracteres) sem desescapar, e o "fix" de backslash
// da etapa 2 corrompia pares "\\" que já eram válidos.
import assert from 'node:assert';
import { robustParseJson } from '../src/server.js';

console.log('--- Teste 1: JSON já válido com backslash duplo não é corrompido ---');
const validJson = '{"name":"write","arguments":{"filePath":"C:\\\\Users\\\\vitor\\\\script.py","content":"print(1)"}}';
const parsed1 = robustParseJson(validJson);
assert.strictEqual(parsed1.arguments.filePath, 'C:\\Users\\vitor\\script.py', 'JSON.parse direto deveria já retornar 1 barra por segmento');
console.log('✔ JSON válido preservado:', parsed1.arguments.filePath);

console.log('\n--- Teste 2: fallback regex desescapa corretamente path com backslash duplo ---');
// Simula um blob onde ALGO MAIS no JSON está mangled (forçando o fallback
// regex), mas o campo filePath em si já estava corretamente escapado.
const mangledButFilePathValid = '{"name":"write" "arguments":{"filePath":"C:\\\\Users\\\\vitor\\\\Documents\\\\script.py","content":"print(1)"}}';
const parsed2 = robustParseJson(mangledButFilePathValid);
assert.ok(parsed2, 'deveria recuperar algo via fallback regex');
assert.strictEqual(parsed2.arguments.filePath, 'C:\\Users\\vitor\\Documents\\script.py', 'filePath extraido pelo fallback deveria ter 1 barra por segmento, nao 2');
assert.ok(!parsed2.arguments.filePath.includes('\\\\'), 'nao deveria sobrar barra dupla no filePath');
console.log('✔ Fallback regex desescapou corretamente:', parsed2.arguments.filePath);

console.log('\n--- Teste 3: fallback regex também corrige path cru (1 barra, invalido em JSON) ---');
const rawWindowsPath = '{"name":"read" "arguments":{"filePath":"C:\\Users\\vitor\\arquivo.txt"}}';
const parsed3 = robustParseJson(rawWindowsPath);
assert.ok(parsed3, 'deveria recuperar via fallback regex');
assert.strictEqual(parsed3.arguments.filePath, 'C:\\Users\\vitor\\arquivo.txt');
console.log('✔ Path cru (1 barra) ainda corrigido corretamente:', parsed3.arguments.filePath);

console.log('\n--- Teste 4: content com escapes (\\n, \\") também é desescapado no fallback ---');
const contentCase = '{"name":"write" "arguments":{"filePath":"a.txt","content":"linha1\\nlinha2 com \\"aspas\\""}}';
const parsed4 = robustParseJson(contentCase);
assert.ok(parsed4, 'deveria recuperar via fallback regex');
assert.strictEqual(parsed4.arguments.content, 'linha1\nlinha2 com "aspas"');
console.log('✔ Content desescapado corretamente:', JSON.stringify(parsed4.arguments.content));

console.log('\n✔ Todos os testes de desescape de backslash passaram!');
