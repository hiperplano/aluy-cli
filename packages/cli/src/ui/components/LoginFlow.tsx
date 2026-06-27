// EST-0948 · spec §2.3 — <LoginFlow>: device-flow (user_code + URL + polling).
//
// A TUI SÓ renderiza o I/O do device-flow (a emissão/polling é EST-0942/0940).
// Mostra o `user_code` em destaque (amber, espaçado p/ leitura), a
// `verification_uri` (depth/petrol), e o estado do polling com countdown. NUNCA
// exibe o access/refresh token (CLI-SEC-2/10). Falha de auth = mensagem NEUTRA
// (não distingue "usuário não existe" de "código errado", CLI-SEC-1).

import React from 'react';
import { Box } from 'ink';
import { Glyph, Role, useTheme } from '../theme/index.js';

export interface LoginFlowProps {
  readonly userCode: string;
  readonly verificationUri: string;
  /** Segundos restantes até expirar (countdown). */
  readonly expiresInSeconds?: number;
  /** Mensagem de status do polling (ex.: "aguardando confirmação…"). */
  readonly status?: string;
}

/** Espaça o código p/ leitura: `WDJQXKFP` → `W D J Q - X K F P`. */
function spaceCode(code: string): string {
  return code.split('').join(' ');
}

function formatCountdown(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function LoginFlow(props: LoginFlowProps): React.ReactElement {
  const theme = useTheme();
  return (
    <Box flexDirection="column">
      <Role name="fg">abra no navegador e confirme o código:</Role>
      <Box paddingTop={1}>
        <Role name="accent">
          {theme.box.topLeft}
          {theme.box.horizontal.repeat(spaceCode(props.userCode).length + 4)}
          {theme.box.topRight}
        </Role>
      </Box>
      <Box>
        <Role name="accent">
          {theme.box.vertical} {spaceCode(props.userCode)} {theme.box.vertical}
        </Role>
        <Role name="fgDim"> ‹ user_code</Role>
      </Box>
      <Box>
        <Role name="accent">
          {theme.box.bottomLeft}
          {theme.box.horizontal.repeat(spaceCode(props.userCode).length + 4)}
          {theme.box.bottomRight}
        </Role>
      </Box>
      <Box paddingTop={1}>
        <Role name="depth">{props.verificationUri}</Role>
      </Box>
      <Box paddingTop={1}>
        <Glyph name="clock" role="fgDim" />
        <Role name="fgDim"> {props.status ?? 'aguardando confirmação…'}</Role>
      </Box>
      {props.expiresInSeconds !== undefined && (
        <Box>
          <Role name="fgDim"> o código expira em {formatCountdown(props.expiresInSeconds)}</Role>
        </Box>
      )}
      <Box paddingTop={1}>
        <Role name="fgDim">esc cancelar · t colar um token (PAT)</Role>
      </Box>
    </Box>
  );
}
