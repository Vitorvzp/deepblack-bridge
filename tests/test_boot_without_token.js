// tests/test_boot_without_token.js — TDD para o fluxo de instalacao limpa
// (deepblack.exe compilado, distribuido pra terceiros via
// scripts/deepblack_autocapture.user.js): uma maquina nova nao tem
// .env/.deepblack_accounts.json ainda -- o servidor PRECISA subir mesmo
// assim, pra poder receber o POST em /api/account/sync que registra a
// primeira conta. Antes desse fix, `new DeepSeekWebClient()` lancava
// "DEEPSEEK_AUTH_TOKEN is required." direto no construtor, matando o
// processo inteiro antes mesmo de abrir a porta -- confirmado ao vivo
// rodando dist/deepblack.exe numa pasta limpa (2026-09-21).
import assert from 'node:assert';
import { DeepSeekWebClient } from '../src/deepseek.js';

async function main() {
  // Este repo de dev tem um .env real (DEEPSEEK_AUTH_TOKEN de verdade), que
  // loadEnv() ja injetou em process.env na importacao do modulo -- por isso
  // precisamos limpar explicitamente pra simular de verdade a maquina limpa
  // de um amigo (sem nenhuma credencial em lugar nenhum).
  const savedToken = process.env.DEEPSEEK_AUTH_TOKEN;
  delete process.env.DEEPSEEK_AUTH_TOKEN;

  console.log('--- Teste 1: construir sem token nao lanca mais erro ---');
  let client;
  assert.doesNotThrow(() => {
    client = new DeepSeekWebClient({
      token: undefined,
      sessionFilePath: '/tmp/does-not-exist-sessions.json',
      rateLimitFilePath: '/tmp/does-not-exist-ratelimit.json'
    });
  }, 'construir o client sem token nao deveria mais lancar (precisa poder subir o server numa instalacao limpa)');
  console.log('✔ construtor tolera token ausente');

  console.log('\n--- Teste 2: uma requisicao de verdade sem token falha com mensagem clara ---');
  await assert.rejects(
    () => client._request('https://chat.deepseek.com/api/v0/users/current'),
    (err) => {
      assert.ok(err.message.includes('No DeepSeek account configured'), `mensagem deveria explicar a causa, veio: ${err.message}`);
      return true;
    }
  );
  console.log('✔ _request() falha com mensagem clara em vez do processo inteiro morrer');

  console.log('\n--- Teste 3: depois de updateCredentials, o client usa o token novo ---');
  client.updateCredentials({ token: 'fake-token-for-test' });
  assert.strictEqual(client.token, 'fake-token-for-test');
  console.log('✔ updateCredentials continua registrando o token normalmente (fluxo do /api/account/sync)');

  console.log('\n✔ Todos os testes de boot sem token passaram!');

  if (savedToken !== undefined) process.env.DEEPSEEK_AUTH_TOKEN = savedToken;
}

main().catch((err) => {
  console.error('❌ FALHOU:', err);
  process.exitCode = 1;
});
