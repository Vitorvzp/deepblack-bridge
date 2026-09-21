import { isDeepHatAlive, consultDeepHatDirect, enqueueDeepHatObservation, consumeDeepHatAdvice } from '../src/deephat.js';

async function run() {
  console.log('[*] Testing isDeepHatAlive()...');
  const alive = await isDeepHatAlive();
  console.log('Alive:', alive);

  console.log('\n[*] Testing consultDeepHatDirect()...');
  const advice = await consultDeepHatDirect(
    'Identify the top 2 high-value targets when port 135 (RPC) and port 8080 (PRTG) are open on a Windows Server.',
    'Host: 179.127.11.60'
  );
  console.log('Direct response:\n', advice);

  console.log('\n[*] Testing enqueueDeepHatObservation()...');
  enqueueDeepHatObservation('test_session_123', 'tool', 'HTTP/1.1 200 OK\nServer: PRTG/25.4.114\nSet-Cookie: OCTOPUS1.0=abcdef123456; Path=/; HttpOnly');
  
  console.log('Waiting 15s for background observation to process...');
  await new Promise(r => setTimeout(r, 15000));

  const cached = consumeDeepHatAdvice('test_session_123');
  console.log('Cached advice consumed:\n', cached);
}

run().catch(console.error);
