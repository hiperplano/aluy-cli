# Política de segurança

## Versões cobertas

O Aluy CLI é distribuído em release candidates contínuas. **Só a versão mais
recente recebe correção** — o canal `latest` do npm sempre aponta para ela.

```bash
npm install -g @hiperplano/aluy-cli   # ou, dentro da sessão: /upgrade
```

## Como relatar uma vulnerabilidade

**Não abra uma issue pública.** Uma issue é visível para todo mundo no instante
em que é criada, e isso entrega a falha antes de existir correção.

Use o canal privado do GitHub:

👉 **[Relatar vulnerabilidade](https://github.com/hiperplano/aluy-cli/security/advisories/new)**

Só os mantenedores enxergam o relato, e a discussão da correção acontece ali
mesmo, em privado, até o dia da publicação.

Ajuda muito se o relato trouxer: a versão (`aluy --version`), o sistema
operacional, o que acontece, e o menor caminho que reproduz. Se você não tiver
certeza de que é uma vulnerabilidade, relate assim mesmo — preferimos avaliar um
falso positivo a perder um verdadeiro.

Damos retorno em até **5 dias úteis**. Não há programa de recompensa.

## O que É uma vulnerabilidade aqui

O Aluy CLI roda na máquina do usuário, com os privilégios dele. A superfície que
nos interessa:

- **Contornar a catraca de permissão** — qualquer caminho em que um tool-call
  produza efeito sem passar pelo ponto único de interceptação.
- **Vazamento de credencial** — chave de provider ou token de conector indo parar
  em arquivo em claro, log, transcrição, export, mensagem de erro ou no corpo de
  uma requisição para onde não devia.
- **Escapar do workspace confinado** — ler ou escrever fora dos diretórios
  autorizados, inclusive por symlink ou caminho relativo.
- **Egress não autorizado** — requisição para um host que o usuário não
  configurou, ou anti-SSRF contornável.
- **Injeção via conteúdo lido** — conteúdo de arquivo, página ou resposta de MCP
  que consiga ser tratado como instrução do canal `system`.

## O que NÃO é vulnerabilidade

Estas são decisões de projeto, documentadas e intencionais:

- **`--yolo` aprovar tudo.** É o propósito da flag. O usuário opta explicitamente.
- **Um server MCP de terceiro ter acesso à máquina.** Servers MCP rodam com os
  privilégios do usuário e **sem sandbox** — está dito no README e no `--help`.
  A escolha de quem plugar é do usuário.
- **O agente executar um comando que o usuário aprovou.** A catraca perguntou; a
  resposta foi sim.
- **O modelo errar.** Resposta ruim de LLM é bug de qualidade, não falha de
  segurança — abra uma issue normal.

## O que o projeto faz do lado dele

- `gitleaks` na CI, em todo push e PR, bloqueando segredo versionado.
- *Secret scanning* e *push protection* do GitHub ativos no repositório.
- CodeQL analisando o código a cada mudança.
- Credencial **nunca** em texto em claro: keychain do SO, ou cofre cifrado
  (`~/.aluy/credentials.enc`, AES-256-GCM com chave derivada da máquina).
- O binário publicado não carrega credencial nenhuma; o bundle passa por um scan
  antes de ir ao npm.
