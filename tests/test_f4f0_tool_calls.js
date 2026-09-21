import assert from 'node:assert';
import { parseToolCallsFromText, cleanToolBlocks } from '../src/server.js';

// The exact snippet from session-ses_f4f0.md lines 2463-2470
const f4f0Snippet = `<tool_call>
{"name": "task", "arguments": {"description": "Formato handshake Veeam", "subagent_type": "general", "prompt": "research"}}
</call_call>
<call_call>
{"name": "bash", "arguments": {"command": "ssh -i 'vps_key' root@72.61.35.211 'echo test'", "timeout": 60000}}
</call_call>
</call_call>`;

console.log('[*] Testing parseToolCallsFromText on f4f0 snippet...');
const tools = parseToolCallsFromText(f4f0Snippet);
console.log('Parsed tools count:', tools.length);
console.log(JSON.stringify(tools, null, 2));

assert.strictEqual(tools.length, 2, 'Should capture BOTH task and bash tools despite <call_call> malformed tags');
assert.strictEqual(tools[0].function.name, 'task');
assert.strictEqual(tools[1].function.name, 'bash');

// Test cleaning text
const textWithThoughts = `Delego uma busca enquanto testo outra via:\n${f4f0Snippet}\nDone.`;
const cleaned = cleanToolBlocks(textWithThoughts);
console.log('\nCleaned text:\n' + JSON.stringify(cleaned));

assert.ok(!cleaned.includes('call_call'), 'Must not leak <call_call>');
assert.ok(!cleaned.includes('tool_call'), 'Must not leak <tool_call>');
assert.ok(!cleaned.includes('ssh -i'), 'Must not leak command text in visible chat');
assert.ok(cleaned.includes('Delego uma busca'), 'Keeps preceding text');
assert.ok(cleaned.includes('Done.'), 'Keeps trailing text');

console.log('\n✔ All f4f0 tool call regression tests passed!');
