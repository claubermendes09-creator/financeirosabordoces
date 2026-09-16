/* ============================================================
   importadores/caixa.js — relatório de despesas de caixa (.xls antigo)

   Cabeçalho (linha 1)
     Histórico1 | Histórico3 | Favorecido | NF | Emissão | Vencimento | Valor |
     FP | Atraso | Acr | Dsc | Vlr Total | classificação | CC | Complemento | Lançamento

   • Filtrar ......... Histórico1 = '[DESPESAS]'
   • Data ............ Emissão
   • Valor ........... Vlr Total
   • Descrição ....... Histórico3 + Favorecido
   • De/Para ......... coluna 'classificação'
   ============================================================ */

import {
  escolherAba, mapaColunas, acharColuna, acharColunas, primeiroNaoVazio,
  txt, linhaVazia, novoResultado,
  normalizar, qualquerParaISO, parseValorBR
} from './comum.js';

export const LAYOUT = 'CAIXA';

// `normalizar` remove a pontuação, então '[DESPESAS]' vira 'despesas'.
const HISTORICO_DESPESA = normalizar('[DESPESAS]');
const HISTORICO_NAO_OPERACIONAL = normalizar('[DESPESAS NAO OPERACIONAIS]');

/**
 * @param {object} opcoes
 *   incluirNaoOperacionais: false (padrão) — inclui '[DESPESAS NAO OPERACIONAIS]'
 */
export function parse(wb, opcoes = {}) {
  const cfg = { incluirNaoOperacionais: false, ...opcoes };
  const res = novoResultado();
  const aba = escolherAba(wb, cfg.aba);
  if (!aba) { res.avisos.push('Arquivo sem abas legíveis.'); return res; }

  const XLSX = globalThis.XLSX;
  const grade = XLSX.utils.sheet_to_json(wb.Sheets[aba], { header: 1, raw: true, defval: null });
  if (!grade.length) { res.avisos.push(`A aba "${aba}" está vazia.`); return res; }

  const mapa = mapaColunas(grade[0]);
  const cHist1 = acharColuna(mapa, ['Histórico1', /^historico ?1/]);
  const cHist3 = acharColuna(mapa, ['Histórico3', /^historico ?3/]);
  const cFav   = acharColuna(mapa, ['Favorecido', /favorecid/]);
  const cNF    = acharColuna(mapa, ['NF', /^nf$/]);
  const cEmis  = acharColuna(mapa, ['Emissão', /^emissao/]);
  const cTotal = acharColuna(mapa, ['Vlr Total', /^vlr total/]);
  const cValor = acharColuna(mapa, ['Valor', /^valor$/]);
  const cClass = acharColunas(mapa, [/classific/]);
  const cCC    = acharColuna(mapa, ['CC', /^cc$/]);
  const cCompl = acharColuna(mapa, ['Complemento', /^complemento/]);
  const cLancN = acharColuna(mapa, ['Lançamento', /^lancamento$/]);

  if (cHist1 < 0 || cEmis < 0 || (cTotal < 0 && cValor < 0)) {
    res.avisos.push(`A aba "${aba}" não tem o cabeçalho esperado do relatório de caixa (Histórico1 | ... | Emissão | Vlr Total).`);
    return res;
  }

  let naoOperacionais = 0;

  for (let i = 1; i < grade.length; i++) {
    const l = grade[i];
    if (linhaVazia(l)) continue;
    res.totalLidas++;

    const hist1 = normalizar(l[cHist1]);
    const ehDespesa = hist1 === HISTORICO_DESPESA;
    const ehNaoOper = hist1 === HISTORICO_NAO_OPERACIONAL;

    if (!ehDespesa && !(ehNaoOper && cfg.incluirNaoOperacionais)) {
      if (ehNaoOper) naoOperacionais++;
      res.descartadas++;
      continue;
    }

    const data = qualquerParaISO(l[cEmis]);
    if (!data) { res.descartadas++; continue; }

    const { valor } = parseValorBR(cTotal >= 0 && l[cTotal] != null ? l[cTotal] : l[cValor]);
    if (!valor) { res.descartadas++; continue; }

    const hist3 = txt(l[cHist3]);
    const favorecido = txt(l[cFav]) || null;
    const cc = txt(l[cCC]);

    res.linhas.push({
      n: i + 1,
      data,
      descricao: [hist3, favorecido, cc && `(${cc})`].filter(Boolean).join(' — ') || 'Despesa de caixa',
      favorecido,
      documento: txt(l[cNF]) !== '0' ? (txt(l[cNF]) || null) : (txt(l[cLancN]) || null),
      classificacao: txt(primeiroNaoVazio(l, cClass)) || null,
      valor,
      sentido: 'DEBITO',
      sintetica: false,
      qtd_origem: 1,
      categoria_forcada: null,
      observacao: txt(l[cCompl]) || null
    });
  }

  if (naoOperacionais && !cfg.incluirNaoOperacionais) {
    res.avisos.push(`${naoOperacionais} linhas de "[DESPESAS NAO OPERACIONAIS]" foram descartadas. Marque a opção na tela de importação se quiser trazê-las.`);
  }

  return res;
}

export default { LAYOUT, parse };
