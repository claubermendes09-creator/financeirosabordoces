/* ============================================================
   importadores/comum.js — utilidades compartilhadas pelos parsers

   Todos os importadores devolvem o mesmo formato:

   {
     linhas: [{
       n,               // nº da linha no arquivo (1 = cabeçalho)
       data,            // 'AAAA-MM-DD'
       descricao, favorecido, documento,
       classificacao,   // texto do De/Para escrito no próprio extrato
       valor,           // sempre >= 0
       sentido,         // 'DEBITO' | 'CREDITO'
       sintetica,       // true quando a linha foi gerada (agrupamento/tarifa)
       qtd_origem,      // nº de linhas do arquivo que essa linha representa
       categoria_forcada // nome de categoria imposto pelo importador (opcional)
     }],
     descartadas, foraDaCompetencia, recebimentosIgnorados, avisos, totalLidas
   }
   ============================================================ */

import { normalizar, qualquerParaISO, parseValorBR, soDigitos, round2 } from '../util.js';

/** Lê a primeira aba cujo nome casa com `preferida`, ou a primeira do arquivo. */
export function escolherAba(wb, preferida) {
  if (preferida) {
    const alvo = normalizar(preferida);
    const achou = wb.SheetNames.find(n => normalizar(n) === alvo)
      || wb.SheetNames.find(n => normalizar(n).includes(alvo));
    if (achou) return achou;
  }
  return wb.SheetNames[0];
}

/**
 * Acha a linha de cabeçalho de verdade. Nem todo extrato começa nela:
 * o Bradesco gasta as sete primeiras linhas com banner, agência e conta.
 * @param {Array<Array>} grade
 * @param {Array<string|RegExp>} termos  o que precisa aparecer na linha
 * @param {number} limite  quantas linhas vasculhar
 * @returns {number} índice da linha, ou 0 se não achar
 */
export function acharCabecalho(grade, termos, limite = 30) {
  for (let i = 0; i < Math.min(limite, grade.length); i++) {
    const linha = grade[i];
    if (!linha) continue;
    const celulas = linha.map(normalizar);
    const bate = termos.every(t => celulas.some(cel =>
      t instanceof RegExp ? t.test(cel) : cel === normalizar(t)));
    if (bate) return i;
  }
  return 0;
}

/**
 * Índice das colunas a partir da linha de cabeçalho.
 * Devolve { porNome: Map(normalizado -> [índices]) , cabecalho: [...] }
 */
export function mapaColunas(cabecalho) {
  const porNome = new Map();
  cabecalho.forEach((c, i) => {
    const k = normalizar(c);
    if (!k) return;
    if (!porNome.has(k)) porNome.set(k, []);
    porNome.get(k).push(i);
  });
  return { porNome, cabecalho };
}

/**
 * Acha o índice de uma coluna aceitando variações de escrita.
 * `alternativas` pode conter strings (comparação normalizada) ou RegExp
 * (testada contra o cabeçalho normalizado).
 * @returns {number[]} todos os índices que casaram, na ordem do arquivo
 */
export function acharColunas(mapa, alternativas) {
  const achados = [];
  for (const alt of alternativas) {
    if (alt instanceof RegExp) {
      mapa.cabecalho.forEach((c, i) => {
        if (alt.test(normalizar(c)) && !achados.includes(i)) achados.push(i);
      });
    } else {
      for (const i of (mapa.porNome.get(normalizar(alt)) || [])) {
        if (!achados.includes(i)) achados.push(i);
      }
    }
  }
  return achados.sort((a, b) => a - b);
}

export function acharColuna(mapa, alternativas) {
  const a = acharColunas(mapa, alternativas);
  return a.length ? a[0] : -1;
}

/** Primeiro valor não vazio entre várias colunas (trata colunas duplicadas). */
export function primeiroNaoVazio(linha, indices) {
  for (const i of indices) {
    if (i < 0) continue;
    const v = linha[i];
    if (v !== null && v !== undefined && String(v).trim() !== '') return v;
  }
  return null;
}

export function txt(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/\s+/g, ' ').trim();
}

/** Extrai o primeiro CPF/CNPJ formatado ou mascarado de um texto. */
export function extrairDocumento(s) {
  const t = String(s || '');
  const cnpj = t.match(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/);
  if (cnpj) return cnpj[0];
  const cpf = t.match(/\d{3}\.\d{3}\.\d{3}-\d{2}/);
  if (cpf) return cpf[0];
  const mascarado = t.match(/\*{3}\.\d{3}\.\d{3}-\*{2}/);
  if (mascarado) return mascarado[0];
  const cnpjSolto = t.match(/\b\d{14}\b/);
  if (cnpjSolto) return cnpjSolto[0];
  return null;
}

/** Remove o documento do início do texto, sobrando o nome do favorecido. */
export function semDocumento(s, doc) {
  let t = txt(s);
  if (doc) t = t.replace(doc, '');
  return t.replace(/^[\s\-–—:]+/, '').trim();
}

export function linhaVazia(l) {
  return !l || l.every(c => c === null || c === undefined || String(c).trim() === '');
}

export { normalizar, qualquerParaISO, parseValorBR, soDigitos, round2 };

/**
 * Cria o esqueleto de resultado usado por todos os parsers.
 */
export function novoResultado() {
  return { linhas: [], descartadas: 0, foraDaCompetencia: 0, recebimentosIgnorados: 0, avisos: [], totalLidas: 0 };
}

/**
 * Agrupa linhas por dia somando os valores — usado para as receitas de
 * cartão da Stone, que chegam com milhares de lançamentos por mês.
 */
export function agruparPorDia(linhas, { descricao, categoria_forcada, classificacao }) {
  const porDia = new Map();
  for (const l of linhas) {
    if (!porDia.has(l.data)) porDia.set(l.data, []);
    porDia.get(l.data).push(l);
  }
  const out = [];
  for (const [data, grupo] of [...porDia.entries()].sort()) {
    out.push({
      n: grupo[0].n,
      data,
      descricao: `${descricao} — ${grupo.length} ${grupo.length === 1 ? 'lançamento' : 'lançamentos'}`,
      favorecido: null,
      documento: null,
      classificacao: classificacao || null,
      valor: round2(grupo.reduce((a, b) => a + b.valor, 0)),
      sentido: grupo[0].sentido,
      sintetica: true,
      qtd_origem: grupo.length,
      categoria_forcada: categoria_forcada || null
    });
  }
  return out;
}
