// Repro: observa os bytes que o Ink emite no RESIZE (inline) com sessão cheia.
import React from 'react';
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import { ThemeProvider } from './packages/cli/dist/ui/theme/context.js';
import { resolveTheme } from './packages/cli/dist/ui/theme/theme.js';
import { App } from './packages/cli/dist/session/App.js';
import { SessionController } from './packages/cli/dist/session/controller.js';
import { TuiAskResolver } from './packages/cli/dist/ask/ask-resolver.js';
import { PolicyPermissionEngine } from '@hiperplano/aluy-cli-core';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };

// stdout fake: capturamos cada write CRU (sem overwrite — queremos ver o que o Ink faz).
class FakeStdout extends EventEmitter {
  constructor(cols, rows) { super(); this._cols = cols; this._rows = rows; this.writes = []; this.isTTY = true; }
  get columns() { return this._cols; }
  get rows() { return this._rows; }
  write(s, enc, cb) { this.writes.push(String(s)); if (typeof enc === 'function') enc(); else if (cb) cb(); return true; }
  resize(cols, rows) { this._cols = cols; this._rows = rows; this.emit('resize'); }
}
class FakeStdin extends EventEmitter { constructor(){super(); this.isTTY=true;} setRawMode(){} setEncoding(){} resume(){} pause(){} ref(){} unref(){} read(){return null;} }

function fakePorts() {
  return {
    fs: { async readFile(){return '';}, async writeFile(){}, async exists(){return false;} },
    shell: { async exec(){return {stdout:'',stderr:'',exitCode:0};} },
    search: { async search(){return [];} },
  };
}
function pausableCaller(text, getSink, gate) {
  return { async call(){ const sink=getSink(); sink.onStart?.(); for(const ch of text) sink.onDelta(ch); await gate; sink.onDone?.(); return {request_id:'r',content:text,finish_reason:'stop'}; } };
}

let release;
const gate = new Promise((r)=>{release=r;});
let ctrl=null;
const sink = { onStart:()=>ctrl?.sink.onStart?.(), onDelta:(c)=>ctrl?.sink.onDelta(c), onDone:()=>ctrl?.sink.onDone?.() };
const bigText = Array.from({length:40},(_,i)=>`linha de fala numero ${i+1} com bastante conteudo para quebrar em varias linhas visuais quando a largura do terminal encolher no resize`).join('\n');
const controller = new SessionController({
  model: pausableCaller(bigText, ()=>sink, gate),
  permission: new PolicyPermissionEngine(),
  ports: fakePorts(),
  askResolver: new TuiAskResolver(),
  meta: { cwd:'/proj', tier:'aluy-flux', tokens:0, windowPct:0 },
  flush: { intervalMs: 0 },
});
ctrl = controller;

const stdout = new FakeStdout(100, 24);
const stdin = new FakeStdin();

const theme = resolveTheme({ env: ENV });
const el = React.createElement(ThemeProvider, { theme }, React.createElement(App, { controller, animate:false, bootMs:0 }));
const inst = render(el, { stdout, stdin, patchConsole:false });
controller.dismissBoot();

// Semeia vários turnos concluídos no histórico (Static cheio).
for (let i=0;i<8;i++){
  controller.sink.onStart?.();
  // simula um turno curto concluído
}

await new Promise(r=>setTimeout(r,50));
// dispara um turno (streaming) para ter região viva grande
controller.submit?.('conte uma historia longa');
await new Promise(r=>setTimeout(r,80));

function countHeader(s){ // conta ocorrencias do banner (procura 'aluy' no header)
  const m = s.match(/ALUY|aluy/g); return m?m.length:0;
}

const beforeLen = stdout.writes.length;
console.log('--- writes antes do resize:', beforeLen);
// RESIZE: encolhe largura (reflow) e altura
stdout.resize(48, 12);
await new Promise(r=>setTimeout(r,150)); // deixa o clearScreen (90ms) rodar

const after = stdout.writes.slice(beforeLen);
console.log('--- writes no/apos resize:', after.length);
after.forEach((w,i)=>{
  const hasClearScreen = w.includes('\x1b[2J');
  const hasClearTerm = w.includes('\x1b[2J\x1b[3J\x1b[H');
  const hasEraseLines = w.includes('\x1b[2K');
  // conta linhas do write
  const nl = (w.match(/\n/g)||[]).length;
  console.log(`  [${i}] len=${w.length} nl=${nl} clearScreen=${hasClearScreen} clearTerm=${hasClearTerm} eraseLines=${hasEraseLines} headerCount=${countHeader(w)}`);
});

release();
await new Promise(r=>setTimeout(r,30));
inst.unmount();
process.exit(0);
