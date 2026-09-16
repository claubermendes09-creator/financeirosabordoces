/* ============================================================
   util.js — funções puras de apoio (formatação, datas, hashes)
   ============================================================ */

/* ---------- Formatação ---------- */

const fmtBRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtNum = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtInt = new Intl.NumberFormat('pt-BR');

export function moeda(v) {
  return fmtBRL.format(Number(v) || 0);
}

export function numero(v) {
  return fmtNum.format(Number(v) || 0);
}

export function inteiro(v) {
  return fmtInt.format(Number(v) || 0);
}

export function pct(v, casas = 1) {
  const n = Number(v);
  if (!isFinite(n)) return '—';
  return n.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas }) + '%';
}

/** 'AAAA-MM-DD' -> 'DD/MM/AAAA' */
export function dataBR(iso) {
  if (!iso) return '';
  const [a, m, d] = String(iso).slice(0, 10).split('-');
  return d && m && a ? `${d}/${m}/${a}` : String(iso);
}

/** 'DD/MM/AAAA' (com ou sem hora) -> 'AAAA-MM-DD'; null se inválida */
export function brParaISO(txt) {
  if (txt == null) return null;
  const s = String(txt).trim();
  const m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
  if (!m) {
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : null;
  }
  let [, d, mo, a] = m;
  if (a.length === 2) a = (Number(a) > 70 ? '19' : '20') + a;
  const dd = d.padStart(2, '0'), mm = mo.padStart(2, '0');
  if (+mm < 1 || +mm > 12 || +dd < 1 || +dd > 31) return null;
  return `${a}-${mm}-${dd}`;
}

/** Serial de data do Excel -> 'AAAA-MM-DD' */
export function excelSerialParaISO(n) {
  const num = Number(n);
  if (!isFinite(num) || num <= 0 || num > 80000) return null;
  const ms = Math.round((num - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (isNaN(d)) return null;
  return d.toISOString().slice(0, 10);
}

/** Aceita string BR, ISO ou serial do Excel */
export function qualquerParaISO(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  if (typeof v === 'number') return excelSerialParaISO(v);
  return brParaISO(v);
}

export function competenciaDe(iso) {
  return iso ? String(iso).slice(0, 7) : null;
}

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const MESES_CURTO = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

/** 'AAAA-MM' -> 'junho/2026' */
export function competenciaLonga(comp) {
  if (!comp) return '';
  const [a, m] = comp.split('-');
  return `${MESES[Number(m) - 1] || m}/${a}`;
}

/** 'AAAA-MM' -> 'Jun/26' */
export function competenciaCurta(comp) {
  if (!comp) return '';
  const [a, m] = comp.split('-');
  return `${MESES_CURTO[Number(m) - 1] || m}/${a.slice(2)}`;
}

export function competenciaAnterior(comp, passos = 1) {
  const [a, m] = comp.split('-').map(Number);
  const d = new Date(Date.UTC(a, m - 1 - passos, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function competenciaHoje() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function hojeISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ---------- Números ---------- */

/**
 * Converte texto monetário brasileiro em número.
 * Entende '-5.177,50 D', '838,52 C', 'R$ 1.234,56', '1234.56', 'Grátis'.
 * Retorna { valor, sentido } com valor sempre >= 0 e sentido 'DEBITO'|'CREDITO'|null.
 */
export function parseValorBR(txt) {
  if (txt == null || txt === '') return { valor: 0, sentido: null };
  if (typeof txt === 'number') {
    return { valor: Math.abs(txt), sentido: txt < 0 ? 'DEBITO' : 'CREDITO' };
  }
  let s = String(txt).trim();
  if (/^gr[áa]tis$/i.test(s) || /^isento$/i.test(s)) return { valor: 0, sentido: null };

  let sentido = null;
  const suf = s.match(/\s([DC])\s*$/i);
  if (suf) {
    sentido = suf[1].toUpperCase() === 'D' ? 'DEBITO' : 'CREDITO';
    s = s.slice(0, suf.index);
  }

  const negativo = /^\s*-/.test(s) || /\(\s*[\d.,]+\s*\)/.test(s);
  s = s.replace(/[^\d,.-]/g, '');

  // formato brasileiro: ponto = milhar, vírgula = decimal
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, '');

  const n = parseFloat(s);
  if (!isFinite(n)) return { valor: 0, sentido };
  if (!sentido) sentido = (negativo || n < 0) ? 'DEBITO' : 'CREDITO';
  return { valor: Math.abs(n), sentido };
}

/** Arredonda para 2 casas evitando erro de ponto flutuante */
export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/* ---------- Texto ---------- */

/** minúsculas, sem acento, sem pontuação, espaços colapsados */
export function normalizar(txt) {
  if (txt == null) return '';
  return String(txt)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\w\s/]/g, ' ')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Só dígitos — usado para CPF/CNPJ */
export function soDigitos(txt) {
  return String(txt == null ? '' : txt).replace(/\D/g, '');
}

export function iniciais(nome) {
  const p = String(nome || '?').trim().split(/\s+/);
  return ((p[0]?.[0] || '') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase() || '?';
}

export function esc(txt) {
  return String(txt == null ? '' : txt)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function truncar(txt, n = 60) {
  const s = String(txt == null ? '' : txt);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/* ---------- Cripto / ids ---------- */

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function hex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256(txt) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(txt));
  return hex(buf);
}

export async function sha256Bytes(arrayBuffer) {
  return hex(await crypto.subtle.digest('SHA-256', arrayBuffer));
}

/**
 * hash_dedup = SHA-256( conta_id | data | valor 2 casas | descricao normalizada | documento )
 */
export function chaveDedup(contaId, dataISO, valor, descricao, documento) {
  return [
    contaId,
    dataISO,
    Number(valor).toFixed(2),
    normalizar(descricao),
    soDigitos(documento) || normalizar(documento)
  ].join('|');
}

export async function hashDedup(contaId, dataISO, valor, descricao, documento) {
  return sha256(chaveDedup(contaId, dataISO, valor, descricao, documento));
}

/* ---------- DOM ---------- */

export const $  = (sel, raiz = document) => raiz.querySelector(sel);
export const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...filhos) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const f of filhos.flat()) {
    if (f == null || f === false) continue;
    n.append(f.nodeType ? f : document.createTextNode(String(f)));
  }
  return n;
}

export function debounce(fn, ms = 220) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function baixarArquivo(nome, conteudo, mime = 'application/octet-stream') {
  const blob = conteudo instanceof Blob ? conteudo : new Blob([conteudo], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = nome;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

/** Escapa um campo para CSV com separador ';' (Excel pt-BR) */
export function csvCampo(v) {
  const s = String(v == null ? '' : v);
  return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function agrupar(lista, chaveFn) {
  const m = new Map();
  for (const it of lista) {
    const k = chaveFn(it);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(it);
  }
  return m;
}

export function somar(lista, fn = x => x) {
  return round2(lista.reduce((a, b) => a + (Number(fn(b)) || 0), 0));
}
