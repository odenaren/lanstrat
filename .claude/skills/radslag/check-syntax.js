#!/usr/bin/env node
/**
 * check-syntax.js — kor CLAUDE.md-reglerna 3, 4 och 5 som ett enda kommando.
 *
 *   node .claude/skills/radslag/check-syntax.js
 *
 * 1. node --check pa alla .js i repo-roten och overlay/
 * 2. node --check pa varje inline <script>-block i HTML-filerna, med
 *    radnummer-offset sa felet pekar pa ratt rad i HTML-filen
 * 3. Nastlade template literals (backtick i backtick) -> fel, de kraschar
 *    sidan tyst. Befintliga forekomster ar baselinade i
 *    nested-baseline.json; checken faller bara pa NYA. Kor med
 *    --update-baseline nar du medvetet stadat bort eller lagt till nagon.
 * 4. server.js och server-lanstrat.js maste vara byte-identiska
 *
 * Exit 0 = gront, exit 1 = rott. Inga beroenden utanfor Node.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const BASELINE_FILE = path.join(__dirname, 'nested-baseline.json');
const UPDATE_BASELINE = process.argv.includes('--update-baseline');

const errors = [];
const warnings = [];
const checked = { js: 0, blocks: 0 };
const nested = {}; // rel(fil) -> [radnummer]

function noteNested(file, line) {
  const key = rel(file);
  (nested[key] || (nested[key] = [])).push(line);
}

function rel(p) {
  return path.relative(REPO, p).split(path.sep).join('/');
}

// ---------------------------------------------------------------- filhittning

function jsFiles() {
  const out = [];
  for (const dir of [REPO, path.join(REPO, 'overlay')]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.js')) continue;
      const full = path.join(dir, name);
      if (fs.statSync(full).isFile()) out.push(full);
    }
  }
  return out.sort();
}

function htmlFiles() {
  const out = [];
  for (const dir of [REPO, path.join(REPO, 'public'), path.join(REPO, 'overlay')]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.html')) continue;
      const full = path.join(dir, name);
      if (fs.statSync(full).isFile()) out.push(full);
    }
  }
  return out.sort();
}

// ------------------------------------------------------- inline script-block

/**
 * Plockar ut varje inline <script>-block. Block med src= hoppas over (de har
 * ingen inline-kod). Returnerar { code, startLine } dar startLine ar raden i
 * HTML-filen dar koden borjar (1-indexerad).
 */
function extractScripts(html) {
  const blocks = [];
  const open = /<script\b([^>]*)>/gi;
  let m;
  while ((m = open.exec(html)) !== null) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    if (/\btype\s*=\s*["']?(?!text\/javascript|application\/javascript|module)/i.test(attrs)) continue;
    const bodyStart = m.index + m[0].length;
    const close = html.toLowerCase().indexOf('</script>', bodyStart);
    if (close === -1) continue;
    blocks.push({
      code: html.slice(bodyStart, close),
      startLine: html.slice(0, bodyStart).split('\n').length,
    });
  }
  return blocks;
}

// ------------------------------------------------ nastlade template literals

/**
 * Liten teckenskanner som haller reda pa strangar, kommentarer och template
 * literals. Traffar en backtick medan vi redan ar inuti en template literal
 * (dvs inne i ett ${ ... }) ar det en nastlad template literal.
 *
 * Regexliteraler tokeniseras inte (kraver full parser) - en regex som
 * innehaller en backtick kan darfor ge falsklarm. Radnumret skrivs ut sa det
 * gar att ogonbedomma pa en sekund.
 */
function findNestedTemplates(src) {
  const hits = [];
  const stack = []; // 'template' | 'subst' | 'brace'
  let i = 0;
  let line = 1;

  const top = () => stack[stack.length - 1];

  while (i < src.length) {
    const c = src[i];

    if (top() === 'template') {
      if (c === '\\') { i += 2; continue; }
      if (c === '\n') { line++; i++; continue; }
      if (c === '`') { stack.pop(); i++; continue; }
      if (c === '$' && src[i + 1] === '{') { stack.push('subst'); i += 2; continue; }
      i++;
      continue;
    }

    // kodkontext: toppniva, eller inuti ${ } / { }
    if (c === '\n') { line++; i++; continue; }

    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        if (src[i] === '\n') { line++; i++; break; } // otermninerad, ge upp raden
        i++;
      }
      continue;
    }
    if (c === '`') {
      if (stack.includes('template')) hits.push(line);
      stack.push('template');
      i++;
      continue;
    }
    if (c === '{') { stack.push('brace'); i++; continue; }
    if (c === '}') { if (stack.length) stack.pop(); i++; continue; }

    i++;
  }

  return hits;
}

// ------------------------------------------------------------ syntaxkontroll

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'radslag-check-'));

/**
 * Kor node --check. Koden padds med tomma rader sa att radnumren i
 * felmeddelandet matchar kallfilen.
 */
function nodeCheck(code, label, startLine) {
  const tmp = path.join(TMP, 'block-' + (checked.blocks + checked.js) + '.js');
  fs.writeFileSync(tmp, '\n'.repeat(Math.max(0, (startLine || 1) - 1)) + code, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    return null;
  } catch (err) {
    const out = String(err.stderr || err.stdout || err.message);
    return out
      .split('\n')
      .filter((l) => l.trim() && !l.includes('node:internal') && !l.startsWith('    at '))
      .slice(0, 6)
      .join('\n')
      .split(tmp).join(label);
  }
}

function report(file, msg) {
  errors.push(rel(file) + ': ' + msg);
}

// ------------------------------------------------------------------- korning

console.log('check-syntax — DHS Playbook\n');

for (const file of jsFiles()) {
  const code = fs.readFileSync(file, 'utf8');
  checked.js++;
  const err = nodeCheck(code, rel(file), 1);
  if (err) report(file, 'syntaxfel\n' + err);
  for (const line of findNestedTemplates(code)) noteNested(file, line);
}

for (const file of htmlFiles()) {
  const html = fs.readFileSync(file, 'utf8');
  const blocks = extractScripts(html);
  if (!blocks.length) continue;
  for (const block of blocks) {
    checked.blocks++;
    const label = rel(file) + ' <script> @ rad ' + block.startLine;
    const err = nodeCheck(block.code, label, block.startLine);
    if (err) report(file, 'syntaxfel i inline-JS\n' + err);
    for (const line of findNestedTemplates(block.code)) {
      noteNested(file, block.startLine + line - 1);
    }
  }
}

// regel 4: nastlade template literals. Befintliga ar baselinade — vi faller
// bara nar antalet i en fil OKAR, dvs nar nagon lagt till en ny.
let baseline = {};
if (fs.existsSync(BASELINE_FILE)) {
  try { baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')).files || {}; } catch (_) {}
}

if (UPDATE_BASELINE) {
  const files = {};
  for (const key of Object.keys(nested).sort()) files[key] = nested[key].length;
  fs.writeFileSync(
    BASELINE_FILE,
    JSON.stringify(
      {
        _comment:
          'Kanda nastlade template literals (CLAUDE.md regel 4). check-syntax.js faller ' +
          'bara nar antalet i en fil overstiger detta. Uppdatera med --update-baseline.',
        updated: new Date().toISOString().slice(0, 10),
        files,
      },
      null,
      2
    ) + '\n',
    'utf8'
  );
  console.log('Baseline uppdaterad: ' + rel(BASELINE_FILE) + '\n');
  baseline = files;
}

for (const key of Object.keys(nested)) {
  const found = nested[key];
  const allowed = baseline[key] || 0;
  if (found.length > allowed) {
    // Vilka som ar nya gar inte att sla fast — radnummer flyttar sig nar kod
    // laggs till ovanfor. Vi listar alla och sager hur manga som ar for manga.
    errors.push(
      key +
        ': ' +
        (found.length - allowed) +
        ' NY(A) nastlad(e) template literal(s) (regel 4). Baseline ' +
        allowed +
        ', hittade ' +
        found.length +
        ' — pa rad ' +
        found.join(', ') +
        '.\n    Nastlade backticks kraschar sidan tyst. Anvand strangkonkatenering ' +
        'eller DOM-element istallet.'
    );
  } else if (found.length < allowed) {
    warnings.push(
      key + ': ' + (allowed - found.length) + ' farre nastlade template literals an baseline — ' +
        'bra jobbat. Kor --update-baseline for att lasa in det.'
    );
  }
}

// regel 5: server.js och server-lanstrat.js maste vara identiska
const a = path.join(REPO, 'server.js');
const b = path.join(REPO, 'server-lanstrat.js');
if (fs.existsSync(a) && fs.existsSync(b)) {
  if (!fs.readFileSync(a).equals(fs.readFileSync(b))) {
    const la = fs.readFileSync(a, 'utf8').split('\n');
    const lb = fs.readFileSync(b, 'utf8').split('\n');
    let first = -1;
    for (let i = 0; i < Math.max(la.length, lb.length); i++) {
      if (la[i] !== lb[i]) { first = i + 1; break; }
    }
    errors.push(
      'server.js och server-lanstrat.js skiljer sig (regel 5) — forsta skillnaden rad ' +
        first +
        '. Kopiera server.js -> server-lanstrat.js.'
    );
  }
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

const nestedTotal = Object.values(nested).reduce((s, v) => s + v.length, 0);
console.log(
  '  ' + checked.js + ' js-filer, ' + checked.blocks + ' inline <script>-block, ' +
  nestedTotal + ' nastlade template literals (baseline: ' +
  Object.values(baseline).reduce((s, v) => s + v, 0) + ')\n'
);

for (const w of warnings) console.log('  ~ ' + w + '\n');

if (errors.length) {
  console.error('ROTT — ' + errors.length + ' problem:\n');
  for (const e of errors) console.error('  * ' + e + '\n');
  process.exit(1);
}

console.log('GRONT — allt kompilerar, inga NYA nastlade backticks, serverfilerna ar synkade.');
process.exit(0);
