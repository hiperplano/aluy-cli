# Pausa por cota

Quando a cota do modelo acaba (janela de uso, teto semanal, saldo do provider ou um
rate-limit longo), o aluy **não mata o agente**. Ele **pausa**, guarda o trabalho e volta
sozinho quando a cota liberar — ou quando você mandar.

## O que conta como cota (e o que não conta)

| Situação                                                                                                                                              | O que o aluy faz                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Blip de rede, 5xx, 429 curto (até 60 s)                                                                                                               | **Retentativa** de sempre (`ALUY_RETRY`)                                                                                   |
| Janela de uso (5 h), teto semanal, orçamento, saldo zerado (`insufficient_quota`, HTTP 402, "credit balance is too low"), 429 com reset acima de 60 s | **Pausa**                                                                                                                  |
| 401, 403, 404, 400, 422, recusa de conteúdo                                                                                                           | **Falha** como sempre — esperar não conserta chave inválida nem modelo inexistente, e no BYO cada tentativa custa dinheiro |

## Quando a cota volta

O horário vem do próprio provider, na ordem: `Retry-After` → `x-ratelimit-reset-requests|tokens`
(OpenAI/OpenRouter, ex. `6m0s`) → `anthropic-ratelimit-*-reset` (RFC 3339) → o texto do erro
("try again in 6m0s"). Limitado a 8 dias.

Sem nenhuma dica, o aluy **sonda** com espaçamento crescente: 1, 2, 5, 10, 15 e depois a cada 30 min.
A sondagem é a **própria chamada pendente de um agente** (nunca uma chamada extra), **uma por vez**:
sem laço apertado, sem queimar dinheiro no BYO.

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
    a cota deve liberar às 18:40 (em 12min 04s) — retoma sozinho
    espera máxima restante: 5h 48min
    esperar (automático) · ↵ tentar agora · ctrl+g parar salvando · esc cancela o turno
```

- **Esperar** — é o padrão; não precisa fazer nada. Retoma sozinho.
- **`↵` (com o campo vazio) — tentar agora**: antecipa a sondagem.
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
3. se a cota ainda não voltou, pausa de novo — sem perder nada.

Fotos com mais de 14 dias são descartadas. Em `--anonymous` nada é gravado.

## Limites conhecidos

- Um episódio por sessão: não distingue provedores diferentes dentro da mesma sessão (sub-agente
  com outro tier/provider pausa junto com o resto).
- Trocar de sessão dentro da TUI (`/history`) durante uma pausa não migra a foto.
- A foto do agente principal só existe quando **ele** estava na chamada de modelo (ou ao parar
  salvando); se só um sub-agente pausou e o processo morreu à força, o principal volta pela
  transcrição normal da sessão e os filhos pausados são retomados em segundo plano.
