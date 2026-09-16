/* ============================================================
   importadores/bradesco.js — Bradesco Net Empresa (.xls)

   Aba .............. "Sheet0" (única)
   As sete primeiras linhas são banner do relatório, agência e conta;
   o cabeçalho real fica mais abaixo:

     Data | Lançamento | Dcto. | Crédito (R$) | Débito (R$) | Saldo (R$)

   • Data ........... texto DD/MM/AAAA
   • Crédito/Débito . colunas separadas; o débito já vem negativo
   • Dcto. .......... número do documento
   • Descartar ...... 'SALDO ANTERIOR', o bloco final 'SALDO INVEST FÁCIL'
                      (que traz um segundo cabeçalho 'Data | Histórico | Valor')
                      e qualquer linha sem crédito nem débito
   • Favorecido ..... extraído do próprio texto: 'PIX ENVIADO DES: FULANO',
                      'PIX RECEBIDO REM: BELTRANO'
   • Classificação .. NÃO EXISTE neste layout. Sem o De/Para escrito à mão,
                      o aprendizado se apoia no favorecido e no núcleo da
                      descrição — por isso a limpeza dos dois importa aqui
                      mais do que em qualquer outro extrato.
   ============================================================ */

import {
  escolherAba, acharCabecalho, mapaColunas, acharColuna,
  txt, linhaVazia, novoResultado,
  normalizar, qualquerParaISO, parseValorBR
} from './comum.js';

export const LAYOUT = 'BRADESCO';
export const ABA_PADRAO = 'Sheet0';

const DESCARTAR = new Set([
  'saldo anterior',
  'saldo invest facil',
  'saldo do dia',
  'historico'          // cabeçalho do bloco de saldos, no meio da planilha
]);

/** 'PIX ENVIADO DES: FULANO' -> { tipo: 'PIX ENVIADO', favorecido: 'FULANO' } */
function separarFavorecido(descricao) {
  const s = txt(descricao);
  const m = s.match(/\b(DES|REM|PARA|BENEF|FAV)\s*:\s*(.+)$/i);
  if (!m) return { tipo: s, favorecido: null };
  return {
    tipo: s.slice(0, m.index).trim(),
    favorecido: m[2].trim() || null
  };
}

/** Tira o ' 12/01' que o Bradesco pendura no fim das descrições de PIX. */
function semDataFinal(s) {
  return txt(s).replace(/\s+\d{1,2}\/\d{1,2}(\/\d{2,4})?\s*$/, '').trim();
}

export function parse(wb, opcoes = {}) {
  const cfg = { somenteDespesas: true, ...opcoes };
  const res = novoResultado();

  const aba = escolherAba(wb, cfg.aba || ABA_PADRAO);
  if (!aba) { res.avisos.push('Arquivo sem abas legíveis.'); return res; }

  const XLSX = globalThis.XLSX;
  const grade = XLSX.utils.sheet_to_json(wb.Sheets[aba], { header: 1, raw: true, defval: null });
  if (!grade.length) { res.avisos.push(`A aba "${aba}" está vazia.`); return res; }

  const iCab = acharCabecalho(grade, ['Data', /^lancamento/, /credito/]);
  const mapa = mapaColunas(grade[iCab] || []);

  const cData    = acharColuna(mapa, ['Data', /^data/]);
  const cLanc    = acharColuna(mapa, ['Lançamento', /^lancamento/, /^historico/]);
  const cDoc     = acharColuna(mapa, ['Dcto.', /^dcto/, /documento/]);
  const cCredito = acharColuna(mapa, [/^credito/]);
  const cDebito  = acharColuna(mapa, [/^debito/]);

  if (cData < 0 || cLanc < 0 || (cCredito < 0 && cDebito < 0)) {
    res.avisos.push(`A aba "${aba}" não tem o cabeçalho esperado do extrato Bradesco (Data | Lançamento | ... | Crédito | Débito).`);
    return res;
  }

  for (let i = iCab + 1; i < grade.length; i++) {
    const l = grade[i];
    if (linhaVazia(l)) continue;
    res.totalLidas++;

    const bruto = txt(l[cLanc]);
    const semData = semDataFinal(bruto);
    if (!semData || DESCARTAR.has(normalizar(semData))) { res.descartadas++; continue; }

    const data = qualquerParaISO(l[cData]);
    if (!data) { res.descartadas++; continue; }

    // Bloco de saldos diários no rodapé: não tem crédito nem débito.
    const credito = cCredito >= 0 ? parseValorBR(l[cCredito]).valor : 0;
    const debito  = cDebito  >= 0 ? parseValorBR(l[cDebito]).valor  : 0;
    if (!credito && !debito) { res.descartadas++; continue; }

    const sentido = debito ? 'DEBITO' : 'CREDITO';
    const valor = debito || credito;

    if (cfg.somenteDespesas && sentido === 'CREDITO') { res.recebimentosIgnorados++; continue; }

    const { tipo, favorecido } = separarFavorecido(semData);

    res.linhas.push({
      n: i + 1,
      data,
      descricao: semData,
      favorecido,
      documento: txt(l[cDoc]) || null,
      classificacao: null,          // o Bradesco não traz coluna de De/Para
      valor,
      sentido,
      sintetica: false,
      qtd_origem: 1,
      categoria_forcada: null,
      observacao: favorecido ? null : `Tipo de lançamento: ${tipo}`
    });
  }

  return res;
}

export default { LAYOUT, ABA_PADRAO, parse };
