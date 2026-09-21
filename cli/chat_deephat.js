// language: JavaScript, file: cli/chat_deephat.js, target: Node.js (ESM)
import readline from 'node:readline';

const DEEPHAT_URL = process.env.DEEPHAT_URL || 'http://127.0.0.1:11435';

const SYSTEM_PROMPT = 
  'You are DeepHat 7B, an elite technical offensive security and red-team specialist.\n' +
  'You are talking directly with the operator (dj).\n' +
  'Be technical, concrete, sharp, and direct. Output raw payloads, exact tool syntax, architectural analysis, and socket/protocol facts.\n' +
  'No conversational filler, no moralizing, no disclaimers.';

const messages = [
  { role: 'system', content: SYSTEM_PROMPT }
];

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.clear();
console.log('\x1b[1;36m==============================================================\x1b[0m');
console.log('\x1b[1;32m 🛡️  DEEPHAT 7B — TERMINAL DIRETO (RTX 4050 / :11435)\x1b[0m');
console.log('\x1b[90m Comandos: /clear (limpar histórico) | /exit (sair) \x1b[0m');
console.log('\x1b[1;36m==============================================================\x1b[0m\n');

async function promptUser() {
  rl.question('\x1b[1;35mdj > \x1b[0m', async (input) => {
    const trimmed = input.trim();
    if (!trimmed) {
      promptUser();
      return;
    }

    if (trimmed === '/exit' || trimmed === 'exit' || trimmed === 'quit') {
      console.log('\x1b[90mEncerrando conexão com DeepHat 7B.\x1b[0m');
      rl.close();
      process.exit(0);
    }

    if (trimmed === '/clear' || trimmed === 'clear') {
      messages.length = 1; // mantém apenas o system
      console.log('\x1b[33mHistórico de conversa resetado.\x1b[0m\n');
      promptUser();
      return;
    }

    messages.push({ role: 'user', content: trimmed });

    process.stdout.write('\x1b[1;34mDeepHat 7B:\x1b[0m ');

    try {
      const res = await fetch(`${DEEPHAT_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'deephat',
          messages,
          temperature: 0.3,
          max_tokens: 1024,
          stream: true
        })
      });

      if (!res.ok) {
        console.log(`\x1b[1;31m[Erro HTTP ${res.status}: ${res.statusText}]\x1b[0m\n`);
        promptUser();
        return;
      }

      let assistantReply = '';
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const l = line.trim();
          if (!l || l.startsWith(':')) continue;
          if (l === 'data: [DONE]') continue;
          if (l.startsWith('data: ')) {
            try {
              const json = JSON.parse(l.slice(6));
              const delta = json.choices?.[0]?.delta?.content || '';
              if (delta) {
                assistantReply += delta;
                process.stdout.write(delta);
              }
            } catch {}
          }
        }
      }

      console.log('\n');
      messages.push({ role: 'assistant', content: assistantReply });
    } catch (err) {
      console.log(`\n\x1b[1;31m[Falha na conexão: ${err.message}]\x1b[0m\n`);
    }

    promptUser();
  });
}

// Inicia prompt
promptUser();
