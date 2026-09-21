import { DeepSeekWebClient } from '../src/deepseek.js';

async function run() {
  const c = new DeepSeekWebClient();
  const res = await c._request('https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=277ecc3b-822e-494d-8537-882baa47084c');
  const msgs = res.data?.biz_data?.chat_messages || [];
  
  const targetMsgs = msgs.filter(x => x.role === 'ASSISTANT' && x.message_id >= 500);
  console.log('Total assistant messages >= 500:', targetMsgs.length);

  for (const msg of targetMsgs) {
    const text = (msg.fragments || []).map(f => f.content).join('\n');
    
    // Check 1: DSML calls directly having parameter without invoke
    const callsWithoutInvoke = /<[|｜]{1,2}DSML[|｜]{1,2}\s*calls>\s*<[|｜]{1,2}DSML[|｜]{1,2}\s*parameter/i.test(text);
    // Check 2: invoke name is parameter name (filePath, command, etc.)
    const invokeAsParam = /invoke\s+name=["'](filePath|path|command|cmd)["']/i.test(text);
    // Check 3: invoke has plain <parameter>
    const invokePlainParam = /<invoke\s+name=["'][^"']+["']>\s*<parameter\s+/i.test(text);
    // Check 4: message is empty
    const isEmpty = text.trim().length === 0;
    // Check 5: text has tool-like words but no tool block
    const mentionsWrite = (text.includes('vou usar o write') || text.includes('crio o script com `write`') || text.includes('vou usar um script')) && !text.includes('<｜｜DSML');

    if (callsWithoutInvoke || invokeAsParam || invokePlainParam || isEmpty || mentionsWrite) {
      console.log(`*** FOUND ANOMALY IN MSG ${msg.message_id} ***`);
      console.log(`callsWithoutInvoke=${callsWithoutInvoke} invokeAsParam=${invokeAsParam} invokePlainParam=${invokePlainParam} isEmpty=${isEmpty} mentionsWrite=${mentionsWrite}`);
      console.log(text.slice(0, 500));
      console.log('==============================================\n');
    }
  }
}

run().catch(console.error);
