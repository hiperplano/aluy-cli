// `/upgrade` — a atualização EXPLÍCITA, pedida pelo dono.
//
// Ele viu a máquina anunciar "nova versão disponível" e disse o que faltava (02/09):
// "ele não deveria rodar o upgrade silenciosamente — mostrando que atualizou no final na
// barra do footer, ou dar a opção do /upgrade".
//
// Está certo, e o desconforto tem nome: trocar o binário de alguém sem pedir é uma decisão
// que não é nossa. O autoupdate continua existindo (com o aviso que passou a sair quando
// termina), mas agora há um caminho em que o dono MANDA e VÊ: pergunta o que há, mostra o
// que vai acontecer, executa, e diz o resultado.
//
// PURO até a borda: este módulo decide e formata; quem faz I/O é injetado. Assim o
// comportamento é testável sem tocar rede nem `npm i -g`.

import type { AutoUpdateDeps } from './auto-update.js';

/** O que o `/upgrade` pode responder. */
export type ResultadoUpgrade =
  | { readonly kind: 'ja-no-topo'; readonly instalada: string }
  | { readonly kind: 'nao-e-global' }
  | { readonly kind: 'sem-registro'; readonly motivo: string }
  | { readonly kind: 'instalado'; readonly de: string; readonly para: string }
  | { readonly kind: 'falhou'; readonly de: string; readonly para: string };

/** Linhas da nota, prontas para o `pushNote`. PURA. */
export function linhasDoUpgrade(r: ResultadoUpgrade): string[] {
  switch (r.kind) {
    case 'ja-no-topo':
      return [`já está na versão mais nova do canal (${r.instalada}). Nada a fazer.`];
    case 'nao-e-global':
      return [
        'esta instalação não veio de um `npm install -g` — atualizar daqui trocaria o',
        'binário errado. Rodando do repositório? use `npm run build`.',
      ];
    case 'sem-registro':
      return [
        `não consegui falar com o registro do npm: ${r.motivo}`,
        'tente de novo, ou atualize à mão: npm i -g @hiperplano/aluy-cli@latest',
      ];
    case 'instalado':
      return [
        `atualizado: ${r.de} → ${r.para}.`,
        'REINICIE o aluy para usar a versão nova (esta sessão segue na anterior).',
      ];
    case 'falhou':
      return [
        `a atualização para ${r.para} FALHOU (o \`npm install -g\` não completou).`,
        `você segue na ${r.de}. Tente à mão: npm i -g @hiperplano/aluy-cli@${r.para}`,
      ];
  }
}

/**
 * O que dizer ANTES de agir, quando há versão nova. Existe para o comando não ser mais um
 * efeito silencioso: o dono vê o que vai acontecer no instante em que manda.
 */
export function linhaDeInicio(de: string, para: string): string {
  return `baixando ${para} (você tem ${de}) — em segundo plano, sem interromper a sessão…`;
}

/** As dependências do `/upgrade`: as mesmas do autoupdate, mais o anúncio de início. */
export interface UpgradeDeps extends AutoUpdateDeps {
  /** Chamado quando há o que baixar, ANTES de baixar. */
  readonly aoComecar?: (de: string, para: string) => void;
}
