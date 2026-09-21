// ==UserScript==
// @name         DeepBlack Auto-Capture Bridge Sync
// @namespace    http://deepblack.local/
// @version      1.0.0
// @description  Captura automaticamente Bearer token, cookies e device-id ao logar no DeepSeek e sincroniza com a bridge DeepBlack (:5050).
// @author       ANON / DeepBlack
// @match        https://chat.deepseek.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_notification
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-start
// ==/UserScript==

(function() {
  'use strict';

  const BRIDGE_URL = 'http://127.0.0.1:5050/api/account/sync';
  let capturedToken = '';
  let capturedDeviceId = '';
  let capturedUser = null;
  let lastSyncedHash = '';
  let syncTimeout = null;

  console.log('[DeepBlack AutoCapture] Inicializado no chat.deepseek.com');

  // --- 1. HUD Visual (Widget Flutuante Discreto) ---
  function injectHud() {
    if (document.getElementById('deepblack-hud')) return;

    const hud = document.createElement('div');
    hud.id = 'deepblack-hud';
    hud.style.cssText = `
      position: fixed;
      bottom: 16px;
      right: 16px;
      z-index: 999999;
      background: #0d1117;
      color: #c9d1d9;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 8px 12px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
      user-select: none;
      transition: all 0.2s ease;
    `;

    hud.innerHTML = `
      <span id="deepblack-status-dot" style="width: 8px; height: 8px; border-radius: 50%; background: #e3b341; display: inline-block;"></span>
      <span id="deepblack-status-text" style="font-weight: 500;">DeepBlack: Aguardando...</span>
      <button id="deepblack-sync-btn" style="
        background: #238636;
        color: #ffffff;
        border: none;
        border-radius: 4px;
        padding: 2px 8px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
      ">Sync</button>
    `;

    document.body.appendChild(hud);

    document.getElementById('deepblack-sync-btn').addEventListener('click', () => {
      triggerSync(true);
    });
  }

  function updateHud(status, message) {
    const dot = document.getElementById('deepblack-status-dot');
    const text = document.getElementById('deepblack-status-text');
    if (!dot || !text) return;

    if (status === 'synced') {
      dot.style.background = '#2ea043';
      text.textContent = message || 'DeepBlack: Sincronizado';
      text.style.color = '#3fb950';
    } else if (status === 'syncing') {
      dot.style.background = '#e3b341';
      text.textContent = 'DeepBlack: Sincronizando...';
      text.style.color = '#d29922';
    } else if (status === 'error') {
      dot.style.background = '#f85149';
      text.textContent = message || 'DeepBlack: Erro ao conectar :5050';
      text.style.color = '#f85149';
    }
  }

  if (document.body) {
    injectHud();
  } else {
    window.addEventListener('DOMContentLoaded', injectHud);
  }

  // --- 2. Extração de Storage Local ---
  function checkLocalStorage() {
    try {
      const rawUserToken = localStorage.getItem('userToken');
      if (rawUserToken) {
        const parsed = JSON.parse(rawUserToken);
        if (parsed && parsed.value) {
          capturedToken = parsed.value;
        }
      }
    } catch {}

    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.toLowerCase().includes('device')) {
          const v = localStorage.getItem(key);
          if (v && v.length > 10) capturedDeviceId = v;
        }
      }
    } catch {}
  }

  // --- 3. Interceptação de Fetch ---
  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const [resource, config] = args;
    const url = typeof resource === 'string' ? resource : resource?.url || '';

    // Inspeciona headers enviados
    if (config && config.headers) {
      let auth = '';
      let devId = '';

      if (config.headers instanceof Headers) {
        auth = config.headers.get('authorization') || config.headers.get('Authorization') || '';
        devId = config.headers.get('x-device-id') || '';
      } else if (typeof config.headers === 'object') {
        for (const k of Object.keys(config.headers)) {
          if (k.toLowerCase() === 'authorization') auth = config.headers[k];
          if (k.toLowerCase() === 'x-device-id') devId = config.headers[k];
        }
      }

      if (auth && auth.startsWith('Bearer ')) {
        capturedToken = auth.slice(7).trim();
      }
      if (devId) {
        capturedDeviceId = devId.trim();
      }
    }

    const response = await origFetch.apply(this, args);

    // Se for chamada de usuário atual, clona para capturar perfil/nome
    if (url.includes('/api/v0/users/current')) {
      try {
        const cloned = response.clone();
        cloned.json().then(data => {
          if (data?.data?.biz_data) {
            capturedUser = data.data.biz_data;
          }
          triggerSync();
        }).catch(() => {});
      } catch {}
    } else if (capturedToken) {
      triggerSync();
    }

    return response;
  };

  // --- 4. Interceptação de XMLHttpRequest ---
  const origOpen = XMLHttpRequest.prototype.open;
  const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._url = url;
    return origOpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
    if (header && header.toLowerCase() === 'authorization' && value.startsWith('Bearer ')) {
      capturedToken = value.slice(7).trim();
      triggerSync();
    }
    if (header && header.toLowerCase() === 'x-device-id') {
      capturedDeviceId = value.trim();
    }
    return origSetRequestHeader.apply(this, [header, value]);
  };

  // --- 5. Disparo e Envio da Sincronização ---
  function triggerSync(force = false) {
    checkLocalStorage();

    if (!capturedToken) return;

    const cookie = document.cookie || '';
    const userAgent = navigator.userAgent;
    const currentHash = `${capturedToken}:${cookie.slice(0, 40)}`;

    if (!force && currentHash === lastSyncedHash) {
      return;
    }

    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => {
      sendSyncToBridge(force);
    }, force ? 10 : 800);
  }

  function sendSyncToBridge(isManual = false) {
    if (!capturedToken) {
      if (isManual) alert('Token não detectado ainda. Envie uma mensagem no chat ou recarregue a página.');
      return;
    }

    updateHud('syncing');

    const payload = {
      token: capturedToken,
      cookie: document.cookie || '',
      userAgent: navigator.userAgent,
      deviceId: capturedDeviceId || '4c1dd084-b214-4167-84cf-a98f3b998697',
      userName: capturedUser?.name || capturedUser?.email || null,
      makeActive: true
    };

    const currentHash = `${capturedToken}:${(document.cookie || '').slice(0, 40)}`;

    // Função de tratamento do sucesso
    function handleSuccess(resJson) {
      lastSyncedHash = currentHash;
      const accName = resJson?.account?.name || 'DeepSeek';
      updateHud('synced', `🟢 Sincronizado: ${accName}`);
      console.log('[DeepBlack AutoCapture] Sincronização concluída com sucesso:', resJson);
    }

    // Função de tratamento de erro
    function handleError(err) {
      updateHud('error', '⚠️ Bridge Offline (:5050)');
      console.warn('[DeepBlack AutoCapture] Erro ao sincronizar com bridge DeepBlack:', err);
    }

    // Prioriza GM_xmlhttpRequest para burlar restrições de CORS/PNA locais do navegador
    if (typeof GM_xmlhttpRequest === 'function') {
      GM_xmlhttpRequest({
        method: 'POST',
        url: BRIDGE_URL,
        headers: {
          'Content-Type': 'application/json'
        },
        data: JSON.stringify(payload),
        onload: function(response) {
          if (response.status >= 200 && response.status < 300) {
            try {
              handleSuccess(JSON.parse(response.responseText));
            } catch {
              handleSuccess({});
            }
          } else {
            handleError(`HTTP ${response.status}`);
          }
        },
        onerror: handleError,
        ontimeout: handleError
      });
    } else {
      // Fallback via Fetch nativo
      fetch(BRIDGE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      .then(res => res.json())
      .then(handleSuccess)
      .catch(handleError);
    }
  }

  // Checagem inicial
  setTimeout(() => {
    checkLocalStorage();
    if (capturedToken) {
      triggerSync();
    }
  }, 1000);

})();
