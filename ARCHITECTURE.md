# ARCHITECTURE.md — DeepBlack: do Chat Bridge ao Ecossistema Agêntico

> Documento vivo. Serve como âncora fixa de decisões de arquitetura para que
> sessões longas (ou compactadas) do Claude Code não percam o contexto do
> porquê das coisas serem como são. Atualize este arquivo sempre que uma
> decisão listada aqui mudar de status ou for revista.

## Princípio central

Toda decisão de design parte de uma pergunta: **isso roda no DeepCode
(cliente/executor) ou no DeepBlack (gateway/tradutor)?**

- **DeepCode** = onde vive lógica de negócio, execução local, descoberta de
  skills/MCP, extração de arquivos.
- **DeepBlack** = tradutor de protocolo de alta fidelidade entre
  OpenAI-compatible (entrada) e DeepSeek Web (upstream). Deve permanecer
  agnóstico ao que o cliente está tentando fazer, exceto onde a tradução
  exige interceptação ativa (ex.: imagens, que o upstream não aceita).

---

## Pilar 1 — Sistema de Skills

Uma skill (padrão OpenCode) é uma pasta com `SKILL.md` (YAML + instruções +
scripts/templates). Descoberta, injeção de sumário no prompt e execução dos
scripts são responsabilidade do cliente.

**Decisão: manter o gateway agnóstico (cliente é dono das skills).**

- Uma skill carrega scripts executáveis, templates e hooks que precisam
  rodar na máquina onde o DeepCode está — o DeepBlack não tem esse contexto
  de execução.
- O DeepCode já faz a descoberta de `.opencode/skills/` e já possui o
  executor local. Se o DeepBlack tentasse injetar skills próprias no prompt,
  criaria redundância com o que o DeepCode já injeta, além de assumir um
  papel opinativo que foge de um gateway de alta fidelidade.
- Requisito mínimo do gateway: `src/agent_prompt.js` deve preservar
  integralmente qualquer bloco `<available_skills>` (ou equivalente) vindo
  nas mensagens, sem truncar. Hoje isso já é o comportamento padrão — não há
  lógica de corte de mensagens no `formatMessagesToPrompt`.
- Se no futuro for necessário injetar instruções globais válidas para
  qualquer cliente (incluindo Cursor/VS Code sem `.opencode/skills/`), o
  caminho é `prompts/system_prompt.md` (já carregado incondicionalmente) ou
  uma flag opcional `DEEPBLACK_INJECT_RULES=false`/`true` — **não** um
  injetor de skills completo.

**Status:** decisão tomada, nenhuma mudança de código necessária.

---

## Pilar 2 — MCP (Model Context Protocol)

O DeepCode inicializa os servidores MCP (GitHub, Postgres, Docker, Slack
etc.), coleta os schemas de tools e manda no `tools: [...]` do payload
OpenAI. O DeepBlack recebe esse array em `POST /v1/chat/completions` e
precisa: (a) descrevê-lo ao R1 de forma que ele use os nomes exatos, e (b)
converter as respostas em DSML/`<tool_call>` de volta para `delta.tool_calls`
no formato OpenAI.

### Nomes namespaced (`mcp__github__create_pull_request`)

Verificado contra o código atual: **nenhuma mudança necessária.**
`normalizeToolNameAndArgs` (`src/server.js`) só reescreve aliases genéricos
específicos (`filepath`, `path`, `command`, `cmd`, `question`, `questions`).
Nomes com `__` e caracteres de namespace passam direto pelo parser DSML e
pelo parser de JSON — os regexes de captura de `name` usam `[^"'\s>]+`, que
aceita `_` sem problema.

### 2.1 Reenvio de tools em continuação de sessão — Delta por Hash

**Problema:** o bloco `AVAILABLE TOOLS` só é montado quando
`isNewSession === true`. Em turnos seguintes, o gateway só serializa as
mensagens *trailing* desde o último `assistant`. Se o conjunto de tools MCP
mudar no meio da conversa (servidor reconecta, usuário liga/desliga um MCP
server), o R1 nunca fica sabendo.

**Decisão: Reenvio por Hash (Delta/Update).**

- Hash canônico: ordenar as tools por `tool.function.name` **antes** de
  serializar, depois `crypto.createHash('sha256').update(JSON.stringify(sortedTools)).digest('hex').slice(0, 16)`.
  Ordenar antes de hashear é obrigatório — sem isso, reordenação aleatória
  entre reconexões de servidores MCP gera falsos positivos de "mudou".
- Armazenar `lastToolsHash` no objeto de sessão em `.deepblack_sessions.json`
  (mesmo objeto já persistido por `DeepSeekWebClient.saveSessions()`).
- Em continuação (`isNewSession === false`), se
  `currentToolsHash !== session.lastToolsHash`: injetar no topo do prompt de
  trailing um bloco explícito:
  ```
  [SYSTEM UPDATE: TOOLSET MODIFIED]
  As ferramentas disponíveis foram atualizadas neste turno:
  <TOOL_USE>
  ... (novas tools formatadas) ...
  </TOOL_USE>
  ```
- Atualizar `lastToolsHash` a cada turno (inclusive no primeiro, quando
  `isNewSession === true`).

**Implementação real (ajuste em relação ao desenho inicial):** a escrita do
`lastToolsHash` não acontece antes de enviar o request — ela é feita em
`src/server.js` **depois** que o stream termina (`chunk.type === 'done'` no
caminho streaming; após o loop `for await` no caminho não-streaming), via
`client.updateToolsHash(externalSessionId, currentToolsHash)`
(`src/deepseek.js`). Motivo: `ensureSession()` **substitui** o objeto de
sessão inteiro quando cria uma sessão nova (`this.sessions[externalId] = {...}`),
então gravar o hash antes desse ponto seria sobrescrito. Escrever depois do
`streamCompletion()` garante que a sessão já existe e nunca é clobbered.
`updateToolsHash` só grava se `this.sessions[externalId]` já existir — é um
no-op seguro caso contrário.

**Status:** ✅ implementado (Ataque 2).
- `computeToolsHash(tools)` em `src/agent_prompt.js` — hash canônico
  (ordenado por `function.name`).
- `toolsChanged` calculado em `src/server.js` (`!isNew && currentToolsHash !==
  sessionEntry?.lastToolsHash`) e passado como 5º argumento de
  `formatMessagesToPrompt`.
- Bloco `[SYSTEM UPDATE: TOOLSET MODIFIED]` injetado no topo do prompt de
  continuação quando `toolsChanged === true`.
- `DeepSeekWebClient.updateToolsHash()` em `src/deepseek.js` persiste o hash
  em `.deepblack_sessions.json`.
- Testado em `tests/test_tools_hash.js` (reordenação não gera falso-positivo;
  tool nova gera hash diferente; conjunto vazio nunca dispara "changed").

### 2.2 Orçamento de tokens para schemas MCP (Token Diet)

**Problema:** `JSON.stringify(tools, null, 2)` hoje preserva indentação de 2
espaços e campos decorativos (`$schema`, `title`, `examples`,
`additionalProperties`). Com múltiplos servidores MCP (GitHub + Postgres +
Docker + Slack), isso facilmente passa de 6k tokens só de formatação e
metadado.

**Decisão: minificação + teto de segurança.**

- Strip de campos decorativos: `$schema`, `title`, `examples`,
  `additionalProperties` (manter `required`, `enum`, `type`, `properties`,
  `description` — são os campos que o modelo realmente usa para montar
  argumentos corretos).
- Truncar `description` de cada tool para no máximo 160 caracteres.
- Serialização sem whitespace (`JSON.stringify(compactTools)`, sem
  `null, 2`).
- Hard cap: se o bloco total ultrapassar ~4.000 tokens (~16.000
  caracteres), logar aviso no terminal/dashboard e truncar as descrições
  mais longas até caber no orçamento.

**Implementação real (nota sobre o hard cap):** o cap de 16.000 caracteres é
um último recurso, não o mecanismo principal — na prática o strip de campos +
truncagem de `description` já reduz o grosso do payload. Se mesmo assim o
JSON minificado ultrapassar o teto, o corte é feito na **string serializada**
(`serialized.slice(0, 16000) + '...[TRUNCADO]'`), o que pode deixar o JSON
sintaticamente inválido no meio do bloco. Isso é aceitável porque o bloco é
lido como texto pelo R1 (não é reparseado por código no gateway), mas é uma
rede de segurança para um cenário raro — se acionar com frequência no
dashboard, é sinal de que o cliente deveria filtrar tools antes de mandar
(ver Pilar 2, discussão original sobre priorizar filtragem no lado do
DeepCode).

**Status:** ✅ implementado (Ataque 3).
- `minifyToolsForPrompt(tools)` em `src/agent_prompt.js` — strip recursivo de
  `$schema`/`title`/`examples`/`additionalProperties`, truncagem de
  `description` (qualquer nível de aninhamento) para 160 chars, serialização
  sem whitespace, hard cap de 16.000 chars com log de aviso.
  Usado tanto no bloco `AVAILABLE TOOLS` (sessão nova) quanto no bloco
  `[SYSTEM UPDATE: TOOLSET MODIFIED]` (Ataque 2).
- Testado em `tests/test_tools_hash.js` (schema minificado não contém campos
  de ruído, description truncada, serialização sem `\n`).

---

## Pilar 3 — Documentos e Imagens (Multimodalidade)

O modelo upstream (`deepseek-reasoner` / R1) é puramente textual — não
aceita tensores de imagem no prompt.

### 3.1 Documentos (PDF, DOCX, CSV, planilhas, TXT)

**Estratégia: pre-processing no DeepCode.** O cliente extrai o texto bruto
estruturado localmente e anexa como bloco delimitado
(`<document path="..." pages="N">...</document>`). O gateway não precisa de
lógica nova além de preservar esse bloco como texto — mesmo requisito do
Pilar 1.

**Status:** não iniciado. Responsabilidade do DeepCode, sem trabalho
pendente no DeepBlack.

### 3.2 Imagens (screenshots, diagramas, erros de UI)

**Bug ativo identificado:** `formatMessagesToPrompt` tratava qualquer parte
de `content` array que não fosse string/`.text` com
`c.text || JSON.stringify(c)`. Uma parte OpenAI de imagem
(`{type: "image_url", image_url: {url: "data:image/png;base64,..."}}`)
caía nesse `JSON.stringify` — ou seja, uma string base64 de 500KB–3MB era
despejada crua dentro do prompt textual, e o upstream do DeepSeek
recusa/estoura tokens.

**Decisão: guard-rail absoluto — nunca vazar base64 bruto no prompt.**

Pipeline de resolução (`src/vision.js`):

1. **Caminho A — VLM local (DeepHat).** Se `isDeepHatAlive()` (já existente
   em `src/deephat.js`) responder ativo, a imagem é enviada via payload
   OpenAI-vision (`image_url`) para o endpoint multimodal do llama.cpp em
   `:11435`, que gera uma descrição técnica
   (`[VISUAL CONTEXT: imagem_1.png]\n...`) injetada no lugar da imagem.
2. **Caminho B — fallback sem VLM.** Se o VLM local estiver offline (ou a
   chamada falhar/expirar), a imagem é substituída por uma tag semântica
   limpa: `[ATTACHED IMAGE: <imagem_1.png> (VLM offline - processamento
   visual indisponível)]`. Isso evita timeout/HTTP 413 no upstream e permite
   que o R1 continue o raciocínio com o resto do prompt.
3. **Upload upstream nativo (não implementado ainda).** A interface web do
   DeepSeek tem endpoint de upload de arquivo — mapear
   `/api/v0/file/upload` (ou equivalente) e anexar `file_id` à sessão é uma
   estratégia alternativa/complementar ao VLM local, ainda não desenhada em
   detalhe. Fica registrado aqui como próximo passo em aberto, não como
   parte do Ataque 1.

**Status:** implementado (Ataque 1) — ver seção "Ressalvas de Implementação
Aplicadas" abaixo para os dois ajustes técnicos que isso exigiu no restante
do pipeline.

---

## Ressalvas de Implementação Aplicadas (Ataque 1)

1. **`formatMessagesToPrompt` virou `async`.** Necessário porque o Caminho A
   do Pilar 3.2 faz uma chamada de rede (`fetch`) ao VLM local antes de
   poder montar o prompt final. O único call site
   (`src/server.js`, dentro do handler `POST /v1/chat/completions`) já era
   `async (req, res) => {...}`, então o `await` encaixou sem atrito — não
   houve cascata de refactor além desse arquivo.
2. **Hash de tools (Pilar 2.1) precisa ser canônico.** Ordenar por
   `tool.function.name` antes de hashear é obrigatório para eliminar falsos
   positivos de "toolset mudou" quando servidores MCP apenas reconectam em
   ordem diferente — decisão já registrada na seção 2.1, repetida aqui
   porque foi validada explicitamente antes da implementação.

## Ressalvas de Implementação Aplicadas (Ataque 2)

1. **Ponto de escrita do `lastToolsHash` foi movido para depois do stream,
   não antes do request.** `ensureSession()` substitui o objeto de sessão
   inteiro ao criar uma sessão nova, então qualquer campo escrito antes desse
   ponto seria perdido. `client.updateToolsHash()` só grava quando a sessão
   já existe, e é chamado em `src/server.js` após `client.streamCompletion()`
   terminar (tanto no branch streaming quanto no não-streaming) — nesse
   ponto a sessão já foi garantidamente criada internamente pelo
   `streamCompletion()`.
2. **`toolsChanged` só é `true` quando há tools no turno atual.** Se o
   cliente parar de mandar `tools` completamente (array vazio), o gateway
   não reinjeta um aviso de "toolset removido" — `computeToolsHash([])`
   retorna `null`, e a lógica em `server.js` exige
   `currentToolsHash !== null` para considerar mudança. Esse caso extremo
   (remoção total do toolset) não foi pedido no desenho original e fica como
   gap conhecido, não como bug.

---

## Mapa de Arquivos por Frente

| Frente                                  | Arquivos tocados                                      | Status |
|------------------------------------------|--------------------------------------------------------|--------|
| Skills                                   | nenhum (decisão arquitetural, sem código)              | ✅ decidido |
| MCP — nomes namespaced                   | nenhum (já tolerado pelo parser atual)                 | ✅ verificado |
| MCP — reenvio de tools por hash          | `src/agent_prompt.js`, `src/deepseek.js`, `src/server.js`, `tests/test_tools_hash.js` | ✅ implementado (Ataque 2) |
| MCP — token diet de schemas              | `src/agent_prompt.js`, `tests/test_tools_hash.js`       | ✅ implementado (Ataque 3) |
| Multimodal — documentos                  | (DeepCode, fora do DeepBlack)                           | ⏳ não iniciado |
| Multimodal — imagens (VLM local/fallback)| `src/vision.js` (novo), `src/agent_prompt.js`, `src/server.js` | ✅ implementado (Ataque 1) |
| Multimodal — upload upstream nativo      | a definir (`src/deepseek.js` provavelmente)             | 💤 em aberto, não desenhado |

## Ordem de Ataque

1. **Ataque 1 — Multimodal bugfix (concluído).** `src/vision.js` +
   `formatMessagesToPrompt` assíncrona + interceptação de `image_url`.
2. **Ataque 2 — MCP resiliência (concluído).** Hash canônico de tools em
   `src/agent_prompt.js`, campo `lastToolsHash` persistido via
   `DeepSeekWebClient.updateToolsHash()` em `.deepblack_sessions.json`,
   reinjeção do bloco `[SYSTEM UPDATE: TOOLSET MODIFIED]` quando o hash muda
   em continuação de sessão.
3. **Ataque 3 — MCP token diet (concluído).** `minifyToolsForPrompt()` em
   `src/agent_prompt.js`: strip de campos decorativos, truncagem de
   description a 160 chars, serialização sem whitespace, hard cap de 16k
   chars.

## Histórico de decisões

- 2026-09-18 — Documento criado consolidando os 3 pilares (Skills, MCP,
  Multimodalidade) discutidos e decididos em sessão de arquitetura. Ataque 1
  implementado no mesmo dia: `src/vision.js` criado; `formatMessagesToPrompt`
  em `src/agent_prompt.js` convertida para `async` com interceptação de
  partes `image_url`/`image`; `src/server.js` atualizado com `await` no call
  site de `/v1/chat/completions`.
- 2026-09-18 — Ataques 2 e 3 implementados na mesma sessão: `computeToolsHash`
  e `minifyToolsForPrompt` adicionados a `src/agent_prompt.js`;
  `DeepSeekWebClient.updateToolsHash()` adicionado a `src/deepseek.js`;
  `src/server.js` calcula `toolsChanged` por sessão e persiste o hash após o
  fim do stream. Validado por `tests/test_tools_hash.js` (5 casos: hash
  estável sob reordenação, hash muda com tool nova, conjunto vazio nunca
  dispara "changed", minificação remove ruído/trunca description, reinjeção
  condicional do bloco `[SYSTEM UPDATE: TOOLSET MODIFIED]`).
- 2026-09-18 — Validação ao vivo do Ataque 2 contra a conta real do DeepSeek.
  Achado: já havia uma instância do bridge rodando na porta 5050 (PID
  confirmado via `Get-Process`) com `StartTime` **anterior** aos três
  ataques — ou seja, rodando código desatualizado sem nenhuma das mudanças.
  Como `.env` fixa `PORT=5050` e `loadEnv()` em `src/deepseek.js` sobrescreve
  qualquer `PORT` vindo do shell, não dá para subir uma segunda instância em
  porta diferente sem remover essa linha do `.env` temporariamente — feito
  com backup e restauração ao final, sem tocar na instância já em uso.
  Teste: 2 turnos na mesma sessão contra a instância isolada (`:5051`) —
  Turn 1 (`tools=[read_file]`, sessão nova) logou `isNew=true |
  toolsChanged=false`; Turn 2 (`tools=[read_file, write_file]`, continuação)
  logou `isNew=false | toolsChanged=true`, confirmando reinjeção do bloco de
  toolset atualizado em condição real. `lastToolsHash` confirmado persistido
  em `.deepblack_sessions.json`. Sessão remota de teste e entrada local
  removidas depois (`deleteSessions` + edição direta do JSON).
- 2026-09-18 — Corrigido bug pré-existente no parser DSML (`src/server.js`,
  `dsmlInvokeRegex`), não relacionado aos Ataques 1-3 mas achado durante a
  rodada de testes de regressão (`tests/test_f4f2_recovery.js` falhava).
  **Causa raiz:** o grupo de conteúdo lazy `([\s\S]*?)` de um bloco
  `<invoke>` terminava prematuramente ao encontrar QUALQUER tag DSML
  aninhada — inclusive um `<parameter>` filho legítimo do próprio invoke —
  em vez de só terminar no `</invoke>` real. Isso fazia o parser devolver
  `arguments: {}` (silenciosamente vazio) sempre que o primeiro
  `<parameter>` de um invoke usava o prefixo DSML na tag de abertura. Como o
  `tool_calls.length` continuava sendo 1, o agente recebia uma chamada de
  ferramenta "válida" mas sem argumentos — consistente com o sintoma
  relatado ("o parser falha e o agente para achando que tá rodando").
  **Fix:** guarda de lookahead negativo `(?![|｜])(?!\s*parameter\b)` — a
  primeira parte força o quantificador `{1,2}` dos pipes de fechamento do
  prefixo DSML a consumir a sequência inteira (sem isso, o motor de regex
  conseguia "sub-consumir" 1 pipe em vez de 2 para escapar do lookahead
  negativo, já que o pipe restante não é espaço em branco). Validado contra
  toda a suíte que exercita `parseToolCallsFromText`/`cleanToolBlocks`
  (`test_f4f2_recovery.js`, `test_dsml_parser.js`, `test_broken_dsml.js`,
  `test_f4f0_tool_calls.js`, `test_msg_parsing.js`, `test_server_complete.js`)
  — todos passando, incluindo um caso que antes "passava" com argumentos
  vazios mascarados por uma asserção fraca (`test_server_complete.js`, caso
  "sfp_hex.py tag leak", que agora extrai `filePath` de verdade).
- 2026-09-18 — Rede de segurança pós-parse adicionada em `src/server.js`
  (`findMissingRequiredArgs` + `logToolParseWarnings`), para os casos em que
  o parser DSML — que é heurístico por natureza — ainda assim não conseguir
  recuperar 100% de uma tag malformada/truncada. **Decisão explícita:** não
  altera o que é enviado ao cliente (a tool call continua sendo emitida
  normalmente, mesmo incompleta) — só loga no console (`[Bridge Parser
  Warning]`) e emite um evento `tool_parse_warning` no barramento de
  atividade (`src/activity.js`), visível no dashboard. Checa os campos
  obrigatórios usando o `parameters.required` do JSON Schema real da tool
  quando o cliente declarou (cobre tools MCP automaticamente), com fallback
  para uma lista fixa (`NATIVE_TOOL_REQUIRED_ARGS`) nas tools locais nativas
  (`bash`, `write`, `edit`, `read`, `grep`, `glob`, `webfetch`, `task`,
  `todowrite`). Tools desconhecidas sem schema declarado nunca são
  acusadas — evita falso-positivo por falta de informação sobre o que é
  obrigatório. Validado em `tests/test_tool_arg_validation.js` (6 casos).
- 2026-09-18 — Quatro bugs de streaming SSE corrigidos em `src/server.js`,
  reportados pelo operador a partir de uma sessão real travada (padrão:
  "para achando que tá rodando" + HTML corrompido numa análise de página
  scrapeada). Todos confirmados contra o código antes de corrigir:
  1. **`cleanToolBlocks` destruía HTML legítimo.** A regex de fallback pra
     tags sem prefixo DSML usava `[a-zA-Z0-9_]+` como catch-all — casava
     `<table>`, `<form>`, `<input>`, `<div>` etc. e apagava tudo. Trocado por
     allowlist estrita (`calls|invoke|parameter|question`) para tags sem
     DSML; tags COM prefixo DSML continuam removidas amplamente (esse caso é
     inequívoco). Confirmado bug real com teste isolado antes do fix:
     `<table><tr><td>Admin</td></tr></table>` virava só `"Admin"`.
  2. **Detecção de tag de tool no streaming não cobria variantes reais.** O
     lookahead exigia exatamente 2 pipes (`<[|｜]{2}DSML`) — não pegava
     1 pipe, `<parameter` órfão (sem `<invoke>` ao redor), nem o início de
     bloco ` ```json {"name":...` — nesses casos a sintaxe crua da tool call
     vazava como texto visível no chat antes de ser reconhecida no `done`.
  3. **Flush de texto no `done` pulado quando havia tool calls.** O bloco que
     reenvia o texto retido pelo heurístico de streaming só rodava quando
     `toolCalls.length === 0`; havendo tool calls, texto legítimo (ex.:
     introdução do modelo antes de invocar a ferramenta) era descartado sem
     nunca ser enviado — mesmo comportamento do incidente
     `session-ses_f4d9.md` citado pelo operador. Agora o flush roda sempre,
     limpando via `cleanToolBlocks` quando há tool calls (pode conter
     fragmento de tag) ou cru quando não há.
  4. **Heurístico do `<` final segurava streaming para não-tags.** Um `<`
     nos últimos 15 caracteres travava o envio mesmo sendo comparação
     matemática (`x < 10`, `count < 5`). Agora só segura se o caractere após
     o `<` puder plausivelmente iniciar uma tag (`/`, letra, ou pipe DSML).
  Removido também código morto (variável `cleanedText` sem uso e um bloco de
  flush duplicado que nunca executava de fato no branch sem tool calls,
  porque `streamedChars` já tinha sido avançado por outro bloco antes dele).
  Validado por `tests/test_tool_leak_and_html.js` (6 casos: HTML sobrevive,
  tags DSML/não-DSML removidas sem resíduo, bloco markdown json removido,
  DSML de 1 pipe parseado — ASCII e fullwidth —, introdução antes de
  `<invoke>` preservada) + toda a suíte existente revalidada sem regressão.
- 2026-09-18 — Bug real de produção corrigido: DSML órfão com só
  `<｜｜DSML｜｜ parameter name="content">` (sem `<invoke>` e sem `filePath`)
  fazia `inferToolFromParams` retornar `null` — o script inteiro (Python/
  Bash) era descartado, `cleanToolBlocks` apagava a tag, e a requisição
  fechava com `finish_reason: 'stop'` sem nenhuma tool executada, dando a
  impressão de sessão travada. Reportado pelo operador com exemplo real
  (script `open_geny_w3.sh` via Genymotion/adb) e confirmado antes de
  corrigir. **Fix:** `inferToolFromParams` agora infere `write` só com
  `content` presente (sem exigir `filepath` junto); nova função
  `inferFilePathFromContent(content)` em `src/server.js` gera um nome de
  arquivo de fallback quando o modelo omite `filePath` — checa dica explícita
  em comentário (`# filename: x.py` / `// path: x.js`) primeiro, depois
  detecta Python (`import`/`def`/`print(`/`class`) → `temp_script.py`, shell
  (`#!/bin/`, `curl`, `wget`, `chmod`) → `temp_script.sh`, senão
  `temp_file.txt`. Chamado em `normalizeToolNameAndArgs` quando `toolName ===
  'write'` e `filePath` ausente. **Limitação conhecida:** se o mesmo turno
  emitir 2+ blocos órfãos sem `filePath`, ambos recebem o mesmo nome
  inferido (ex.: `temp_script.py` duas vezes) — sem contador de
  desambiguação por não ser um caso pedido/testado; risco baixo (é um
  fallback para um formato já raro). Validado em
  `tests/test_tool_leak_and_html.js` (recuperação do snippet exato do
  incidente + 5 casos de `inferFilePathFromContent`).
- 2026-09-19 — Novo padrão de corrupção de tool call reportado e corrigido:
  o tokenizer do DeepSeek ocasionalmente emite o ideograma `该` (U+8BE5) no
  lugar do pipe de controle DSML (`｜`, U+FF5C) quando ele fica colado
  imediatamente antes ou depois do token literal "DSML" (ex.:
  `<｜该DSML｜｜ calls>` em vez de `<｜｜DSML｜｜ calls>`). Todas as regexes do
  arquivo esperavam estritamente `[|｜]{1,2}` ao redor de "DSML", então o
  bloco inteiro não era reconhecido — `parseToolCallsFromText` retornava
  `[]`, o script era descartado, e no streaming o texto glitchado vazava
  cru no chat (o mesmo lookahead `toolCallIdx` também não reconhecia).
  **Decisão de design:** em vez da proposta original de duplicar uma classe
  de caracteres tolerante a `该` em ~10 regexes diferentes (frágil — cada
  nova variante de glitch exigiria editar todas de novo, e o histórico já
  mostrou que essas regexes com pipes Unicode são fáceis de acertar errado),
  optei por uma função de normalização única, `normalizeDsmlGlitches(text)`
  em `src/server.js`: substitui `该` por `｜` **só** quando colado
  imediatamente antes/depois do literal "DSML" (lookahead/lookbehind — não
  toca em `该` normal aparecendo em qualquer outro contexto de texto).
  Chamada uma vez no topo de `parseToolCallsFromText`, `cleanToolBlocks`, e
  no streaming logo após `contentAccumulator += chunk.text` (antes do
  cálculo de `toolCallIdx`). Com isso nenhuma outra regex precisou ser
  tocada — o texto já chega canônico em todo o resto do pipeline. Extensível
  para futuros glitches com uma linha (`DSML_GLITCH_CHARS`). A limpeza do
  fechamento comentado (`#</｜｜DSML｜｜>`) já funcionava sem mudança nenhuma
  — o `sanitizeArg` existente já cobria esse caso, só não era alcançado
  porque o bloco nem chegava a ser reconhecido antes do fix. Validado em
  `tests/test_chinese_dsml.js` (normalização isolada, payload real do
  incidente incluindo o `#</...>`, e combinação glitch + pipe único).
- 2026-09-19 (mesmo dia, poucas horas depois) — Segunda variante do glitch
  confirmada em produção: `該` (U+8A72, forma **tradicional** do mesmo
  ideograma, mesma posição colada em "DSML") — diferente do `该` (U+8BE5,
  simplificado) do incidente anterior. Confirma que o design em lista
  extensível (`DSML_GLITCH_CHARS`) foi a decisão certa: adicionado o novo
  caractere numa linha só (`'该' + '該'`), sem tocar em mais nada. Validado
  com o payload real do segundo incidente (comando `hashcat`) em
  `tests/test_chinese_dsml.js`. Se aparecer um terceiro glitch, o padrão é
  o mesmo: confirmar o codepoint exato, adicionar a `DSML_GLITCH_CHARS`,
  testar, não tocar nas outras regexes.

- 2026-09-19 (mesmo dia) - Bug de concorrencia real descoberto e corrigido,
  achado rodando `opencode run` diretamente contra o bridge (`opencode run
  "oi" --model deepblack/deepseek-chat --format json`) e cruzando o log do
  bridge com a lista de sessoes reais da conta DeepSeek - nao foi reportado
  pelo operador, foi encontrado investigando ao vivo.
  **Causa raiz:** o OpenCode dispara duas requisicoes /v1/chat/completions
  por turno usando o MESMO x-session-id: uma de "title generator" (a
  primeira mensagem do body comeca literalmente com "You are a title
  generator...") e uma com o agente principal (com todas as tools). As duas
  chegam perto o suficiente pra rodar concorrentemente - como isNew e
  calculado de forma sincrona via client.getSession(externalSessionId)
  antes de qualquer await, as duas viam "sessao nao existe" e cada uma
  criava sua propria sessao remota no DeepSeek sob a MESMA chave local
  (this.sessions[externalId]), com a que terminasse por ultimo sobrescrevendo
  silenciosamente o deepseekSessionId/lastResponseMessageId da outra.
  Confirmado batendo .deepblack_sessions.json contra a lista de sessoes
  reais da conta: 1 "oi" gerava 2 sessoes remotas no DeepSeek, uma delas
  orfa (nunca mais referenciada). Esse tipo de corrupcao de estado de sessao
  e candidato plausivel pra explicar sintomas antigos de "parou de
  responder" que nao tinham explicacao clara nos incidentes de parsing DSML.
  **Fix:** deteccao do request de title-gen pelo prefixo fixo do prompt
  (messages[0].content.startsWith('You are a title generator')), isolado
  numa dsSessionKey descartavel e unica
  (`${externalSessionId}__titlegen_${Date.now()}_${random}`) usada em todo
  lugar que toca o estado da sessao DeepSeek (getSession, ensureSession,
  streamCompletion, updateToolsHash) - nunca mais colide com a chave da
  sessao real. A entrada e removida (client.resetSession(dsSessionKey))
  assim que o request termina, pra nao acumular lixo em
  .deepblack_sessions.json.
  **Limitacao conhecida (aceita, nao corrigida):** a chamada de title-gen
  ainda cria uma sessao remota nova na conta DeepSeek a cada turno (o
  protocolo do DeepSeek Web exige chat_session_id pra qualquer completion) -
  ela so nao colide mais com a sessao real. Isso e sujeira cosmetica no
  historico de chats (mesma categoria que cleanTestSessions() em
  cli/sessions.js ja existe pra lidar), nao e mais um bug funcional. Uma
  otimizacao futura possivel seria reutilizar uma unica sessao "reservada"
  pra todas as chamadas de title-gen, sempre ramificando a partir da raiz
  (parent_message_id: null), evitando criar uma sessao nova por turno - nao
  implementado agora por nao ser o problema relatado.

- 2026-09-19 - Bug real de producao achado num teste profundo proposito
  (fixture com bugs assincronos em varios arquivos, mais dificil que o
  script unico de antes): filePath/content/command as vezes chegavam com
  BARRA DUPLICADA (ex: "C:\\Users\\vitor\\..." em vez de "C:\
  Users\vitor\..."), fazendo edit/write apontarem pro lugar errado - o
  proprio modelo notou ("The edits didn't take effect", "The edit tool
  isn't sticking") mas nunca corrigiu de verdade, travando a tarefa.
  Confirmado com dump de texto bruto (env var DEEPBLACK_DEBUG_RAW_DUMP,
  temporario, ja removido do uso) reproduzindo o cenario real.
  **Causa raiz dupla em robustParseJson (src/server.js):**
  1. O extrator de fallback por regex (usado quando JSON.parse falha)
     capturava o texto cru direto de "trimmed" sem nunca desescapar
     sequencias JSON (\\ -> \, \n -> quebra de linha, etc) antes de usar
     como valor final de filePath/content/command. Um path corretamente
     escapado no JSON de origem (2 barras reais = 1 barra logica) virava
     literalmente 2 barras na string final.
  2. O "fix de backslash" da etapa 2 (pensado pra escapar paths Windows
     crus tipo C:\Users que o modelo as vezes solta sem escapar) processava
     backslash por backslash, sem reconhecer que um par \\ ja formado era
     um escape valido - a segunda barra do par, seguida de letra maiuscula
     (ex: "Users"), nao batia na lista de escapes validos (so 'u' minusculo
     conta pra \uXXXX) e era duplicada de novo, corrompendo o JSON e
     forcando a queda pro fallback regex (onde o bug 1 acima terminava de
     estragar tudo).
  **Fix:** nova funcao unescapeJsonString() aplicada em filePath/content/
  command no extrator de fallback; regex do "fix de backslash" reescrita
  pra reconhecer sequencias de escape validas como unidade (\\, \n, \uXXXX,
  etc) via alternancia, so dobrando uma barra que sobra sozinha de verdade.
  Validado em tests/test_backslash_unescape.js (4 casos: JSON ja valido
  preservado, fallback regex desescapa path com barra dupla, path cru de
  1 barra ainda corrigido, content com \n e \" desescapado corretamente).
  Suite completa revalidada sem regressao (12 arquivos).

- 2026-09-19 - Retry de "0 tokens" em src/deepseek.js tornado incondicional.
  Achado: em varias rodadas do teste dificil (reasoner e chat, paralelo e
  sequencial, com e sem sessao longa acumulada) a mesma sessao bateu em
  "yielded 0 tokens" repetidas vezes - inclusive a rodada do reasoner que
  completou a tarefa inteira com sucesso (5/5 testes, dist/ funcionando)
  tambem bateu nisso no ultimo turno, e foi por isso que o resumo final em
  texto nunca saiu (o turno que geraria ficou vazio). Isso deixou de parecer
  "so contencao de conta rodando 2 sessoes em paralelo" (hipotese de antes)
  e passou a parecer uma flakiness real e nao tao rara do upstream do
  DeepSeek Web.
  **Causa raiz do porque o retry existente nao ajudava:** a logica de
  auto-repair em streamCompletion() so tentava de novo quando achava uma
  dessincronia REAL de parentMessageId (getLatestMessageId() diferente do
  que estava salvo). Se a resposta vinha vazia por qualquer OUTRO motivo
  (nosso parentMessageId ja estava certo, so o upstream nao respondeu
  direito dessa vez), o codigo desistia na hora, sem tentar de novo -
  havia 3 blocos praticamente identicos com esse mesmo gap (no `[DONE]`,
  no `response/status FINISHED/STOPPED`, e no fallback pos-loop).
  **Fix:** novo metodo `_resolveRetryParentId()` centraliza a checagem de
  dessincronia (corrige se achar, senao devolve o parentMessageId atual
  mesmo). Os 3 pontos agora RETENTAM sempre que `yieldedTokens === 0`,
  independente de ter achado dessincronia ou nao, com backoff crescente
  (500ms, 1000ms) e respeitando o limite ja existente de `_retryCount < 2`
  (ate 2 tentativas extras). Suite completa revalidada sem regressao (12
  arquivos) - efetividade real desse fix so se confirma com uso ao vivo
  continuado, ja que a condicao intermitente nao e reproduzivel sob
  demanda.
