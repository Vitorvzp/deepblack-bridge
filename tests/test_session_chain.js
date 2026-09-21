import { DeepSeekWebClient } from '../src/deepseek.js';

async function testChain() {
  console.log('--- Testing Multi-turn in Same Session ---');
  const client = new DeepSeekWebClient();

  // 1. Create one session
  const sessionId = await client.createSession();
  console.log(`Created Session: ${sessionId}`);

  // 2. Turn 1
  console.log('\nTurn 1: "Lembre-se do número secreto: 7391"');
  let turn1RespId = null;
  for await (const chunk of client.streamCompletion({
    sessionId,
    parentMessageId: null,
    prompt: "Lembre-se do número secreto: 7391. Apenas confirme que guardou."
  })) {
    if (chunk.responseMessageId) {
      turn1RespId = chunk.responseMessageId;
    }
    if (chunk.type === 'content') {
      process.stdout.write(chunk.text);
    }
  }
  console.log(`\nTurn 1 finished. responseMessageId: ${turn1RespId}`);

  // 3. Turn 2 in the EXACT SAME session
  console.log('\nTurn 2: "Qual é o número secreto que pedi para guardar?"');
  let turn2RespId = null;
  for await (const chunk of client.streamCompletion({
    sessionId,
    parentMessageId: turn1RespId,
    prompt: "Qual é o número secreto que pedi para guardar? Responda apenas o número."
  })) {
    if (chunk.responseMessageId) {
      turn2RespId = chunk.responseMessageId;
    }
    if (chunk.type === 'content') {
      process.stdout.write(chunk.text);
    }
  }
  console.log(`\nTurn 2 finished. responseMessageId: ${turn2RespId}`);

  console.log('\n✔ Same session multi-turn test passed!');
}

testChain().catch(console.error);
