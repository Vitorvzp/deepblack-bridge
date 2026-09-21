import { DeepSeekWebClient } from '../src/deepseek.js';

async function testStream() {
  console.log('--- Testing Live DeepSeek Web Stream ---');
  const client = new DeepSeekWebClient();

  console.log('1. Creating session or requesting completion...');
  const prompt = "Responda apenas a palavra 'PONG_OK' e nada mais.";

  let thinkTokens = 0;
  let contentTokens = 0;
  let fullThinking = '';
  let fullContent = '';

  const t0 = performance.now();

  for await (const chunk of client.streamCompletion({
    prompt,
    thinkingEnabled: true,
    searchEnabled: false
  })) {
    if (chunk.type === 'think') {
      thinkTokens++;
      fullThinking += chunk.text;
      process.stdout.write(`\x1b[33m${chunk.text}\x1b[0m`);
    } else if (chunk.type === 'content') {
      contentTokens++;
      fullContent += chunk.text;
      process.stdout.write(`\x1b[32m${chunk.text}\x1b[0m`);
    } else if (chunk.type === 'done') {
      console.log('\n--- Stream Finished ---');
      console.log(`Session ID: ${chunk.sessionId}`);
    }
  }

  const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
  console.log(`\nCompleted in ${elapsed}s`);
  console.log(`Thinking length: ${fullThinking.length} chars (${thinkTokens} chunks)`);
  console.log(`Content: "${fullContent.trim()}" (${contentTokens} chunks)`);

  if (fullContent.includes('PONG_OK') || fullContent.length > 0) {
    console.log('✔ Live DeepSeek streaming test PASSED!');
  } else {
    throw new Error('Unexpected empty response');
  }
}

testStream().catch((err) => {
  console.error('\n✘ Live streaming test failed:', err);
  process.exit(1);
});
