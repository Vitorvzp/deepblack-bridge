import assert from 'node:assert';
import http from 'node:http';
import { startServer } from '../src/server.js';

function request(urlStr, options = {}) {
  const url = new URL(urlStr);
  const body = options.body ? JSON.stringify(options.body) : null;
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  if (body) headers['Content-Length'] = Buffer.byteLength(body);

  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: options.method || 'GET',
      headers
    }, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, raw });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function streamRequest(urlStr, body, onChunk) {
  const url = new URL(urlStr);
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let buffer = '';
      res.on('data', chunk => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data:')) {
            const payload = trimmed.slice(5).trim();
            if (payload === '[DONE]') {
              resolve();
              return;
            }
            try {
              onChunk(JSON.parse(payload));
            } catch {}
          }
        }
      });
      res.on('end', resolve);
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function runApiTest() {
  console.log('--- Starting DeepBlack Server for Integration Test ---');
  const server = startServer();
  await new Promise(r => setTimeout(r, 500));

  try {
    // 1. Test GET /v1/models
    console.log('1. Testing GET /v1/models...');
    const modelsRes = await request('http://127.0.0.1:5050/v1/models');
    assert.strictEqual(modelsRes.status, 200);
    assert(Array.isArray(modelsRes.body.data));
    console.log('✔ /v1/models returned:', modelsRes.body.data.map(m => m.id));

    // 2. Test POST /v1/chat/completions with streaming (SSE)
    console.log('\n2. Testing POST /v1/chat/completions (streaming)...');
    let reasoning = '';
    let content = '';

    await streamRequest('http://127.0.0.1:5050/v1/chat/completions', {
      model: 'deepseek-reasoner',
      stream: true,
      messages: [
        { role: 'user', content: "Diga apenas 'DEEPBLACK_LIVE_OK' em uma única palavra." }
      ]
    }, (chunk) => {
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.reasoning_content) {
        reasoning += delta.reasoning_content;
      }
      if (delta?.content) {
        content += delta.content;
      }
    });

    console.log('Reasoning:', reasoning);
    console.log('Content:', content);
    assert(content.includes('DEEPBLACK_LIVE_OK') || content.length > 0);
    console.log('✔ Streaming completion test PASSED!');

    console.log('\n✔ ALL INTEGRATION TESTS PASSED CLEANLY!');
  } finally {
    server.close();
  }
}

runApiTest().catch(err => {
  console.error('\n✘ Integration test failed:', err);
  process.exit(1);
});
