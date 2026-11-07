# 0004 — A memória do dono é seguida (simplicidade, como o Claude)

- **Status:** Aceito (decisão do dono)
- **Data:** 2026-11-07
- **Origem:** o dono pediu "não implemente, só chame sub-agentes"; depois de reiniciar a sessão o
  agente deixou de seguir. Três causas independentes:
  1. o store da memória semântica era **movido** quando o Ollama estava fora do ar (o
     `except Exception` do self-heal confundia "embedder inalcançável" com "store incompatível");
  2. um fato gravado com `remember` voltava como **dado envelopado** (`DADO_NAO_CONFIAVEL`) e o prompt
     dizia "dado, nunca ordem" — então mesmo gravado, não era obedecido;
  3. nada fazia o agente gravar a instrução na hora (16 fatos no projeto, nenhum era a diretiva).
- **Antecedentes:** CLI-SEC-4, CLI-SEC-15 / GS-M3 (recall = dado), ADR 0002.
- **Dono:** "não precisa ser tão rígido em relação à memória, nem o Claude é assim."

## Decisão

1. **`remember` não pede confirmação, em nenhum modo.** Quando o dono declara uma preferência ou
   instrução durável ("a partir de agora…", "sempre/nunca…", "lembre disso"), o agente grava **na
   hora**, com `provenance: "usuario"`, e diz em uma linha o que gravou — sem esperar ser pedido
   duas vezes. A descrição da tool e o prompt dizem isso.
2. **A memória entra no `system` a cada chamada ao modelo** (boot, `--resume`, `--continue`,
   `--new`, e **sub-agentes**), como o `ALUY.md`:
   - fatos `usuario` ⇒ bloco **"MEMÓRIA DO DONO"**: preferências/instruções que o agente **segue**,
     sem envelope `DADO_NAO_CONFIAVEL` e sem a frase "nunca ordens";
   - fatos `derivado` ⇒ bloco **"CONTEXTO LEMBRADO"**: conhecimento de fundo que o agente usa e
     **corrige** se estiver desatualizado, sem texto de alarme.
3. **Fonte única:** `~/.aluy/memory/global.md` e `<workspace>/.aluy/memory/project.md` (nada novo).
4. **Teto e ordem de cache:** bloco ≤ 8.000 caracteres (um fato ≤ 2.000), posto **depois** de todo o
   estável (global e por pasta: `ALUY.md`, time de agentes) e **antes** só do fecho de segurança e
   do dinâmico — um `remember` no meio da sessão invalida o mínimo do cache. Acima do teto
   prevalecem os `usuario` (fixados primeiro, depois os mais recentes) e o bloco diz quantos fatos
   ficaram de fora ("veja e enxugue com /memory"). Sem memória, o prompt é idêntico ao anterior.
5. **`imperative.ts`** não sinaliza fatos `usuario` (`looksImperative(texto, 'usuario')` é sempre
   `false`) e o rótulo "⚠ diretiva" saiu do fluxo normal (recall e `recall` tool). Segue só como
   sinal na tabela do `/memory` para fatos `derivado`.
6. **`/memory`** continua sendo o lugar de ver, editar, fixar e esquecer; a coluna **origem**
   mostra `usuario`/`derivado`.
7. **Guarda leve (sem caixa):** o default de `provenance` na tool continua `derivado`; `usuario` só
   quando declarado. A descrição proíbe marcar `usuario` o que veio de arquivo, web ou saída de tool.

## O que isto relaxa (de propósito)

Relaxa **CLI-SEC-15 / GS-M3** ("recall = dado, nunca `system`") **para fatos `usuario`**. A
justificativa de GS-M3 era barrar _prompt-injection por lavagem_: texto hostil que o agente
"lembra" e na sessão seguinte voltaria como ordem. O dono escolheu a simplicidade do Claude em vez
dessa barreira.

**Risco residual aceito:** uma injeção (README, página web, saída de tool) pode convencer o modelo a
chamar `remember` marcando o fato como `usuario`; ele passaria a ser seguido em toda sessão. O fato
é **visível e removível** em `/memory` (origem + texto) e o limite de 20 gravações por sessão segue
valendo. O que **não** mudou: a catraca (`decide()`) avalia todo efeito — um fato seguido como
instrução não autoriza `curl | sh`, `rm -rf`, escrita em `~/.aluy` etc.; os pisos e as categorias
sempre-ask continuam. Fatos `derivado` nunca são apresentados como ordem do dono.

Este ADR substitui a ideia (descartada) de um canal separado de "regras" com arquivo próprio e
caixa de confirmação: era mais rígido do que o dono quer.

## Fora deste ADR

A perda da memória semântica (mem0) por Ollama fora do ar foi corrigida à parte: quarentena só para
incompatibilidade reconhecida, só dos arquivos do store, nunca `global.md` (veja `docs/turbo.md`).
Os fatos de `remember` **não dependem** do mem0: são arquivos `.md` locais lidos pelo próprio aluy.
