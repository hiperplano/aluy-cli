// EST-0948 · spec §2.11 — <BrokerError>: erro de broker/rede com backoff/retry.
//
// Falha de INFRAESTRUTURA (broker/rede), não de tool. O `◍` + a palavra `broker`
// sinalizam ONDE falhou (HG-2: "todo modelo passa pelo broker"). Mostra o status,
// o backoff (contagem de retry) e ações. NUNCA vaza provider/modelo (diz "broker
// 503", nunca "OpenAI 503") — o componente só recebe status+mensagem neutra.

import React from 'react';
import { Box } from 'ink';
import { Glyph, Role, useTheme } from '../theme/index.js';

export interface BrokerErrorProps {
  readonly status?: number;
  readonly message: string;
  /**
   * EST-0942 — TÍTULO classificado (`◍ <headline>`). "broker indisponível" SÓ quando
   * o broker não respondeu; auth ⇒ "sem credencial"/"credencial recusada"; 402 ⇒
   * "sem crédito"; 502 ⇒ "provedor do tier falhou". Ausente ⇒ default "broker
   * indisponível". Ignorado durante o backoff (`retrying`): aí o título é "tentando
   * de novo" (o CLI já está retentando — a causa específica não muda a afordância).
   */
  readonly headline?: string;
  readonly attempt?: number;
  readonly maxAttempts?: number;
  /** Segundos até o próximo retry (backoff visível). */
  readonly retryInSeconds?: number;
  /**
   * EST-0948 (auto-retry) — `true` enquanto o CLI está em BACKOFF ATIVO (vai retentar
   * sozinho): mostra o countdown e a afordância "esc cancelar" (não há `r` durante o
   * backoff — ele já está retentando). `false`/ausente ⇒ erro TERMINAL manual: a
   * afordância completa "r tentar agora · esc cancelar".
   */
  readonly retrying?: boolean;
  /**
   * F52 — backend ativo quando o erro ocorreu. "broker" (default) preserva o
   * comportamento atual; "local" troca o headline default p/ "provider local
   * indisponível" e a palavra "broker" some das mensagens. NUNCA vaza nome de
   * provider concreto — "provider local" é genérico, OK.
   */
  readonly backend?: 'broker' | 'local';
}

export function BrokerError(props: BrokerErrorProps): React.ReactElement {
  const theme = useTheme();
  // EST-0948 — durante o backoff ativo, o título anuncia que ESTÁ retentando (não
  // "indisponível" estático); a afordância é só `esc` (o CLI já cuida do `r`).
  // EST-0942 — fora do backoff, o título é a CAUSA classificada (`props.headline`):
  // "sem credencial"/"credencial recusada"/"sem crédito"/"provedor do tier falhou"/
  // "broker indisponível". Default: "broker indisponível" (broker) ou "provider
  // local indisponível" (local). F52.
  const defaultHeadline =
    props.backend === 'local' ? 'provider local indisponível' : 'broker indisponível';
  const headline = props.retrying ? 'tentando de novo' : (props.headline ?? defaultHeadline);
  const affordance = props.retrying ? 'esc cancelar' : 'r tentar agora · esc cancelar';
  return (
    <Box flexDirection="column" paddingLeft={4}>
      <Box>
        <Role name="danger">{theme.box.topLeft} </Role>
        <Glyph name="broker" role="depth" />
        <Role name="danger">
          {' '}
          {headline} {theme.box.horizontal.repeat(4)}{' '}
        </Role>
        <Glyph name="err" role="danger" />
      </Box>
      <Box>
        <Role name="danger">{theme.box.vertical} </Role>
        <Role name="fg">{props.message}</Role>
      </Box>
      {(props.status !== undefined ||
        props.attempt !== undefined ||
        props.retryInSeconds !== undefined) && (
        <Box>
          <Role name="danger">{theme.box.vertical} </Role>
          <Role name="fgDim">
            {props.status !== undefined ? `${props.status} · ` : ''}
            {props.retryInSeconds !== undefined
              ? `tentando de novo em ${props.retryInSeconds}s `
              : ''}
            {props.attempt !== undefined && props.maxAttempts !== undefined
              ? `(${props.attempt}/${props.maxAttempts})`
              : ''}
          </Role>
        </Box>
      )}
      <Box>
        <Role name="danger">{theme.box.vertical} </Role>
        <Role name="fgDim">{affordance}</Role>
      </Box>
      <Role name="danger">
        {theme.box.bottomLeft}
        {theme.box.horizontal.repeat(40)}
      </Role>
    </Box>
  );
}
