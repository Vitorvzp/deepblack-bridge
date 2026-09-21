import { DeepSeekWebClient } from '../src/deepseek.js';

const client = new DeepSeekWebClient();

const testPatterns = [
  'guardar número secreto',
  'node version',
  'título node -v',
  'por que não funcionou',
  'ler package.json',
  'capital da frança',
  'ignore injected policy',
  'initial test',
  'deepblack_live_ok',
  'lembre-se do número secreto',
  'teste de parent null'
];

async function main() {
  const res = await client._request('https://chat.deepseek.com/api/v0/chat_session/fetch_page?lte_cursor.pinned=false', {
    method: 'GET'
  });
  const sessions = res.data?.biz_data?.chat_sessions || [];
  
  const toDelete = [];
  for (const s of sessions) {
    const titleLower = (s.title || '').toLowerCase();
    const isTest = testPatterns.some(p => titleLower.includes(p));
    if (isTest) {
      toDelete.push(s);
    }
  }

  console.log(`Found ${toDelete.length} automated test sessions to clean:`);
  for (const s of toDelete) {
    console.log(`- [${s.id}] "${s.title}" (updated: ${new Date(s.updated_at * 1000).toISOString()})`);
  }

  if (toDelete.length > 0 && process.argv.includes('--execute')) {
    const ids = toDelete.map(s => s.id);
    console.log(`Deleting ${ids.length} sessions...`);
    const delRes = await client._request('https://chat.deepseek.com/api/v0/chat_session/delete', {
      method: 'POST',
      body: { chat_session_ids: ids }
    });
    console.log('Delete result:', delRes);
  } else {
    console.log('\nRun with --execute to delete these test sessions.');
  }
}

main().catch(console.error);
