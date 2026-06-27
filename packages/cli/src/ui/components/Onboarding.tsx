// EST-0948 · spec §2.2 — <Onboarding>: sessão vazia (repouso).
//
// Estado de repouso quando há sessão sem mensagens. As 3 sugestões são DADO
// (config local/AGENT.md), não hardcoded. Sentence case, sem emoji. O nome vem da
// credencial (whoami).

import React from 'react';
import { Box } from 'ink';
import { Role } from '../theme/index.js';

export interface OnboardingProps {
  /** Nome do usuário (da credencial). Ausente ⇒ saudação genérica. */
  readonly name?: string;
  /** Sugestões (DADO de config). */
  readonly suggestions?: readonly string[];
}

const DEFAULT_SUGGESTIONS: readonly string[] = [
  '"explique a estrutura deste repo"',
  '"rode os testes e resuma as falhas"',
  '/help para comandos · /login conta · /quit',
];

export function Onboarding(props: OnboardingProps): React.ReactElement {
  const suggestions = props.suggestions ?? DEFAULT_SUGGESTIONS;
  return (
    <Box flexDirection="column">
      <Role name="fg">
        {props.name ? `bom te ver de novo, ${props.name}.` : 'bom te ver por aqui.'}
      </Role>
      <Role name="fgDim">
        eu leio e edito arquivos e rodo comandos aqui — sempre te mostrando o efeito exato antes.
      </Role>
      <Box paddingTop={1} flexDirection="column">
        <Role name="fgDim">experimente:</Role>
        {suggestions.map((s, i) => (
          <Role key={i} name="fgDim">
            {'  · '}
            {s}
          </Role>
        ))}
      </Box>
    </Box>
  );
}
