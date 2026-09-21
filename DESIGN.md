# Design System — DeepBlack

> Fonte da verdade para decisões visuais deste projeto. Toda tela/componente novo deve
> reutilizar estes tokens em vez de introduzir valores soltos. Ver metodologia completa
> na skill `vt-designer`.

Contexto: DeepBlack é uma bridge/serviço local (Node.js, sem framework de frontend).
A interface é um painel de operação/monitoramento (uptime, contas, sessões, logs) —
não um produto voltado ao consumidor. A direção visual segue a estética do dashboard
de terminal já existente (`cli/dashboard.js`, paleta ANSI em `cli/ui.js`): fundo escuro,
alto contraste, tipografia monoespaçada, badges de status coloridos.

## Cor

Paleta espelha a paleta ANSI já em uso no dashboard de terminal (`cli/ui.js`), para que
a versão web pareça a mesma ferramenta, não um produto separado. Dark-only (não há modo
claro — é uma ferramenta de operador, sempre em tema escuro).

| Token | Papel | Dark (único tema) |
|---|---|---|
| `background` | Fundo base da página | `#0a0e14` |
| `surface` | Fundo de cards/painéis | `#111722` |
| `surface-raised` | Painel elevado (modais, header fixo) | `#161d2b` |
| `foreground` | Texto principal | `#e6e9ef` |
| `primary` | Ação principal, aba ativa, marca | `#22d3ee` (cyan) |
| `secondary` | Elementos secundários de destaque | `#a78bfa` (magenta/roxo — espelha `magenta` do DeepHat/GPU) |
| `success` | Status online/válido | `#34d399` (verde) |
| `warning` | Status de atenção | `#fbbf24` (amarelo) |
| `destructive` | Status offline/erro/ação destrutiva | `#f87171` (vermelho) |
| `muted` | Texto secundário, dim | `#6b7280` |
| `border` | Bordas e divisores | `#1f2937` |
| `ring` | Foco por teclado | `#22d3ee` |

## Tipografia

Uma única família — monoespaçada — para manter a identidade de "terminal/console" em
toda a UI, inclusive títulos. Não há papel de "display" separado; hierarquia vem de
peso/tamanho/cor, não de troca de fonte.

- **Única família:** `'JetBrains Mono', 'Cascadia Code', ui-monospace, 'SFMono-Regular', Consolas, monospace` — usada em: todo o texto (títulos, corpo, tabelas, badges).

| Papel | Tamanho | Peso | Line-height |
|---|---|---|---|
| H1 (título do painel) | 18px | 700 | 1.3 |
| H2 (título de card/seção) | 13px (uppercase, letter-spacing 0.04em) | 600 | 1.4 |
| Body | 13px | 400 | 1.6 |
| Small (metadados, timestamps) | 11px | 400 | 1.5 |

## Espaçamento

Escala base `4px`: `4 · 8 · 12 · 16 · 24 · 32 · 48 · 64`

## Raio

| Token | Valor | Uso |
|---|---|---|
| `sm` | 4px | Badges, botões, inputs |
| `md` | 8px | Cards, painéis |
| `lg` | 12px | Modais/painéis grandes (não usado ainda) |

## Sombra

Painel é essencialmente "flat" (linhas/bordas fazem a separação, não sombra) — comum em
dashboards densos em dados para evitar ruído visual. Uma única sombra sutil para o
header fixo, nada mais.

| Token | Uso |
|---|---|
| `sm` | `0 1px 0 rgba(0,0,0,0.4)` — sombra do header fixo ao rolar |

## Movimento

- Duração padrão: `150ms`
- Easing padrão: `ease-out`
- Uso: apenas transições de hover/foco e troca de aba. Sem animação decorativa
  (é uma ferramenta de leitura rápida de status, não uma vitrine).

## Stack e fonte de componentes

- Stack: HTML + CSS + JS puro (sem framework), servido estaticamente pelo próprio
  `src/server.js` em `GET /dashboard`. Sem shadcn/ui — projeto não usa React/Tailwind.
- Componentes construídos à mão seguindo os tokens acima (fase 2b da skill
  `vt-designer`): badge de status, tabela densa, card de métrica com barra de progresso.

## Histórico de decisões

- 2026-09-18 — Sistema criado para o dashboard web (`GET /dashboard`), espelhando a
  paleta ANSI do dashboard de terminal (`cli/ui.js`) para manter uma identidade única
  entre as duas interfaces da mesma ferramenta.
