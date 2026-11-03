# Investigação: por que o prompt tem ~33k tokens

Medido pelo coordenador: sessão nova, pasta quase vazia, backend local (zai-coding / glm-5.3,
tier `custom`, perfil `turbo`), 5 servers MCP, mensagem "responda apenas: ok" => ~33,2k
tokens de prompt, 58% de cache, 11–14 s por chamada.

Este documento não muda comportamento. O script `scripts/medir-prompt.mjs` reproduz a medição
sem enviar nada ao modelo.

## 1. Achado principal: as tools são enviadas DUAS vezes

O request tem duas cópias do catálogo de tools:

1. **Texto no `system`**: `buildSystemPrompt` (`packages/cli-core/src/agent/context.ts`)
   chama `renderOneToolDoc` para toda tool e imprime "Ferramentas disponíveis:" com descrição
   e parâmetros. Isso acontece sempre, mesmo no modo nativo.
2. **Campo `tools` da API** (JSON schema de função): o controller
   (`controller.ts` ~2241, `onToolsReady`) cria `NativeToolsCapability` com
   `toToolFunctionSchemas(allTools)`. O `openai-adapter.ts` (~162) põe isso em `body.tools`
   quando o modelo suporta (o default é tentar, só desliga no 422 `TOOLS_UNSUPPORTED`).

Não há nenhum ponto em que o modo nativo suprima o texto. Só a segunda cópia é de fato usada
pelo modelo para chamar tools; a primeira existe por causa do protocolo de texto
(`<<<ALUY_TOOL_CALL`, fallback #99), que o `system` continua ensinando mesmo no modo nativo.

## 2. O que entra em um request

Ordem do `system` (`buildSystemPrompt`):

1. Cabeçalho + "Você AGE, não instrui" + REGRA DE AÇÃO + MAPA DE CAPACIDADES
2. Formato do bloco de tool-call + diretório de sessão (`change_dir`)
3. SERVERS MCP (`aluy mcp add`) + AGENDAMENTO (`aluy cron`)
4. Runtime (provider/modelo, só backend local) + raízes autorizadas
5. Memória de agente (só se `recall` registrado)
6. "Ferramentas disponíveis:" => texto de todas as tools (nativas, web, memória, monitor,
   rooms, `session_command`, `spawn_agent`/`agents_*`, MCP)
7. Instruções de projeto (ALUY.md/AGENT.md, até 12k chars; **ausente** na pasta vazia)
8. Nota de agentes disponíveis (**ausente**: nenhum agente em `~/.aluy/agents`)
9. Regra PLANO PRIMEIRO / DECOMPOR EM SUB-AGENTES (entra se `update_plan`/`spawn_agent` existem)
10. DELEGAÇÃO É O PADRÃO (só com agentes; **ausente** aqui)
11. Comandos de sessão (`buildSessionCommandsNote`, lista dos slash commands)
12. Few-shot do tier fraco (`isWeakTier`; `custom` é fraco: sim)
13. REGRA DE SEGURANÇA

Fora do `system`: mensagens do histórico; recall de memória entra como itens de histórico
_antes_ do `goal` (`loop.ts` ~968: `[...attachments, ...recalled, goal]`), com piso de score;
nesta sessão, 0 a poucos fatos. Estado de `todo` e hora não entram no `system`.
Campos do request: `messages`, `tools`, `tool_choice:auto`, `max_tokens`, `stream_options`.

## 3. Medição

Método: `node scripts/medir-prompt.mjs` monta as mesmas tools do controller, conecta nos
servers de `~/.aluy/mcp.json` pelo `setupMcp` real, usa `buildMessages` e
`toToolFunctionSchemas` reais. Contagem de tokens é **estimativa chars/3,5** (não há
tokenizer real como dependência). Ablações (remover um bloco e subtrair) dão cada seção.

Limitação importante: o server `rpa` (uvx, instalado de git) **não conectou** na minha máquina,
então suas tools não estão na conta. As outras 4 servers conectaram (49 tools MCP). Total
medido: 79 tools. O estimado (35,4k) ficou acima do real (33,2k) mesmo sem o `rpa`, ou seja, o
fator 3,5 chars/token superestima aqui (fator real provavelmente ~3,8 para este conteúdo,
mas sem o `rpa` isso é incerto). Leia os números como proporção, não como valor exato.

### Tabela (estimado, chars/3,5; % sobre 35,4k)

| Seção                                                   |         Tokens |        % | Estável entre iterações? | Notas                                       |
| ------------------------------------------------------- | -------------: | -------: | ------------------------ | ------------------------------------------- |
| `system`: texto das tools nativas (30)                  |          6.068 |     17,1 | sim                      | duplica o campo `tools`                     |
| `system`: texto MCP playwright (25)                     |          3.834 |     10,8 | sim                      | idem                                        |
| `system`: texto MCP filesystem (14)                     |          2.076 |      5,9 | sim                      | idem                                        |
| `system`: texto MCP memory (9)                          |            726 |      2,0 | sim                      | idem                                        |
| `system`: texto MCP sequential-thinking (1)             |            532 |      1,5 | sim                      | idem                                        |
| **Subtotal texto das tools**                            |     **13.234** | **37,3** |                          | inclui ~230 da regra PLANO/DECOMPOR         |
| `tools` JSON: nativas (30)                              |          7.852 |     22,2 | sim                      |                                             |
| `tools` JSON: playwright (25)                           |          6.255 |     17,6 | sim                      | maior bloco único                           |
| `tools` JSON: filesystem (14)                           |          2.866 |      8,1 | sim                      |                                             |
| `tools` JSON: memory (9)                                |          1.606 |      4,5 | sim                      |                                             |
| `tools` JSON: sequential-thinking (1)                   |            687 |      1,9 | sim                      |                                             |
| **Subtotal campo `tools`**                              |     **19.264** | **54,3** |                          |                                             |
| Comandos de sessão (`/cycle`...)                        |          1.367 |      3,9 | sim                      |                                             |
| Few-shot tier fraco (3 exemplos)                        |            377 |      1,1 | sim                      |                                             |
| Regra PLANO + DECOMPOR                                  |           ~229 |      0,6 | sim                      | já contado no texto das tools               |
| DELEGAÇÃO É O PADRÃO                                    | 0 (seria ~134) |        0 | sim                      | só com agentes                              |
| Runtime + raízes                                        |            136 |      0,4 | **por sessão/pasta**     | ver seção 4                                 |
| Regras fixas (AGE, MAPA, formato, MCP, cron, segurança) |         ~1.070 |      3,0 | sim                      |                                             |
| Instruções de projeto                                   |              0 |        0 | sim                      | pasta vazia (teto 12k chars = ~3,4k tokens) |
| Recall                                                  |             ~0 |        0 | não (por mensagem)       | vai no histórico, antes do goal             |
| Mensagem do usuário                                     |              6 |        0 | n/a                      |                                             |
| **Total estimado**                                      |     **35.448** |      100 |                          | real medido: 33.200                         |

Por origem (texto + campo `tools`, em tokens): nativas ~13.900 (39%); playwright ~10.100 (28%);
filesystem ~4.900 (14%); memory ~2.300 (6,5%); sequential-thinking ~1.200 (3,4%). MCP total
(sem `rpa`) ~18.500 (52%).

Nativas por grupo (só schema JSON): `NATIVE_TOOLS` (15) 3.444; `spawn_agent`+`agents_*` 1.993
(`spawn_agent` sozinho 1.430); rooms (2) 695; monitor (4) 622; memória (2) 521;
`session_command` 338; web (2) 229.

Maiores schemas individuais: `spawn_agent` 1.430, `sequentialthinking` 687, `perguntar` 529,
`browser_take_screenshot` 475, `room_read` 474, `update_plan` 422.

Conclusão da conta: com as tools em duas cópias, ~92% do prompt é catálogo de tools e
~8% é prosa de sistema.

## 4. A figura de 58% de cache

Hipóteses, da mais para a menos provável. Não confirmei com chamada ao provider (ver
"Incertezas").

- **Ordem das tools MCP é não determinística.** O boot MCP é desacoplado: cada server anexa
  suas tools quando o handshake termina (`refreshMcpTools` => `replaceMcpTools`, `registry.ts`
  é um `Map` em ordem de inserção). A ordem entre servers depende de qual conectou primeiro,
  então pode mudar entre sessões. Isso muda o texto do `system` (a partir de "Ferramentas
  disponíveis") e o array `tools`. Prefix cache casa byte a byte do início: uma troca de ordem
  no meio invalida tudo daí em diante. Também: uma primeira mensagem enviada antes de todos os
  servers conectarem sai com um catálogo menor, e o catálogo cresce depois (re-anúncio via
  `announceToolsChanged`), invalidando o prefixo. Verificar isso no código é fácil; o efeito
  medido precisa de dois requests reais.
- **Dinâmico antes do estável no `system`.** Runtime (provider/modelo) e raízes (cwd,
  `/add-dir`) estão no _início_ do `system` (~1,2k tokens do começo), antes das ~13k tokens de
  tools. Trocar de pasta, de `/model` ou de `/add-dir` invalida todo o resto. Na mesma sessão
  e mesmo diretório isso é estável, então só explica quebra entre sessões em pastas distintas.
- **Onde o provider põe as tools.** Em templates de chat do tipo GLM, o bloco de tools costuma
  ser renderizado no começo do turno de sistema, não no fim do JSON. Se for o caso, o prefixo
  cacheável é "tools + system", e 58% (~19k) bate com o tamanho do campo `tools`
  (~19k estimado, ~17–18k provável real): ou seja, o cache pode estar pegando só as tools e
  errando o `system` por causa do ponto acima. Hipótese, não fato.
- **Dentro de uma sessão (iterações 2+)** o `system` é idêntico (nada dinâmico por chamada:
  sem timestamp, sem todo, sem tier resolvido por call no texto, exceto a troca de `/model`),
  e o histórico só cresce no fim. A ordem é cache-friendly para prefix caching automático. O
  custo "toda iteração paga de novo" é, em boa parte, prefill de um prefixo que _deveria_ estar
  em cache, mas o primeiro ponto de quebra (acima) decide quanto realmente acerta. O `cache_control`
  explícito (`cache-breakpoint.ts`) só ajuda OpenRouter/Anthropic, não z.ai.
- Há um ponto de risco a mais, não medido: `parallel_tool_calls` e `tool_choice` são fixos,
  então não variam.

## 5. Propostas, ordenadas por (tokens economizados × risco)

Economias em tokens estimados (multiplicar por ~0,9 para aproximar do real).

| #   | Proposta                                                                                                                                                                                             |                                                                            Economia | Risco       | Notas                                                                                                                                                                                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------: | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Não renderizar o texto das tools no `system` quando o nativo está ativo (manter só a prosa de regras; manter texto como fallback se `degradeOnUnsupported` desligar o nativo)                        |                                                                    **~13,2k (37%)** | baixo/médio | Precisa de uma flag por chamada: o `model-caller` já sabe `shouldSendTools()`. Modelos fracos podem depender do texto; validar com uma suíte de tarefas. O trecho "Use EXATAMENTE os marcadores <<<ALUY_TOOL_CALL" também deveria sumir no modo nativo (hoje contradiz o campo `tools`). |
| 2   | Tools MCP diferidas: enviar só uma linha por tool (ou por server) e expor um `mcp_search`/`mcp_load` que carrega o schema sob demanda (como as deferred tools do Claude Code)                        | **~11k** (MCP é 18,5k com duplicação, ~11,4k só como schema; sobra ~0,8k de índice) | médio       | Cada carga altera o campo `tools` e quebra o cache dali em diante, então carregar tools _no fim_ da lista. Modelo fraco pode não descobrir a tool; mitigar com o índice com nomes. Playwright sozinho vale ~6k.                                                                          |
| 3   | Ordem determinística: ordenar tools MCP por (server, nome) e aguardar o boot MCP terminar (ou ao menos congelar o catálogo) antes da primeira chamada                                                |                       cache: de 58% para provavelmente 85–95% nas sessões seguintes | baixo       | Sem custo de tokens. É o item de maior retorno em latência por token.                                                                                                                                                                                                                    |
| 4   | Mover runtime e raízes do início para o fim do `system` (ou para a 1ª mensagem do usuário)                                                                                                           |                                           cache: ganho nas trocas de pasta/`/model` | baixo       | Mudar texto pode alterar o comportamento de "qual modelo você é?" (depende de ordem, mas é pouco provável).                                                                                                                                                                              |
| 5   | Habilitar servers MCP pesados só sob demanda (ex.: playwright só quando o pedido envolve navegador) ou por perfil                                                                                    |                            ~6,3k por server pesado (playwright ~10k com duplicação) | baixo/médio | Já existe configuração por server; falta o gatilho/UX.                                                                                                                                                                                                                                   |
| 6   | Enxugar descrições/schemas das tools nativas: `spawn_agent` (1.430), `perguntar` (529), `update_plan` (422), `room_*` (695), `monitor_*` (622); mover rooms/monitor/`session_command` para diferidas |                                                                               ~2–4k | baixo       | Rooms e monitor raramente são necessários; estão em todo request.                                                                                                                                                                                                                        |
| 7   | Comandos de sessão (1,4k): reduzir a uma frase + o agente consulta `capabilities`/`session_command` sob demanda                                                                                      |                                                                               ~1,2k | baixo       | ADR-0127 pediu o auto-conhecimento; `capabilities` já existe.                                                                                                                                                                                                                            |
| 8   | Minimizar schemas MCP: remover `$schema`, `additionalProperties`, defaults e descrições longas de propriedade ao serializar                                                                          |                                                               ~1–2k (10–15% do MCP) | baixo       | Fazer só no JSON enviado, não na validação.                                                                                                                                                                                                                                              |
| 9   | Few-shot do tier fraco (377) e PLANO/DECOMPOR (229)                                                                                                                                                  |                                                                               ~0,6k | médio       | São pequenos e foram adicionados para corrigir comportamento; manter.                                                                                                                                                                                                                    |

Combinações realistas (sobre os 33,2k reais; fator 0,9):

- Só #1 + #3: ~21k tokens, e muito mais cache. Mudança pequena e localizada.
- #1 + #2 (+#3): ~10–11k tokens (-67%), com maior parte em cache.
- #1 + #2 + #5 + #6: ~7k.

Impacto na latência (estimativa, não medida): prefill cresce aproximadamente linear com os
tokens _não_ cacheados. Hoje ~42% de 33,2k (~14k) são reprocessados a cada chamada. Só com #3
esse número pode cair para 2–5k. Com #1 + #2 o prompt total cai para ~10k e o não cacheado
para ~1–3k. Como a geração de "ok" é curta, uma fração grande dos 11–14 s deve ser prefill e
fila do provider; esperar redução forte, mas o número depende do provider e precisa de teste.

Ordem recomendada: #3 (grátis), #1, #7/#8/#6 (baixo risco), depois #2 e #5.

## 6. Incertezas

- Tokens são estimativa chars/3,5. O `rpa` (uvx de git) não conectou aqui, então ficou fora da
  contagem; o dono deve rodar o script na máquina dele para incluí-lo (`--calibrar 33200`
  imprime o fator).
- Não fiz chamada ao provider. Para confirmar as hipóteses de cache: rode o script com
  `--dump a.json` duas vezes (sessões separadas) e compare `diff` dos dois arquivos; o primeiro
  byte que difere é o ponto de quebra de prefixo. Se forem idênticos e o cache ainda for 58%,
  o provider cacheia por blocos/ordem própria (tools antes do `system`).
- Que o campo `tools` realmente sai na máquina do dono depende de `supports_tools` não ser
  `false` e de não ter havido 422. O total real (33,2k) é compatível com as duas cópias
  (texto-só ~16k, ou campo-só ~19k, não chegam em 33k).
- A hipótese sobre a ordem das tools MCP é inferida do código (boot assíncrono + `Map`), não
  observada.
