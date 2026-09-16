/* ============================================================
   importadores/stone.js — Stone (Sabor Doces e J. Flávio)

   Aba .............. "Extrato"
   Cabeçalho (linha 1)
     Movimentação | Tipo | Valor | Saldo antes | Saldo depois | Tarifa | Data |
     Classificação | Situação | Destino | Destino Documento | Destino Instituição | ...

   • Movimentação ..... 'Crédito' / 'Débito'
   • Valor ............ número (negativo nos débitos)
   • Data ............. 'DD/MM/AAAA HH:MM' → só a data
   • Tarifa ........... número ou 'Grátis'; > 0 gera lançamento em TAXAS DE CARTÃO
   • Destino .......... favorecido;  Destino Documento = CPF/CNPJ (chave forte)
   • Classificação .... alguns arquivos trazem a coluna duplicada ou grafada
                        'Classifdicação' — resolvemos por posição, usando a
                        primeira ocorrência não vazia.
   • Volume ........... créditos de 'Transação' / 'Recebível de Cartão' são receita
                        de venda e vêm aos milhares: agrupamos num total por dia
                        (ou ignoramos), nunca um a um na fila de classificação.
   ============================================================ */

import {
  escolherAba, mapaColunas, acharColuna, acharColunas, primeiroNaoVazio,
  txt, extrairDocumento, linhaVazia, novoResultado, agruparPorDia,
  normalizar, qualquerParaISO, parseValorBR, round2
} from './comum.js';

export const LAYOUT = 'STONE';
export const ABA_PADRAO = 'Extrato';

/** Tipos de crédito que representam venda no cartão. */
const TIPOS_RECEITA_CARTAO = ['transacao', 'recebivel de cartao'];

export const CATEGORIA_RECEITA_CARTAO = 'CARTÃO (DÉBITO + CRÉDITO)';
export const CATEGORIA_TARIFA = 'TAXAS DE CARTÃO';

/**
 * @param {object} opcoes
 *   receitasCartao:    'agrupar' (padrão) | 'ignorar' | 'detalhar'
 *   gerarTarifas:      true (padrão) — cria lançamentos de TAXAS DE CARTÃO
 *   agruparTarifas:    true (padrão) — um lançamento de tarifa por dia
 *   agruparPixCredito: false (padrão) — soma também os Pix recebidos por dia
 *   somenteDespesas:   true (padrão) — descarta as entradas, mantendo as tarifas
 */
export function parse(wb, opcoes = {}) {
  const cfg = {
    receitasCartao: 'agrupar',
    gerarTarifas: true,
    agruparTarifas: true,
    agruparPixCredito: false,
    somenteDespesas: true,
    ...opcoes
  };

  const res = novoResultado();
  const aba = escolherAba(wb, cfg.aba || ABA_PADRAO);
  if (!aba) { res.avisos.push('Arquivo sem abas legíveis.'); return res; }

  const XLSX = globalThis.XLSX;
  const grade = XLSX.utils.sheet_to_json(wb.Sheets[aba], { header: 1, raw: true, defval: null });
  if (!grade.length) { res.avisos.push(`A aba "${aba}" está vazia.`); return res; }

  const mapa = mapaColunas(grade[0]);
  const cMov    = acharColuna(mapa, ['Movimentação', /^movimentac/]);
  const cTipo   = acharColuna(mapa, ['Tipo', /^tipo$/]);
  const cValor  = acharColuna(mapa, ['Valor', /^valor$/]);
  const cTarifa = acharColuna(mapa, ['Tarifa', /^tarifa/]);
  const cData   = acharColuna(mapa, ['Data', /^data/]);
  const cClass  = acharColunas(mapa, [/classif/]);       // aceita 'Classifdicação' e duplicatas
  const cDest   = acharColuna(mapa, ['Destino', /^destino$/]);
  const cDestDoc = acharColuna(mapa, ['Destino Documento', /^destino documento/]);
  const cOrig   = acharColuna(mapa, ['Origem', /^origem$/]);
  const cOrigDoc = acharColuna(mapa, ['Origem Documento', /^origem documento/]);

  if (cMov < 0 || cValor < 0 || cData < 0) {
    res.avisos.push(`A aba "${aba}" não tem o cabeçalho esperado do extrato Stone (Movimentação | Tipo | Valor | ... | Data).`);
    return res;
  }
  if (cClass.length > 1) {
    res.avisos.push(`Coluna "Classificação" aparece ${cClass.length}× — usando a primeira preenchida de cada linha.`);
  }

  const receitasCartao = [];
  const pixRecebidos = [];
  const tarifas = [];

  for (let i = 1; i < grade.length; i++) {
    const l = grade[i];
    if (linhaVazia(l)) continue;
    res.totalLidas++;

    const data = qualquerParaISO(l[cData]);
    if (!data) { res.descartadas++; continue; }

    const mov = normalizar(l[cMov]);
    const sentido = mov === 'debito' ? 'DEBITO' : 'CREDITO';
    const { valor } = parseValorBR(l[cValor]);

    const tipo = normalizar(l[cTipo]);
    const classificacao = txt(primeiroNaoVazio(l, cClass)) || null;

    // Contraparte: no débito é o Destino; no crédito, quem originou o dinheiro.
    const contraparte = sentido === 'DEBITO'
      ? { nome: txt(l[cDest]), doc: txt(l[cDestDoc]) }
      : { nome: txt(l[cOrig]) || txt(l[cDest]), doc: txt(l[cOrigDoc]) || txt(l[cDestDoc]) };
    const documento = extrairDocumento(contraparte.doc) || contraparte.doc || null;

    /* ---- tarifa vira um lançamento próprio de TAXAS DE CARTÃO ---- */
    const { valor: vTarifa } = parseValorBR(l[cTarifa]);
    if (cfg.gerarTarifas && vTarifa > 0) {
      tarifas.push({
        n: i + 1, data,
        descricao: 'Tarifa Stone',
        favorecido: null, documento: null,
        classificacao: null,
        valor: round2(vTarifa), sentido: 'DEBITO',
        sintetica: true, qtd_origem: 1,
        categoria_forcada: CATEGORIA_TARIFA
      });
    }

    // A tarifa acima é despesa e fica; a entrada em si sai daqui.
    if (cfg.somenteDespesas && sentido === 'CREDITO') { res.recebimentosIgnorados++; continue; }

    if (!valor) { res.descartadas++; continue; }

    /* ---- receita de cartão: tratada em bloco ---- */
    if (sentido === 'CREDITO' && TIPOS_RECEITA_CARTAO.includes(tipo)) {
      if (cfg.receitasCartao === 'ignorar') { res.descartadas++; continue; }
      const linha = {
        n: i + 1, data,
        descricao: `${txt(l[cTipo])} — ${contraparte.nome || 'cartão'}`,
        favorecido: contraparte.nome || null, documento,
        classificacao, valor, sentido,
        sintetica: false, qtd_origem: 1,
        categoria_forcada: CATEGORIA_RECEITA_CARTAO
      };
      if (cfg.receitasCartao === 'agrupar') receitasCartao.push(linha);
      else res.linhas.push(linha);
      continue;
    }

    const linha = {
      n: i + 1, data,
      descricao: [txt(l[cTipo]), contraparte.nome].filter(Boolean).join(' — ') || 'Movimentação Stone',
      favorecido: contraparte.nome || null,
      documento,
      classificacao,
      valor, sentido,
      sintetica: false, qtd_origem: 1,
      categoria_forcada: null
    };

    // Pix recebido sem classificação também é venda: opcionalmente vai somado por dia
    if (cfg.agruparPixCredito && sentido === 'CREDITO' && !classificacao) {
      pixRecebidos.push(linha);
      continue;
    }

    res.linhas.push(linha);
  }

  if (receitasCartao.length) {
    res.linhas.push(...agruparPorDia(receitasCartao, {
      descricao: 'Recebimentos de cartão (agrupado)',
      categoria_forcada: CATEGORIA_RECEITA_CARTAO
    }));
    res.avisos.push(`${receitasCartao.length} créditos de venda em cartão foram agrupados em ${new Set(receitasCartao.map(l => l.data)).size} totais diários.`);
  }

  if (pixRecebidos.length) {
    const agrupados = agruparPorDia(pixRecebidos, {
      descricao: 'Pix recebidos (agrupado)',
      classificacao: 'Pix recebido Stone',
      categoria_forcada: null
    });
    res.linhas.push(...agrupados);
    res.avisos.push(`${pixRecebidos.length} Pix recebidos sem classificação foram somados em ${agrupados.length} totais diários.`);
  }

  if (tarifas.length) {
    if (cfg.agruparTarifas) {
      const agrupadas = agruparPorDia(tarifas, {
        descricao: 'Tarifas Stone (agrupado)',
        categoria_forcada: CATEGORIA_TARIFA
      });
      res.linhas.push(...agrupadas);
      res.avisos.push(`${tarifas.length} tarifas foram somadas em ${agrupadas.length} lançamentos diários de ${CATEGORIA_TARIFA}.`);
    } else {
      res.linhas.push(...tarifas);
    }
  }

  res.linhas.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : a.n - b.n));
  return res;
}

export default { LAYOUT, ABA_PADRAO, parse, CATEGORIA_RECEITA_CARTAO, CATEGORIA_TARIFA };
