// scripts/generate_bookmarklet_html.js — gera scripts/bookmarklet.html a
// partir de bookmarklet.js, minificando e embutindo como um link
// "arraste pra barra de favoritos" -- alternativa ao userscript do
// Tampermonkey que nao exige instalar nenhuma extensao.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, 'bookmarklet.js'), 'utf8');

const body = src
  .replace(/^\/\*\*[\s\S]*?\*\/\s*/, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')
  .replace(/\s+/g, ' ')
  .trim();
const bookmarkletUrl = 'javascript:' + encodeURIComponent(body);

fs.writeFileSync(path.join(__dirname, 'bookmarklet.txt'), bookmarkletUrl);

const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>DeepBlack Suite — Sincronizar Conta</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; background: #0d1117; color: #c9d1d9; max-width: 640px; margin: 60px auto; padding: 0 20px; line-height: 1.6; }
  h1 { color: #f0f6fc; font-size: 22px; }
  .steps { counter-reset: step; }
  .steps li { list-style: none; margin: 18px 0; padding-left: 36px; position: relative; }
  .steps li::before { counter-increment: step; content: counter(step); position: absolute; left: 0; top: 0; width: 24px; height: 24px; background: #238636; color: #fff; border-radius: 50%; text-align: center; font-weight: 700; font-size: 13px; line-height: 24px; }
  .bookmarklet-btn { display: inline-block; background: #238636; color: #fff !important; text-decoration: none; padding: 10px 20px; border-radius: 6px; font-weight: 600; cursor: grab; border: 1px solid #2ea043; }
  .bookmarklet-btn:hover { background: #2ea043; }
  code { background: #161b22; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
  .note { background: #161b22; border-left: 3px solid #e3b341; padding: 10px 14px; margin-top: 24px; font-size: 14px; }
</style>
</head>
<body>
  <h1>🔗 Sincronizar sua conta DeepSeek com o DeepBlack</h1>
  <p>Sem precisar instalar nenhuma extensão no navegador.</p>
  <ol class="steps">
    <li>Garanta que a barra de favoritos está visível (<code>Ctrl+Shift+B</code> na maioria dos navegadores).</li>
    <li><strong>Arraste</strong> o botão abaixo até a barra de favoritos:<br><br>
      <a class="bookmarklet-btn" href="${bookmarkletUrl}" onclick="alert('Nao clique aqui -- ARRASTE este botao ate a barra de favoritos do navegador.'); return false;">🔗 Sincronizar DeepBlack</a>
    </li>
    <li>Abra <a href="https://chat.deepseek.com" style="color:#58a6ff">chat.deepseek.com</a> e faça login normalmente com sua conta.</li>
    <li>Clique no favorito "🔗 Sincronizar DeepBlack" que você acabou de criar.</li>
  </ol>
  <p>Um aviso vai confirmar que sua conta foi sincronizada com o DeepBlack Suite rodando na sua máquina (porta 5050).</p>
  <div class="note">
    Precisa repetir o clique de vez em quando (quando o token expirar). Se preferir sincronização automática a cada login, use o userscript <code>deepblack_autocapture.user.js</code> com a extensão Tampermonkey em vez deste bookmarklet.
  </div>
</body>
</html>
`;

fs.writeFileSync(path.join(__dirname, 'bookmarklet.html'), html);
console.log('Gerado scripts/bookmarklet.html e scripts/bookmarklet.txt (' + bookmarkletUrl.length + ' chars)');
