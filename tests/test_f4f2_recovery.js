import assert from 'node:assert';
import { parseToolCallsFromText, cleanToolBlocks } from '../src/server.js';

// The exact case that failed in session-ses_f4f2.md:
// First parameter had <｜｜DSML｜｜ parameter ...> but closed with </parameter>
// Second parameter had <parameter ...> and closed with </parameter>
const brokenF4F2Payload = `<｜｜DSML｜｜ invoke name="write">
<｜｜DSML｜｜ parameter name="filePath" string="true">C:\\Users\\vitor\\Documents\\BlackDev\\recon\\w3soft3\\12 - Registro de Evidencias e Postura.md</parameter>
<parameter name="content"># Registro de Evidências e Postura de Exposição

> **Alvo:** \`179.127.11.60\`
> **Data:** 2026-09-16
</parameter>
</｜｜DSML｜｜ invoke>`;

const tools1 = parseToolCallsFromText(brokenF4F2Payload);
console.log('Test 1 - Direct DSML hybrid tags:', JSON.stringify(tools1, null, 2));

assert.strictEqual(tools1.length, 1, 'Should extract 1 tool call');
assert.strictEqual(tools1[0].function.name, 'write');
const args1 = JSON.parse(tools1[0].function.arguments);
assert.strictEqual(args1.filePath, 'C:\\Users\\vitor\\Documents\\BlackDev\\recon\\w3soft3\\12 - Registro de Evidencias e Postura.md');
assert.ok(args1.content.includes('# Registro de Evidências'), 'Should extract content parameter');

// Case 2: What if the tool call was wrapped in { "name": "write", "arguments": { "input": "<｜｜DSML｜｜ parameter name=\"filePath\"..." } }
const wrappedInputCase = {
  name: 'write',
  arguments: {
    input: `<｜｜DSML｜｜ parameter name="filePath" string="true">C:\\test\\file.txt</parameter>\n<parameter name="content">hello world</parameter>`
  }
};
const wrappedText = `<tool_call>\n${JSON.stringify(wrappedInputCase)}\n</tool_call>`;
const tools2 = parseToolCallsFromText(wrappedText);
console.log('Test 2 - Wrapped in args.input:', JSON.stringify(tools2, null, 2));

assert.strictEqual(tools2.length, 1);
assert.strictEqual(tools2[0].function.name, 'write');
const args2 = JSON.parse(tools2[0].function.arguments);
assert.strictEqual(args2.filePath, 'C:\\test\\file.txt');
assert.strictEqual(args2.content, 'hello world');
assert.strictEqual(args2.input, undefined, 'args.input should be unpacked and removed');

// Case 3: Verify cleanToolBlocks strips everything cleanly without leaking
const cleaned = cleanToolBlocks(`Some thoughts before the call\n${brokenF4F2Payload}\nFinal remarks.`);
console.log('Test 3 - Cleaned text:', JSON.stringify(cleaned));
assert.ok(!cleaned.includes('DSML'), 'Must not contain DSML');
assert.ok(!cleaned.includes('parameter'), 'Must not contain parameter tags');
assert.ok(!cleaned.includes('invoke'), 'Must not contain invoke tags');
assert.ok(cleaned.includes('Some thoughts before the call'), 'Must keep preceding text');
assert.ok(cleaned.includes('Final remarks.'), 'Must keep succeeding text');

console.log('✔ All tests passed!');
