// tests/test_mark_account_invalid.js — TDD para o achado de esta madrugada:
// o dashboard mostrava "Conta Capturada 2" como `status: "valid"` por horas
// depois do token já ter expirado de verdade (DeepSeek retornando
// "Authorization Failed (invalid token)"), porque nada nunca atualizava o
// status automaticamente -- só um teste manual via dashboard faria isso.
// Usa um arquivo de contas TEMPORÁRIO e isolado (nunca o real
// .deepblack_accounts.json, que guarda cookies de sessão reais).
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAccounts, saveAccounts, markAccountStatusByToken } from '../cli/accounts.js';
import { DeepSeekWebClient } from '../src/deepseek.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpFile = path.join(__dirname, '.tmp_accounts_test.json');

function seed() {
  const store = {
    activeAccountId: 'acc_a',
    accounts: [
      { id: 'acc_a', name: 'Conta A', token: 'token-a', status: 'valid', lastChecked: '2026-01-01T00:00:00.000Z' },
      { id: 'acc_b', name: 'Conta B', token: 'token-b', status: 'valid', lastChecked: '2026-01-01T00:00:00.000Z' }
    ]
  };
  saveAccounts(store, tmpFile);
}

function cleanup() {
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
}

async function main() {
  cleanup();
  seed();

  console.log('--- Teste 1: marca a conta certa como inválida pelo token ---');
  const ok = markAccountStatusByToken('token-a', 'invalid', tmpFile);
  assert.strictEqual(ok, true, 'deveria confirmar que encontrou e atualizou a conta');
  const afterA = loadAccounts(tmpFile);
  const accA = afterA.accounts.find((a) => a.id === 'acc_a');
  const accB = afterA.accounts.find((a) => a.id === 'acc_b');
  assert.strictEqual(accA.status, 'invalid', 'conta A deveria estar marcada como inválida agora');
  assert.strictEqual(accB.status, 'valid', 'conta B não deveria ser afetada');
  assert.notStrictEqual(accA.lastChecked, '2026-01-01T00:00:00.000Z', 'lastChecked deveria ter sido atualizado para agora');
  console.log('✔ conta certa marcada como inválida, a outra intacta, lastChecked atualizado');

  console.log('\n--- Teste 2: token desconhecido retorna false, não quebra nem cria conta fantasma ---');
  const notFound = markAccountStatusByToken('token-que-nao-existe', 'invalid', tmpFile);
  assert.strictEqual(notFound, false, 'deveria retornar false para token desconhecido');
  const afterUnknown = loadAccounts(tmpFile);
  assert.strictEqual(afterUnknown.accounts.length, 2, 'não deveria ter criado nenhuma conta nova');
  console.log('✔ token desconhecido tratado com segurança, sem efeitos colaterais');

  console.log('\n--- Teste 3: token vazio/undefined é ignorado com segurança ---');
  assert.strictEqual(markAccountStatusByToken('', 'invalid', tmpFile), false);
  assert.strictEqual(markAccountStatusByToken(undefined, 'invalid', tmpFile), false);
  console.log('✔ token vazio/undefined não causa efeito nenhum');

  console.log('\n--- Teste 4: createSession() marca a conta como inválida sozinho, ao receber code 40003 ---');
  seed(); // repovoa o arquivo (o teste 1 já mexeu nele)
  const client = new DeepSeekWebClient({
    token: 'token-a',
    accountsFilePath: tmpFile,
    sessionFilePath: path.join(__dirname, '.tmp_accounts_test_sessions.json')
  });
  // Mock só da chamada de rede real, mantendo a lógica de createSession() de verdade.
  client._request = async () => ({ code: 40003, msg: 'Authorization Failed (invalid token)', data: null });
  let threw = false;
  try {
    await client.createSession();
  } catch (err) {
    threw = true;
    assert.ok(/Failed to create chat session/.test(err.message));
  }
  assert.ok(threw, 'createSession deveria continuar lançando o erro original normalmente');
  const afterCreateSession = loadAccounts(tmpFile);
  const accAAfter = afterCreateSession.accounts.find((a) => a.id === 'acc_a');
  assert.strictEqual(accAAfter.status, 'invalid', 'createSession() deveria ter marcado a conta como inválida sozinho, sem eu chamar markAccountStatusByToken manualmente');
  console.log('✔ createSession() detecta o erro 40003 e marca a conta como inválida automaticamente');
  const tmpSessionsFile = path.join(__dirname, '.tmp_accounts_test_sessions.json');
  if (fs.existsSync(tmpSessionsFile)) fs.unlinkSync(tmpSessionsFile);

  cleanup();
  console.log('\n✔ Todos os testes de marcação de status de conta passaram!');
}

main().catch((err) => {
  cleanup();
  console.error('❌ FALHOU:', err);
  process.exitCode = 1;
});
