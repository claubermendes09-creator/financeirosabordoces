/* ============================================================
   importadores/bb.js — Banco do Brasil

   Aba .............. "Extrato Conta"
   Cabeçalho (linha 1)
     Data | Lançamento | Detalhes | Classificação | N° documento | Valor | Tipo Lançamento

   • Data ............ texto DD/MM/AAAA
   • Valor ........... texto brasileiro com sufixo: '-5.177,50 D' / '838,52 C'.
                       O SUFIXO MANDA: 'D' é saída, 'C' é entrada.
   • Tipo Lançamento . 'Entrada' / 'Saída' — só vale quando o valor vem sem
                       sufixo. O BB preenche essa coluna de forma pouco
                       confiável: no extrato de agosto/2026 ela diz "Entrada"
                       nas 258 saídas do mês. Confiar nela zeraria a despesa.
   • Classificação ... pode simplesmente não existir. O extrato de agosto/2026
                       vem com 6 colunas, sem o De/Para preenchido à mão.
   • Descartar ....... 'Saldo Anterior', 'Saldo do dia' e a linha final 'S A L D O'

   • Recebimentos ..... entradas de 'Stone Pagamento', 'Pix - Recebido',
                        'Recebimento Fornecedor', 'TED-Crédito' e 'Pagamento de
                        Boleto' são receita de venda e chegam às centenas com a
                        coluna Classificação vazia. Elas são somadas num total
                        por dia e por tipo — sem isso a fila de validação fica
                        inutilizável (290 das 565 linhas do extrato de junho).
   ============================================================ */

import {
  escolherAba, mapaColunas, acharColuna, acharColunas, primeiroNaoVazio,
  txt, extrairDocumento, semDocumento, linhaVazia, novoResultado,
  normalizar, qualquerParaISO, parseValorBR, round2
} from './comum.js';

/**
 * Remove o carimbo de data/hora que o BB põe na frente do favorecido
 * ('30/07 15:20 ENEL DISTRIBUICAO CEARA' -> 'ENEL DISTRIBUICAO CEARA'),
 * para que o nome da contraparte sirva de chave de aprendizado.
 */
function limparFavorecido(s) {
  return txt(s)
    .replace(/^\d{1,2}\/\d{1,2}(\/\d{2,4})?\s*/, '')   // 30/07
    .replace(/^\d{1,2}[:h]\d{2}\s*/, '')                  // 15:20
    .replace(/^[\s\-–—:]+/, '')
    .trim();
}

export const LAYOUT = 'BB';
export const ABA_PADRAO = 'Extrato Conta';

const DESCARTAR = new Set(['saldo anterior', 'saldo do dia', 's a l d o', 'saldo']);

/**
 * Entradas que representam recebimento de venda.
 * `categoria` só é imposta onde a origem é inequívoca; nos demais casos o
 * operador classifica o total do dia uma única vez, e a memória aprende.
 */
const RECEBIMENTOS = [
  { chave: 'stone pagamento',       categoria: 'CARTÃO (DÉBITO + CRÉDITO)' },
  { chave: 'pagamento de boleto',   categoria: 'BOLETO' },
  { chave: 'recebimento fornecedor', categoria: null },
  { chave: 'pix recebido',          categoria: null },
  { chave: 'ted credito',           categoria: null }
];

function recebimentoDeVenda(lancamentoNorm) {
  return RECEBIMENTOS.find(r => lancamentoNorm.includes(r.chave)) || null;
}

/**
 * @param {object} opcoes
 *   somenteDespesas:     true (padrão) — descarta as entradas, trazendo só saídas
 *   agruparRecebimentos: true (padrão) — soma as entradas de venda por dia e tipo
 */
export function parse(wb, opcoes = {}) {
  const cfg = { somenteDespesas: true, agruparRecebimentos: true, ...opcoes };
  const res = novoResultado();
  const aba = escolherAba(wb, opcoes.aba || ABA_PADRAO);
  if (!aba) { res.avisos.push('Arquivo sem abas legíveis.'); return res; }

  const XLSX = globalThis.XLSX;
  const grade = XLSX.utils.sheet_to_json(wb.Sheets[aba], { header: 1, raw: true, defval: null });
  if (!grade.length) { res.avisos.push(`A aba "${aba}" está vazia.`); return res; }

  const mapa = mapaColunas(grade[0]);
  const cData   = acharColuna(mapa, ['Data', /^data/]);
  const cLanc   = acharColuna(mapa, ['Lançamento', /^lancamento$/]);
  const cDet    = acharColuna(mapa, ['Detalhes', /detalhe/]);
  const cClass  = acharColunas(mapa, [/classif/]);
  const cDoc    = acharColuna(mapa, ['N° documento', 'No documento', /documento/]);
  const cValor  = acharColuna(mapa, ['Valor', /^valor/]);
  const cTipo   = acharColuna(mapa, ['Tipo Lançamento', /tipo\s*lancamento/]);

  if (cData < 0 || cLanc < 0 || cValor < 0) {
    res.avisos.push(`A aba "${aba}" não tem o cabeçalho esperado do extrato do Banco do Brasil (Data | Lançamento | ... | Valor).`);
    return res;
  }

  const recebimentos = [];
  let divergentes = 0;

  for (let i = 1; i < grade.length; i++) {
    const l = grade[i];
    if (linhaVazia(l)) continue;
    res.totalLidas++;

    const lancamento = txt(l[cLanc]);
    if (DESCARTAR.has(normalizar(lancamento))) { res.descartadas++; continue; }

    const data = qualquerParaISO(l[cData]);
    if (!data) { res.descartadas++; continue; }

    const valorBruto = txt(l[cValor]);
    const temSufixo = /[DC]\s*$/i.test(valorBruto);
    const { valor, sentido: sentidoValor } = parseValorBR(valorBruto);
    if (!valor) { res.descartadas++; continue; }

    // O sufixo D/C do valor é a fonte da verdade. 'Tipo Lançamento' só entra
    // quando não há sufixo — ver o comentário no topo do arquivo.
    let sentido = sentidoValor;
    const tipo = normalizar(l[cTipo]);
    if (!temSufixo) {
      if (tipo === 'saida') sentido = 'DEBITO';
      else if (tipo === 'entrada') sentido = 'CREDITO';
    } else if ((tipo === 'saida' && sentido === 'CREDITO') ||
               (tipo === 'entrada' && sentido === 'DEBITO')) {
      divergentes++;
    }

    if (cfg.somenteDespesas && sentido === 'CREDITO') { res.recebimentosIgnorados++; continue; }

    const detalhes = txt(l[cDet]);
    const docDetalhes = extrairDocumento(detalhes);
    const favorecido = limparFavorecido(semDocumento(detalhes, docDetalhes)) || null;
    const documento = docDetalhes || txt(l[cDoc]) || null;
    const classificacao = txt(primeiroNaoVazio(l, cClass)) || null;

    const linha = {
      n: i + 1,
      data,
      descricao: [lancamento, detalhes].filter(Boolean).join(' — '),
      favorecido,
      documento,
      classificacao,
      valor,
      sentido,
      sintetica: false,
      qtd_origem: 1,
      categoria_forcada: null
    };

    // Recebimento de venda sem classificação manual: soma por dia e por tipo.
    // Se o operador escreveu algo na coluna Classificação, a escolha dele vence.
    const receb = (cfg.agruparRecebimentos && sentido === 'CREDITO' && !classificacao)
      ? recebimentoDeVenda(normalizar(lancamento)) : null;
    if (receb) {
      recebimentos.push({ ...linha, _tipo: lancamento, _categoria: receb.categoria });
      continue;
    }

    res.linhas.push(linha);
  }

  if (recebimentos.length) {
    const grupos = new Map();
    for (const r of recebimentos) {
      const k = r.data + '|' + r._tipo;
      if (!grupos.has(k)) grupos.set(k, []);
      grupos.get(k).push(r);
    }
    for (const [, grupo] of [...grupos.entries()].sort()) {
      const g0 = grupo[0];
      res.linhas.push({
        n: g0.n,
        data: g0.data,
        descricao: `${g0._tipo} — recebimentos do dia (${grupo.length})`,
        favorecido: null,
        documento: null,
        // o tipo do lançamento é a chave de De/Para do grupo: o operador
        // classifica o total de um dia e a memória passa a acertar sozinha
        classificacao: g0._tipo,
        valor: round2(grupo.reduce((a, b) => a + b.valor, 0)),
        sentido: 'CREDITO',
        sintetica: true,
        qtd_origem: grupo.length,
        categoria_forcada: g0._categoria
      });
    }
    res.avisos.push(`${recebimentos.length} entradas de recebimento de venda foram somadas em ${grupos.size} totais por dia e tipo.`);
  }

  if (divergentes) {
    res.avisos.push(
      `${divergentes} linha(s) têm "Tipo Lançamento" contradizendo o sufixo D/C do valor. ` +
      `O sufixo prevaleceu — é ele que o extrato preenche de forma confiável.`);
  }

  if (cClass.length === 0) {
    res.avisos.push('Este extrato não tem coluna "Classificação": a sugestão vai depender do favorecido e da descrição.');
  }

  res.linhas.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : a.n - b.n));
  return res;
}

export default { LAYOUT, ABA_PADRAO, parse };
