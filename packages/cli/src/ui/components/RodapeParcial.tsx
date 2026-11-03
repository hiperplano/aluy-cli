// RODAPÉ `parcial` — UMA linha com o essencial (modelo · caminho · janela · tokens · avisos).
// A decisão do que cabe é do módulo puro `session/rodape.ts`; aqui só a pintura.

import React from 'react';
import { Text } from 'ink';
import { Role } from '../theme/index.js';
import { segmentosParcial, type RodapeParcialEntrada } from '../../session/rodape.js';

export function RodapeParcial(props: RodapeParcialEntrada): React.ReactElement {
  const segs = segmentosParcial(props);
  return (
    <Text>
      {segs.map((s, i) => (
        <React.Fragment key={i}>
          {i > 0 && <Role name="fgDim">{' · '}</Role>}
          <Role name={s.role}>{s.texto}</Role>
        </React.Fragment>
      ))}
    </Text>
  );
}
