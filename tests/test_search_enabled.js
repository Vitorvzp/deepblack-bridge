import { DeepSeekWebClient } from '../src/deepseek.js';

async function run() {
  const client = new DeepSeekWebClient();
  console.log('[*] Testing DeepSeek with search_enabled: true...');
  
  let searchDetected = false;
  let text = '';
  
  try {
    for await (const chunk of client.streamCompletion({
      prompt: 'Qual a cotação do dólar hoje no Brasil?',
      externalSessionId: 'test-search-enabled',
      thinkingEnabled: false,
      searchEnabled: true,
      modelType: 'default'
    })) {
      if (chunk.type === 'think') {
        process.stdout.write(`[THINK] ${chunk.text}`);
      } else if (chunk.type === 'content') {
        text += chunk.text;
        process.stdout.write(chunk.text);
      }
    }
    console.log('\n\n✔ Completed! Response length:', text.length);
  } catch (err) {
    console.error('Error testing search:', err);
  }
}

run();
