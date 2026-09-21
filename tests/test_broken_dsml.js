import { parseToolCallsFromText, cleanToolBlocks } from '../src/server.js';

const snip1 = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ parameter name="command" string="true">Get-Content -LiteralPath '\\\\wsl.localhost\\kali-linux\\home\\vt\\w3sqli\\hashes.txt' -Raw; Write-Output '---BRUTE---' #</｜｜DSML｜｜>
</｜｜DSML｜｜ calls>`;

const snip2 = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ parameter name="command" string="true">mkdir -p /tmp/w3 && cd /tmp/w3 && curl -sk -o login37.html -D h_login37.txt "https://www.w3soft3.com.br/W3Escola/frm_login.aspx?codigoEmpresa=37" ; echo EXIT=$?; wc -c login37.html h_login37.txt #</｜｜DSML｜｜ workdir"string">/tmp #</｜｜DSML｜｜>
</｜｜DSML｜｜ calls>`;

const snip3 = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ parameter name="question">
<｜｜DSML｜｜ parameter name="questions" string="false">[{"header": "Onde executar", "question": "De onde eu devo disparar as requisições contra o alvo?", "options": [{"label": "Dentro do WSL Kali (Recomendado)", "description": "Executo via 'wsl -d kali-linux' usando curl/python do Kali e a rede do WSL"}, {"label": "Do próprio Windows (PowerShell)", "description": "Uso Invoke-WebRequest / curl.exe do Windows direto"}, {"label": "Só escrever os scripts", "description": "Eu crio os scripts (.py/.sh) e você executa manualmente no Kali"}]}]</｜｜DSML｜｜>
</｜｜DSML｜｜ question>
</｜｜DSML｜｜ calls>`;

const snip4 = `Read cols.txt<\\｜｜DSML｜｜>
<｜｜DSML｜｜ invoke>
<\\｜｜DSML｜｜ calls>`;

console.log('Result snip1:', JSON.stringify(parseToolCallsFromText(snip1), null, 2));
console.log('Result snip2:', JSON.stringify(parseToolCallsFromText(snip2), null, 2));
console.log('Result snip3:', JSON.stringify(parseToolCallsFromText(snip3), null, 2));
console.log('Result snip4:', JSON.stringify(parseToolCallsFromText(snip4), null, 2));
