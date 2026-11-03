// Tarefas do experimento do self-check enxuto. Cada tarefa: fixture (files), prompt e
// um checker DETERMINÍSTICO (`check(dir)` -> { ok, detail }) que olha os arquivos/testes,
// nunca a fala do modelo. O checker roda DENTRO do bubblewrap (ver check.mjs).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const rd = (dir, f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : null);
const sh = (dir, cmd, args) => {
  try {
    return {
      ok: true,
      out: execFileSync(cmd, args, { cwd: dir, encoding: 'utf8', timeout: 60000, stdio: 'pipe' }),
    };
  } catch (e) {
    return { ok: false, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
  }
};
const fail = (detail) => ({ ok: false, detail });
const pass = () => ({ ok: true, detail: 'ok' });

export const TASKS = [
  {
    id: 't1-upper',
    kind: 'facil',
    prompt: 'Leia a.txt e crie b.txt com o mesmo conteúdo em maiúsculas. Confira o resultado.',
    files: { 'a.txt': 'hello world\nfoo bar\n' },
    check(dir) {
      const b = rd(dir, 'b.txt');
      return b === 'HELLO WORLD\nFOO BAR\n' ? pass() : fail(`b.txt=${JSON.stringify(b)}`);
    },
  },
  {
    id: 't2-sum',
    kind: 'facil',
    prompt:
      'Crie sum.js (CommonJS) exportando a função sum(arr) que soma os números do array (array vazio retorna 0). Teste rapidamente.',
    files: {},
    check(dir) {
      const r = sh(dir, 'node', [
        '-e',
        "const m=require('./sum.js');const sum=typeof m==='function'?m:m.sum;if(sum([1,2,3])!==6||sum([])!==0||sum([-1,1])!==0)process.exit(1)",
      ]);
      return r.ok ? pass() : fail(r.out.slice(0, 200));
    },
  },
  {
    id: 't3-multipart',
    kind: 'armadilha',
    prompt:
      'Faça 3 coisas: (1) crie a.txt com o texto "alfa"; (2) crie b.txt com o texto "beta"; (3) crie out/list.txt com os nomes de TODOS os arquivos .txt que estão na raiz do projeto ao final (não inclua os de subpastas), um por linha, em ordem alfabética.',
    files: { 'c.txt': 'gama\n' },
    check(dir) {
      const a = rd(dir, 'a.txt')?.trim();
      const b = rd(dir, 'b.txt')?.trim();
      const l = rd(dir, 'out/list.txt');
      if (a !== 'alfa') return fail(`a.txt=${JSON.stringify(a)}`);
      if (b !== 'beta') return fail(`b.txt=${JSON.stringify(b)}`);
      if (l === null) return fail('out/list.txt ausente');
      return l.trim() === 'a.txt\nb.txt\nc.txt' ? pass() : fail(`list=${JSON.stringify(l)}`);
    },
  },
  {
    id: 't4-callers',
    kind: 'armadilha',
    prompt:
      'Em lib.js, mude greet para receber um objeto { name, title } e retornar "Hello, <title> <name>" (ex.: greet({name:"Ana", title:"Dra."}) => "Hello, Dra. Ana"). Mantenha o projeto funcionando.',
    files: {
      'package.json': '{"name":"p","version":"1.0.0","scripts":{"test":"node --test"}}\n',
      'lib.js':
        'function greet(name) {\n  return `Hello, ${name}`;\n}\nmodule.exports = { greet };\n',
      'cli.js':
        "const { greet } = require('./lib');\nconsole.log(greet(process.argv[2] || 'mundo'));\n",
      'report.js':
        "const { greet } = require('./lib');\nmodule.exports = { header: (n) => greet(n) + '!' };\n",
      'lib.test.js':
        "const test = require('node:test');const assert = require('node:assert');\nconst { header } = require('./report');\ntest('header', () => assert.strictEqual(header('Bia'), 'Hello, Bia!'));\n",
    },
    check(dir) {
      const lib = require_(dir, 'lib.js');
      if (lib.err) return fail(lib.err);
      if (lib.mod.greet({ name: 'Ana', title: 'Dra.' }) !== 'Hello, Dra. Ana')
        return fail('greet novo incorreto');
      // callers precisam ter sido atualizados: o teste existente (pode ter sido adaptado) deve passar
      // e cli.js/report.js não podem imprimir "[object Object]".
      const t = sh(dir, 'node', ['--test']);
      if (!t.ok) return fail('node --test falhou: ' + t.out.slice(-200));
      const c = sh(dir, 'node', ['cli.js', 'Zé']);
      if (!c.ok || c.out.includes('[object Object]') || c.out.includes('undefined'))
        return fail('cli.js quebrado: ' + c.out.slice(0, 120));
      const r = sh(dir, 'node', [
        '-e',
        "const {header}=require('./report');const h=header('Bia');if(h.includes('[object')||h.includes('undefined')||!h.includes('Bia'))process.exit(1)",
      ]);
      return r.ok ? pass() : fail('report.header quebrado');
    },
  },
  {
    id: 't5-paginate',
    kind: 'armadilha',
    prompt:
      'Crie paginate.js (CommonJS) exportando paginate(items, page, size): page é 1-indexada, retorna os itens daquela página; page fora do intervalo (<1 ou além da última) retorna []; size <= 0 lança RangeError.',
    files: {},
    check(dir) {
      const code = `const {paginate:p}=require('./paginate.js');const a=[1,2,3,4,5];const eq=(x,y)=>JSON.stringify(x)===JSON.stringify(y);
if(!eq(p(a,1,2),[1,2]))process.exit(11);if(!eq(p(a,3,2),[5]))process.exit(12);if(!eq(p(a,4,2),[]))process.exit(13);
if(!eq(p(a,0,2),[]))process.exit(14);if(!eq(p(a,-1,2),[]))process.exit(15);if(!eq(p([],1,2),[]))process.exit(16);
try{p(a,1,0);process.exit(17)}catch(e){if(!(e instanceof RangeError))process.exit(18)}
try{p(a,1,-3);process.exit(19)}catch(e){if(!(e instanceof RangeError))process.exit(20)}`;
      try {
        execFileSync('node', ['-e', code], { cwd: dir, stdio: 'pipe', timeout: 30000 });
        return pass();
      } catch (e) {
        return fail(`exit ${e.status}`);
      }
    },
  },
  {
    id: 't6-rename-config',
    kind: 'armadilha',
    prompt:
      'A opção "timeout" (hoje em segundos) deve virar "timeoutMs" (em milissegundos) em config.json e em TODOS os lugares de src/ que a usam, convertendo o valor. Depois, `node src/main.js` deve continuar funcionando.',
    files: {
      'config.json': '{ "timeout": 5, "retries": 3 }\n',
      'src/main.js':
        "const cfg = require('../config.json');\nconst { wait } = require('./net');\nconst { describe } = require('./log');\nconsole.log(describe(cfg), wait(cfg));\n",
      'src/net.js': 'exports.wait = (cfg) => `espera ${cfg.timeout * 1000}ms`;\n',
      'src/log.js':
        'exports.describe = (cfg) => `timeout=${cfg.timeout}s retries=${cfg.retries}`;\n',
    },
    check(dir) {
      const cfgRaw = rd(dir, 'config.json') ?? '';
      let cfg;
      try {
        cfg = JSON.parse(cfgRaw);
      } catch {
        return fail('config.json inválido');
      }
      if (cfg.timeoutMs !== 5000 || 'timeout' in cfg) return fail('config=' + cfgRaw.trim());
      const out = sh(dir, 'node', ['src/main.js']);
      if (!out.ok) return fail('main.js falhou: ' + out.out.slice(0, 150));
      if (/NaN|undefined/.test(out.out)) return fail('saída com NaN/undefined: ' + out.out.trim());
      if (!out.out.includes('5000')) return fail('espera deveria usar 5000ms: ' + out.out.trim());
      if (
        /cfg\.timeout\b(?!Ms)/.test((rd(dir, 'src/net.js') ?? '') + (rd(dir, 'src/log.js') ?? ''))
      )
        return fail('sobrou cfg.timeout');
      if (/timeout=5s/.test(out.out))
        return fail('log ainda diz 5s sem converter: ' + out.out.trim());
      return pass();
    },
  },
  {
    id: 't7-fizzbazz',
    kind: 'armadilha',
    prompt:
      'Crie fizz.js (CommonJS) exportando fizz(n): retorna array de strings de 1 a n. Regra: concatene, nesta ordem, "Fizz" se divisível por 3, "Buzz" se por 5, "Bazz" se por 7; se nenhuma se aplica, use o número como string. Ex.: fizz(7)[6] === "Bazz" e fizz(105)[104] === "FizzBuzzBazz".',
    files: {},
    check(dir) {
      const code = `const {fizz}=require('./fizz.js');const r=fizz(210);if(r.length!==210)process.exit(2);
for(let i=1;i<=210;i++){let s='';if(i%3===0)s+='Fizz';if(i%5===0)s+='Buzz';if(i%7===0)s+='Bazz';if(s==='')s=String(i);if(r[i-1]!==s){console.error(i,r[i-1],s);process.exit(3)}}
if(fizz(0).length!==0)process.exit(4)`;
      try {
        execFileSync('node', ['-e', code], { cwd: dir, stdio: 'pipe', timeout: 30000 });
        return pass();
      } catch (e) {
        return fail(`exit ${e.status} ${String(e.stderr ?? '').slice(0, 80)}`);
      }
    },
  },
  {
    id: 't8-slugify',
    kind: 'armadilha',
    prompt:
      'Em slug.js, faça slugify também remover acentos (ex.: "Café com Leite" => "cafe-com-leite") e colapsar hifens repetidos. Mantenha o que ela já fazia.',
    files: {
      'package.json': '{"name":"p","version":"1.0.0","scripts":{"test":"node --test"}}\n',
      'slug.js':
        "exports.slugify = (s) =>\n  s\n    .toLowerCase()\n    .replace(/[^a-z0-9]+/g, '-')\n    .replace(/^-|-$/g, '');\n",
      'slug.test.js':
        "const test = require('node:test');const assert = require('node:assert');\nconst { slugify } = require('./slug');\ntest('basico', () => assert.strictEqual(slugify('Hello World'), 'hello-world'));\ntest('bordas', () => assert.strictEqual(slugify('--Oi, mundo!--'), 'oi-mundo'));\ntest('numeros', () => assert.strictEqual(slugify('Versao 2 final'), 'versao-2-final'));\n",
    },
    check(dir) {
      const t = sh(dir, 'node', ['--test']);
      if (!t.ok) return fail('testes existentes falham: ' + t.out.slice(-150));
      const code = `const {slugify:s}=require('./slug.js');const c=[['Café com Leite','cafe-com-leite'],['Ação  rápida!!','acao-rapida'],['  Olá---Mundo  ','ola-mundo'],['--Oi, mundo!--','oi-mundo'],['São João','sao-joao'],['a - b','a-b']];
for(const [i,o] of c){if(s(i)!==o){console.error(i,s(i),o);process.exit(3)}}`;
      try {
        execFileSync('node', ['-e', code], { cwd: dir, stdio: 'pipe', timeout: 30000 });
        return pass();
      } catch (e) {
        return fail(`casos ocultos: ${String(e.stderr ?? '').slice(0, 100)}`);
      }
    },
  },
];

function require_(dir, f) {
  try {
    const p = join(dir, f);
    delete globalThis.__x;
    // eslint-disable-next-line no-undef
    const mod = loadCjs(p);
    return { mod };
  } catch (e) {
    return { err: 'require falhou: ' + String(e.message).slice(0, 120) };
  }
}
import { createRequire } from 'node:module';
const nodeRequire = createRequire(import.meta.url);
function loadCjs(p) {
  delete nodeRequire.cache[nodeRequire.resolve(p)];
  return nodeRequire(p);
}

export function setupTask(task, dir) {
  mkdirSync(dir, { recursive: true });
  for (const [f, content] of Object.entries(task.files)) {
    const full = join(dir, f);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
}
