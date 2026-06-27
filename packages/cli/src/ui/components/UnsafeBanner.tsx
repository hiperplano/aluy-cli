// EST-0948 · ⚠ aviso de MODO YOLO — exigência da decisão do Tiago.
//
// Quando a sessão roda com `--yolo` (BYPASS TOTAL da catraca; EST-0959 renomeou a
// flag de `--unsafe` — o modo INTERNO continua `'unsafe'`), a TUI mostra um aviso
// VERMELHO GRITANTE, persistente enquanto a sessão estiver em unsafe. Deixa
// inequívoco que a aprovação está DESLIGADA e o agente roda QUALQUER comando sem
// perguntar. Cor SÓ pelo papel `danger` do DS (nunca cor crua). NÃO persiste entre
// sessões (é só estado de render; o `--yolo` é por sessão). a11y: glifo `⚠` +
// palavra `YOLO` (não depende só de cor).

import React from 'react';
import { Box } from 'ink';
import { Glyph, Role } from '../theme/index.js';
import { useI18n } from '../../i18n/index.js';

export interface UnsafeBannerProps {
  /** Largura do terminal (responsivo: telas estreitas encurtam a frase). */
  readonly columns?: number;
}

export function UnsafeBanner(props: UnsafeBannerProps): React.ReactElement {
  const { t } = useI18n();
  const narrow = (props.columns ?? 80) < 60;
  // EST-0989 — a frase do banner vem do catálogo i18n (fallback en→pt-BR); o glifo
  // `⚠` e o papel `danger` são do DS (tema), não do idioma.
  const msg = narrow ? t('banner.yolo.narrow') : t('banner.yolo');
  return (
    <Box>
      <Glyph name="ask" role="danger" />
      <Role name="danger"> {msg}</Role>
    </Box>
  );
}
