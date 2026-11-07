# Pausa por cota

Quando a cota do modelo acaba (janela de uso, teto semanal, saldo do provider ou um
rate-limit longo), o aluy **não mata o agente**. Ele **pausa**, guarda o trabalho e volta
sozinho quando a cota liberar — ou quando você mandar.

## O que conta como cota (e o que não conta)

| Situação                                                                                                                                              | O que o aluy faz                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Blip de rede, 5xx, 429 curto (até 60 s)                                                                                                               | **Retentativa** de sempre (`ALUY_RETRY`)                                                                                   |
| 429 cujo **corpo** diz cota/limite de uso (qualquer agente, mesmo sem header de reset)                                                                | **Pausa**                                                                                                                  |
| Janela de uso (5 h), teto semanal, orçamento, saldo zerado (`insufficient_quota`, HTTP 402, "credit balance is too low"), 429 com reset acima de 60 s | **Pausa**                                                                                                                  |
| 401, 403, 404, 400, 422, recusa de conteúdo                                                                                                           | **Falha** como sempre — esperar não conserta chave inválida nem modelo inexistente, e no BYO cada tentativa custa dinheiro |

## Quando a cota volta

O horário vem do próprio provider, na ordem: `Retry-After` → `x-ratelimit-reset-requests|tokens`
(OpenAI/OpenRouter, ex. `6m0s`) → `anthropic-ratelimit-*-reset` (RFC 3339) → o texto do erro
("try again in 6m0s"). Limitado a 8 dias.

Z.ai (`zai-coding`, GLM Coding Plan): a cota esgotada vem como HTTP 429 com `error.code` de negócio
(`1308` limite de uso, `1310`, `1304`, `1309`) e uma mensagem como "Usage limit reached for 5 hour.
Your limit will reset at 2026-11-03 05:00:00". O código e o texto são reconhecidos como cota, e o
horário é lido da mensagem. **Esse horário não traz fuso**: o aluy o interpreta como horário de
Pequim (UTC+8), o da Z.ai — suposição não verificada contra amostra real. Com fuso explícito
(`Z`, `+02:00`) vale o explícito; header (`Retry-After`) sempre vence. Horário que já passou
(fuso errado) é descartado e entra a escada de sondagem, nunca um laço de tentativas. Os códigos
`1302/1303/1305` seguem como rate-limit curto e `1301` (filtro de conteúdo) nunca é cota.

**O horário informado é o prazo mais tarde, não o mais cedo.** O plano pode ser resetado, o saldo
recarregado ou a janela liberada antes — por isso o aluy **sonda durante toda a pausa**, mesmo com
reset conhecido: 1, 2 e depois **a cada 5 min**, e também **no horário informado**
(`min(agora + degrau, reset)`). Um reset a 80 h não deixa o agente mudo por 80 h. O horário continua
na tela, só como informação, e um irmão que traga um reset mais distante não empurra a próxima
sondagem. Reset já vencido não puxa a sondagem para trás (nada de laço apertado): vale a escada.

Sem nenhuma dica de horário, a sondagem é mais esparsa: 1, 2, 5, 10, 15 e depois a cada 30 min.

A sondagem é a **própria chamada pendente de um agente** (mesmas mensagens, mesma chave de
idempotência — nunca uma chamada extra), **uma por vez** por sessão: sub-agentes esperam no portão e
não fazem fila no provider. Recusada (429 de cota) não custa tokens; aceita, ela É o trabalho que o
agente ia fazer de qualquer jeito — não há gasto além dele. Passou ⇒ todos os agentes continuam
sozinhos (as mensagens que você enfileirou entram normalmente) e aparece uma nota curta:
`cota voltou — continuando`.

## Comportamento por provider

Quatro desfechos: **pausa com horário** (volta sozinho no reset), **pausa por saldo** (só recarga
resolve: sondagem esparsa 5/10/20 min, teto de 30 min, depois "parar salvando"; a tela diz
"saldo esgotado — recarregue e pressione ↵"), **retry curto** (rate-limit de poucos segundos, tratado
pela retentativa de sempre; sub-agentes pausam) e **falha** (nunca pausa). "Verificado" = o formato
está na documentação oficial; "suposto" = veio de fórum/guia de terceiros ou da prática, sem
amostra oficial — vale conferir com uma resposta real.

| Provider                     | Sinal                                                                                                                                                              | Comportamento                                                                 | Fonte                                                                                        | Status                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `openai`                     | 429 `insufficient_quota` / `credit_balance_exhausted` / `organization_spend_limit_exceeded` / `project_spend_limit_exceeded` / `organization_usage_limit_exceeded` | pausa por saldo                                                               | [error codes](https://developers.openai.com/api/docs/guides/error-codes)                     | verificado                                                          |
| `openai`                     | 429 `rate_limit_exceeded` + `Retry-After` / `x-ratelimit-reset-*` (`1s`, `6m0s`)                                                                                   | retry curto; reset > 60 s pausa com horário                                   | mesma página                                                                                 | códigos verificados; exemplo de corpo suposto                       |
| `anthropic`                  | 402 `billing_error`                                                                                                                                                | pausa por saldo                                                               | [errors](https://platform.claude.com/docs/en/api/errors)                                     | verificado                                                          |
| `anthropic`                  | 429 `rate_limit_error` + `retry-after` + `anthropic-ratelimit-*-reset` (RFC 3339)                                                                                  | retry curto / pausa com horário                                               | [rate limits](https://platform.claude.com/docs/en/api/rate-limits)                           | verificado                                                          |
| `anthropic`                  | 429 `details.error_code: enforced_spend_limit_reached` ("You will regain access on AAAA-MM-DD at 00:00 UTC", sem `retry-after`)                                    | pausa com horário (lido da mensagem)                                          | mesma página                                                                                 | verificado                                                          |
| `anthropic`                  | 400 "You have reached your specified API usage limits…" (limite de gasto próprio)                                                                                  | pausa com horário se a mensagem trouxer a data                                | mesma página                                                                                 | início da mensagem verificado; frase da data suposta igual à do 429 |
| `anthropic`                  | 400 "Your credit balance is too low…"                                                                                                                              | pausa por saldo                                                               | prática (a doc atual só cita 402)                                                            | suposto                                                             |
| `deepseek`                   | 402 "Insufficient Balance"                                                                                                                                         | pausa por saldo                                                               | [error codes](https://api-docs.deepseek.com/quick_start/error_codes)                         | verificado                                                          |
| `deepseek`                   | 429 Rate Limit Reached                                                                                                                                             | retry curto                                                                   | mesma página                                                                                 | verificado                                                          |
| `google`                     | 429 `RESOURCE_EXHAUSTED` + `details[].RetryInfo.retryDelay` (`27s`), corpo possivelmente embrulhado em array                                                       | retry curto; `retryDelay` > 60 s pausa com horário                            | [troubleshooting](https://aistudio.google.com/docs/troubleshooting) (só cita o 429) + fóruns | formato do corpo suposto                                            |
| `google`                     | 429 com `quotaId …PerDay…` (cota diária)                                                                                                                           | pausa; `retryDelay` < 60 s é ignorado (já veio enganoso) → escada de sondagem | fóruns do Google AI                                                                          | suposto                                                             |
| `groq`                       | 429 + `retry-after` + `x-ratelimit-reset-requests/tokens` (`2m59.56s`, `7.66s`)                                                                                    | retry curto / pausa com horário                                               | [rate limits](https://console.groq.com/docs/rate-limits)                                     | verificado                                                          |
| `groq`                       | 429 "…on tokens per day (TPD)… Please try again in 9m38.4s"                                                                                                        | pausa com horário                                                             | issue pública de terceiros                                                                   | corpo suposto                                                       |
| `mistral`                    | 429 + `Retry-After`                                                                                                                                                | retry curto / pausa com horário                                               | [error glossary](https://docs.mistral.ai/resources/error-glossary.md)                        | verificado                                                          |
| `mistral`                    | 402 (saldo zerado, limite de gasto, pagamento falho)                                                                                                               | pausa por saldo                                                               | mesma página                                                                                 | verificado                                                          |
| `openrouter`                 | 402 créditos insuficientes                                                                                                                                         | pausa por saldo                                                               | [errors](https://openrouter.ai/docs/api-reference/errors)                                    | verificado                                                          |
| `openrouter`                 | 429 + `Retry-After` (segundos)                                                                                                                                     | retry curto / pausa com horário                                               | mesma página                                                                                 | verificado                                                          |
| `openrouter`                 | 429 + `X-RateLimit-Reset` (a doc não diz a unidade; tratamos 13 dígitos = ms e 10 = s) e "free-models-per-day"                                                     | pausa com horário                                                             | [limits](https://openrouter.ai/docs/api/reference/limits)                                    | unidade e texto supostos                                            |
| `xai`                        | 429 rate limit                                                                                                                                                     | retry curto                                                                   | [rate limits](https://docs.x.ai/docs/key-information/consumption-and-rate-limits)            | verificado (só o 429)                                               |
| `xai`                        | 403 "…used all available credits or reached its monthly spending limit…"                                                                                           | pausa por saldo                                                               | guias de terceiros                                                                           | suposto                                                             |
| `ollama` (local, loopback)   | qualquer 429/503                                                                                                                                                   | **nunca pausa** (não há cota local)                                           | decisão de design                                                                            | —                                                                   |
| `ollama` (nuvem, ollama.com) | 429 com texto de limite semanal/de sessão                                                                                                                          | pausa                                                                         | nenhuma doc oficial do erro                                                                  | suposto (casado por texto)                                          |
| `zai` / `zai-coding`         | 429 `1113` (saldo/pacote)                                                                                                                                          | pausa por saldo                                                               | [api-code](https://docs.z.ai/api-reference/api-code)                                         | verificado                                                          |
| `zai-coding`                 | 429 `1308` (janela, "resets at"), `1310` (semanal/mensal), `1316–1321` (janela + saldo/limite de gasto)                                                            | pausa com horário (da mensagem, UTC+8 se sem fuso)                            | mesma página                                                                                 | códigos verificados; formato da data suposto                        |
| `zai-coding`                 | 429 `1309` (plano expirado), `1313` (Fair Usage Policy)                                                                                                            | pausa por saldo (renovar/pedir ao suporte)                                    | mesma página                                                                                 | verificado                                                          |
| `zai` / `zai-coding`         | 429 `1302` (rate limit), `1305` (sobrecarga)                                                                                                                       | retry curto                                                                   | mesma página                                                                                 | verificado                                                          |
| `zai` / `zai-coding`         | `1301` (conteúdo sinalizado), `1311` (plano sem o modelo), `1315`                                                                                                  | **falha**                                                                     | mesma página                                                                                 | verificado                                                          |
| todos                        | 401, 403 sem texto de saldo, 404, 400/422 sem texto de cota, 5xx                                                                                                   | **falha** / retry de sempre                                                   | —                                                                                            | —                                                                   |

Formatos de horário aceitos: `Retry-After` (segundos ou HTTP-date), duração `6m0s`/`2m59.56s`/`27s`,
RFC 3339, epoch em segundos (10 dígitos) ou ms (13 dígitos), `retryDelay` do Google e datas
absolutas no texto ("will reset at …", "regain access on … at 00:00 UTC").

## Pausa compartilhada

A sessão fala com um provider, então a pausa é **da sessão**: quando um agente bate na cota, os
irmãos (principal e sub-agentes) esperam no mesmo portão em vez de martelar o provider. Quando uma
sondagem passa, todos são liberados juntos.

O relógio de inatividade dos sub-agentes é suspenso durante a pausa (esperar não é travar), e o pai
vê o filho como **pausado**, não como falho — o resultado do `spawn_agent` diz isso explicitamente
("PAUSADO por cota esgotada — retomável, não é falha"), para o modelo não refazer o trabalho.

## O que você vê e as escolhas

```
◷ pausado — cota esgotada (janela de uso esgotada)
    agentes pausados: principal, pesquisa-rust — o trabalho está guardado, nada foi perdido
    tentando de novo a cada ~5 min — próxima checagem em 3min 20s; retoma sozinho se a cota voltar antes
    limite informado pelo provedor: 18:40 (em 12min 04s)
    espera máxima restante: 5h 48min
    esperar (automático) · ↵ tentar agora · ctrl+g parar salvando · esc cancela o turno
```

- **Esperar** — é o padrão; não precisa fazer nada. Retoma sozinho.
- **`↵` (com o campo vazio) — tentar agora**: antecipa a sondagem. A linha mostra na hora
  `verificando a cota…` e, se o provedor recusar, `ainda sem cota · última tentativa 02:47 ·
próxima em ~5 min · ↵ tentar agora` (só a linha viva muda; nada novo no transcript a cada
  sondagem). `↵` com uma sondagem já em voo não faz nada (nunca empilha: uma chamada por vez, seja
  o agente principal ou um sub-agente o sondador). O `↵` **não reinicia a escada**: um `↵`
  recusado conta como sondagem e avança o degrau (1 → 2 → 5 min), então apertar repetidamente
  nunca vira martelada.

No rodapé, a linha única fica `pausado — cota esgotada · tentando de novo a cada ~5 min · limite informado: 10/11 10:29 · ↵ tentar agora · ctrl+g parar salvando` (em terminal estreito perde primeiro as teclas extras, depois o limite).

- **`Ctrl+G` — parar salvando**: encerra a espera, salva o trabalho e devolve o prompt.
- **`Esc` / `Ctrl+C`** seguem sendo o freio de sempre: cancelam o turno (a pausa é interrompível).

Digitar continua funcionando durante a pausa (a mensagem entra na fila como de costume).

## Configuração

| Variável              | Efeito                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| `ALUY_QUOTA_PAUSE`    | `off` (ou `0`/`false`) volta ao comportamento antigo: cota esgotada falha. Padrão: ligado         |
| `ALUY_QUOTA_MAX_WAIT` | espera total máxima por pausa. Número = minutos; aceita `90m`, `6h`, `2d`. Padrão `6h`, teto `7d` |

Em execução sem supervisão (headless, `aluy -p`, serviços) o padrão já é esperar até 6 h; passado o
limite, vira "parar salvando" automático e o processo termina com o trabalho salvo. `aluy config`
mostra os valores efetivos.

## Retomar depois

Cada pausa grava uma foto em `~/.aluy/pausas/<id-da-sessão>.json` (`0600`, segredos redigidos como
no journal): o histórico de cada agente pausado e o perfil dos sub-agentes. Ela é regravada quando
entra um novo agente na pausa e **apagada** quando a cota volta ou a retomada conclui.

Se o processo fechou (ou você usou `Ctrl+G`):

```bash
aluy --continue            # última sessão deste diretório
aluy --resume <id>         # uma sessão específica
```

Ao reabrir, o aluy encontra a foto e:

1. **sub-agentes pausados** continuam do histórico guardado, em segundo plano; o resultado chega
   como dado, pelo mesmo canal dos sub-agentes desacoplados;
2. o **agente principal**, se ele mesmo estava pausado, retoma o turno de onde parou;
3. se a cota ainda não voltou, pausa de novo — sem perder nada — e sonda periodicamente do mesmo jeito (a chamada da retomada é a primeira sondagem).

Fotos com mais de 14 dias são descartadas. Em `--anonymous` nada é gravado.

## Limites conhecidos

- Um episódio por sessão: não distingue provedores diferentes dentro da mesma sessão (sub-agente
  com outro tier/provider pausa junto com o resto).
- Trocar de sessão dentro da TUI (`/history`) durante uma pausa não migra a foto.
- A foto do agente principal só existe quando **ele** estava na chamada de modelo (ou ao parar
  salvando); se só um sub-agente pausou e o processo morreu à força, o principal volta pela
  transcrição normal da sessão e os filhos pausados são retomados em segundo plano.
