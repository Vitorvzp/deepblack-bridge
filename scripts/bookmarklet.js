/**
 * DeepBlack 1-Click Bookmarklet / Console Script
 * Executa instantaneamente no chat.deepseek.com para capturar credenciais e sincronizar com http://127.0.0.1:5050/api/account/sync
 */
(async function deepBlackSync() {
  try {
    let token = '';
    let deviceId = '4c1dd084-b214-4167-84cf-a98f3b998697';

    // 1. Tenta pegar do localStorage
    try {
      const rawUserToken = localStorage.getItem('userToken');
      if (rawUserToken) {
        const parsed = JSON.parse(rawUserToken);
        if (parsed?.value) token = parsed.value;
      }
    } catch {}

    // 2. Procura chave device
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.toLowerCase().includes('device')) {
          const val = localStorage.getItem(k);
          if (val && val.length > 10) deviceId = val;
        }
      }
    } catch {}

    // 3. Se não achou token no storage, pega via chamada ao users/current
    if (!token) {
      const userRes = await fetch('https://chat.deepseek.com/api/v0/users/current');
      // No browser o cookie vai junto, mas se o token estiver no storage após load:
      const raw = localStorage.getItem('userToken');
      if (raw) token = JSON.parse(raw)?.value || '';
    }

    if (!token) {
      alert('⚠️ Token não encontrado automaticamente no localStorage. Faça login ou envie uma mensagem primeiro.');
      return;
    }

    const payload = {
      token,
      cookie: document.cookie || '',
      userAgent: navigator.userAgent,
      deviceId,
      makeActive: true
    };

    const res = await fetch('http://127.0.0.1:5050/api/account/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (res.ok && data.status === 'ok') {
      alert(`🟢 DeepBlack Sincronizado!\nConta: ${data.account.name} (${data.account.id})\nToken: ${token.slice(0, 8)}...${token.slice(-4)}\nStatus: Ativa no Bridge (:5050)`);
    } else {
      alert(`⚠️ Erro ao sincronizar: ${data.message || 'Falha na ponte'}`);
    }
  } catch (err) {
    alert(`❌ Erro ao conectar na bridge DeepBlack (:5050):\n${err.message}\nVerifique se 'node src/server.js' está rodando.`);
  }
})();
