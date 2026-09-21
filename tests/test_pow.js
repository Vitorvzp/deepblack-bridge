import assert from 'node:assert';
import { solveChallenge } from '../src/pow.js';

async function runTest() {
  console.log('--- Testing PoW Solver (WASM) ---');
  
  // Known sample from captured GhostWire traffic:
  const sampleChallenge = {
    algorithm: 'DeepSeekHashV1',
    challenge: '8946323e65f33b8bc7696755c969607636d1788bfc5f3fdef5bdedf25a74964e',
    salt: 'd2ba4720fcb13443acd3',
    difficulty: 144000,
    expire_at: 1789662004752,
    signature: '5ff77c63dfe22006c36f550488577c867a1d9ce45ccc85d41487c17970d83b38',
    target_path: '/api/v0/chat/completion'
  };

  const t0 = performance.now();
  const b64 = await solveChallenge(sampleChallenge);
  const elapsed = (performance.now() - t0).toFixed(2);
  
  console.log(`Solved in ${elapsed}ms`);
  console.log('Base64 header output:', b64);

  const decoded = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  console.log('Decoded solution:', decoded);

  assert.strictEqual(decoded.algorithm, 'DeepSeekHashV1');
  assert.strictEqual(decoded.answer, 34016);
  assert.strictEqual(decoded.target_path, '/api/v0/chat/completion');

  console.log('✔ PoW Solver test passed successfully!');
}

runTest().catch((err) => {
  console.error('✘ PoW Solver test failed:', err);
  process.exit(1);
});
