async function testContinuity() {
  console.log('--- Testing Bridge Single-Session Continuity ---');

  // Turn 1
  console.log('Sending Turn 1...');
  const res1 = await fetch('http://127.0.0.1:5050/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-reasoner',
      messages: [
        { role: 'user', content: "Guarde o token secreto: SKYNET-777. Responda apenas 'Token recebido'." }
      ]
    })
  });
  const data1 = await res1.json();
  console.log('Turn 1 Output:', data1.choices?.[0]?.message?.content);

  // Check Session Info
  const sessionRes1 = await (await fetch('http://127.0.0.1:5050/v1/session')).json();
  console.log('Session info after Turn 1:', sessionRes1);

  // Turn 2
  console.log('\nSending Turn 2 in a new request (simulating next prompt)...');
  const res2 = await fetch('http://127.0.0.1:5050/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-reasoner',
      messages: [
        { role: 'user', content: "Guarde o token secreto: SKYNET-777. Responda apenas 'Token recebido'." },
        { role: 'assistant', content: data1.choices?.[0]?.message?.content },
        { role: 'user', content: "Qual foi o token secreto que guardei? Apenas o token." }
      ]
    })
  });
  const data2 = await res2.json();
  console.log('Turn 2 Output:', data2.choices?.[0]?.message?.content);

  // Check Session Info
  const sessionRes2 = await (await fetch('http://127.0.0.1:5050/v1/session')).json();
  console.log('Session info after Turn 2:', sessionRes2);

  if (sessionRes1.sessionId === sessionRes2.sessionId) {
    console.log(`\n✔ PERFECT: Both turns used the EXACT SAME SESSION ID: ${sessionRes1.sessionId}`);
  } else {
    console.error(`\n❌ MISMATCH: Turn 1 was ${sessionRes1.sessionId}, Turn 2 was ${sessionRes2.sessionId}`);
  }
}

testContinuity().catch(console.error);
