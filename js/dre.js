/* ============================================================
   dre.js — estrutura fixa e consolidação da DRE Gerencial

   A estrutura abaixo replica exatamente a seção 4 do briefing.
   Os totalizadores são calculados aqui (a "view" só agrega por
   categoria/competência, como no Postgres).
   ============================================================ */

import { round2 } from './util.js';

/* ------------------------------------------------------------
   Fórmulas de ponto de equilíbrio
   ------------------------------------------------------------

   ATENÇÃO — divergência documentada:
   O briefing descreve  (DESPESAS FIXAS + DESPESAS FINANCEIRAS) / (LUCRO BRUTO / RECEITA LÍQUIDA),
   mas essa conta NÃO reproduz os números do teste de aceite (JUNHO daria 778.387,51
   em vez de 737.341,23). A fórmula que reproduz JUNHO e JULHO com precisão de centavos é
        DESPESAS FIXAS TOTAIS / (LUCRO BRUTO / RECEITA TOTAL)
   — que é a usada na planilha atual. Ela é o padrão; a outra fica disponível na config.
   ------------------------------------------------------------ */

export const FORMULAS_PE = {
  DF_SOBRE_MARGEM_RT: {
    rotulo: 'Despesas fixas ÷ (Lucro bruto ÷ Receita total) — padrão, valida o teste de aceite',
    calc: t => (t.LUCRO_BRUTO > 0 && t.RECEITA_TOTAL > 0)
      ? t.DESPESAS_FIXAS / (t.LUCRO_BRUTO / t.RECEITA_TOTAL) : 0
  },
  DF_DFIN_SOBRE_MARGEM_RL: {
    rotulo: '(Despesas fixas + financeiras) ÷ (Lucro bruto ÷ Receita líquida)',
    calc: t => (t.LUCRO_BRUTO > 0 && t.RECEITA_LIQUIDA > 0)
      ? (t.DESPESAS_FIXAS + t.DESPESAS_FINANCEIRAS) / (t.LUCRO_BRUTO / t.RECEITA_LIQUIDA) : 0
  }
};

export const PE_PADRAO = 'DF_SOBRE_MARGEM_RT';

/* ------------------------------------------------------------
   Estrutura fixa (ordem de exibição)
   ------------------------------------------------------------ */

export const GRUPOS_DESPESA_FIXA = [
  'DESPESAS DE OCUPAÇÃO',
  'DESPESAS ADMINISTRATIVAS',
  'DESPESAS COM PESSOAL',
  'DESPESAS C/ VENDAS',
  'DESPESAS C/ DIRETORIA',
  'DESPESAS C/ MARKETING LOCAL'
];

export const ESTRUTURA = [
  { chave: 'RECEITA_TOTAL', kind: 'grupo', rotulo: '(+) RECEITA TOTAL', grupo: 'RECEITA TOTAL' },

  { chave: 'DEDUCOES', kind: 'grupo', rotulo: '(-) DEDUÇÕES DAS VENDAS (IMPOSTOS)',
    grupo: 'DEDUÇÕES DAS VENDAS (IMPOSTOS)' },

  { chave: 'RECEITA_LIQUIDA', kind: 'total', rotulo: '(=) RECEITA LÍQUIDA',
    calc: t => t.RECEITA_TOTAL - t.DEDUCOES },

  { chave: 'CUSTOS_VARIAVEIS', kind: 'grupo', rotulo: '(-) CUSTOS VARIÁVEIS',
    grupo: 'CUSTOS VARIÁVEIS' },

  { chave: 'LUCRO_BRUTO', kind: 'total', rotulo: '(=) LUCRO BRUTO / MARGEM DE CONTRIBUIÇÃO',
    calc: t => t.RECEITA_LIQUIDA - t.CUSTOS_VARIAVEIS },

  { chave: 'DESPESAS_FIXAS', kind: 'composto', rotulo: '(-) DESPESAS FIXAS TOTAIS',
    subgrupos: GRUPOS_DESPESA_FIXA },

  { chave: 'LUCRO_OPERACIONAL', kind: 'total', rotulo: '(=) LUCRO OPERACIONAL',
    calc: t => t.LUCRO_BRUTO - t.DESPESAS_FIXAS },

  { chave: 'DESPESAS_FINANCEIRAS', kind: 'grupo', rotulo: '(-) DESPESAS FINANCEIRAS/FINANCIAMENTOS',
    grupo: 'DESPESAS FINANCEIRAS/FINANCIAMENTOS' },

  { chave: 'LUCRO_LIQUIDO', kind: 'total', rotulo: '(=) LUCRO LÍQUIDO',
    calc: t => t.LUCRO_OPERACIONAL - t.DESPESAS_FINANCEIRAS },

  { chave: 'PONTO_EQUILIBRIO', kind: 'pe', rotulo: 'PONTO DE EQUILÍBRIO' }
];

/** Chaves na ordem em que aparecem, úteis para exportação e KPIs. */
export const CHAVES_TOTAIS = ESTRUTURA.map(l => l.chave);

/* ------------------------------------------------------------
   Agregação — equivalente da view v_dre
   ------------------------------------------------------------ */

export const STATUS_NA_DRE = ['CLASSIFICADO', 'CONFERIDO'];

/**
 * Soma os lançamentos por (competência, categoria), ignorando
 * categorias de CONTROLE e status fora de STATUS_NA_DRE.
 * @returns Map<competencia, Map<categoria_id, valor>>
 */
export function agregar(lancamentos, categorias) {
  const catPorId = new Map(categorias.map(c => [c.id, c]));
  const out = new Map();
  for (const l of lancamentos) {
    if (!STATUS_NA_DRE.includes(l.status)) continue;
    const cat = catPorId.get(l.categoria_id);
    if (!cat || cat.tipo === 'CONTROLE') continue;
    if (!out.has(l.competencia)) out.set(l.competencia, new Map());
    const m = out.get(l.competencia);
    // sentido "contra a natureza" da categoria abate: um estorno (crédito)
    // numa despesa reduz a despesa; uma devolução (débito) numa receita
    // reduz a receita. Lançamento sem sentido conta a favor da categoria.
    const contra = l.sentido && (cat.tipo === 'RECEITA' ? l.sentido === 'DEBITO' : l.sentido === 'CREDITO');
    m.set(cat.id, round2((m.get(cat.id) || 0) + (contra ? -1 : 1) * Number(l.valor || 0)));
  }
  return out;
}

/* ------------------------------------------------------------
   Montagem da DRE de uma competência
   ------------------------------------------------------------ */

/**
 * @param {Map<string,number>} porCategoria  categoria_id -> valor (já agregado)
 * @param {Array} categorias                 plano de contas completo
 * @param {object} opcoes                    { formulaPE }
 * @returns {{ totais, porGrupo, porCategoria, linhas }}
 */
export function montar(porCategoria, categorias, opcoes = {}) {
  const valores = porCategoria || new Map();
  const ativas = categorias.filter(c => c.tipo !== 'CONTROLE')
    .slice().sort((a, b) => a.ordem - b.ordem);

  const porGrupo = {};
  for (const c of ativas) {
    porGrupo[c.grupo] = round2((porGrupo[c.grupo] || 0) + (valores.get(c.id) || 0));
  }

  const t = {};
  t.RECEITA_TOTAL        = porGrupo['RECEITA TOTAL'] || 0;
  t.DEDUCOES             = porGrupo['DEDUÇÕES DAS VENDAS (IMPOSTOS)'] || 0;
  t.RECEITA_LIQUIDA      = round2(t.RECEITA_TOTAL - t.DEDUCOES);
  t.CUSTOS_VARIAVEIS     = porGrupo['CUSTOS VARIÁVEIS'] || 0;
  t.LUCRO_BRUTO          = round2(t.RECEITA_LIQUIDA - t.CUSTOS_VARIAVEIS);
  t.DESPESAS_FIXAS       = round2(GRUPOS_DESPESA_FIXA.reduce((a, g) => a + (porGrupo[g] || 0), 0));
  t.LUCRO_OPERACIONAL    = round2(t.LUCRO_BRUTO - t.DESPESAS_FIXAS);
  t.DESPESAS_FINANCEIRAS = porGrupo['DESPESAS FINANCEIRAS/FINANCIAMENTOS'] || 0;
  t.LUCRO_LIQUIDO        = round2(t.LUCRO_OPERACIONAL - t.DESPESAS_FINANCEIRAS);

  const formula = FORMULAS_PE[opcoes.formulaPE] || FORMULAS_PE[PE_PADRAO];
  t.PONTO_EQUILIBRIO = round2(formula.calc(t) || 0);

  /* ---- linhas para renderização / exportação ---- */
  const rt = t.RECEITA_TOTAL;
  const av = v => (rt ? (v / rt) * 100 : 0);
  const linhas = [];
  const push = (o) => linhas.push({ av: av(o.valor || 0), nivel: 0, ...o });

  const itensDoGrupo = (grupo, nivel, paiId) => {
    for (const c of ativas.filter(x => x.grupo === grupo)) {
      const v = valores.get(c.id) || 0;
      push({ id: 'cat:' + c.id, kind: 'item', rotulo: c.nome, valor: v, nivel, pai: paiId, categoria_id: c.id });
    }
  };

  for (const def of ESTRUTURA) {
    if (def.kind === 'grupo') {
      push({ id: def.chave, kind: 'grupo', rotulo: def.rotulo, valor: porGrupo[def.grupo] || 0, chave: def.chave });
      itensDoGrupo(def.grupo, 1, def.chave);

    } else if (def.kind === 'composto') {
      push({ id: def.chave, kind: 'grupo', rotulo: def.rotulo, valor: t.DESPESAS_FIXAS, chave: def.chave });
      for (const sg of def.subgrupos) {
        const sgId = def.chave + ':' + sg;
        push({ id: sgId, kind: 'sub', rotulo: '(-) ' + sg, valor: porGrupo[sg] || 0, nivel: 1, pai: def.chave });
        itensDoGrupo(sg, 2, sgId);
      }

    } else if (def.kind === 'total') {
      push({ id: def.chave, kind: 'total', rotulo: def.rotulo, valor: t[def.chave], chave: def.chave });

    } else if (def.kind === 'pe') {
      push({ id: def.chave, kind: 'pe', rotulo: def.rotulo, valor: t.PONTO_EQUILIBRIO, chave: def.chave });
    }
  }

  return { totais: t, porGrupo, porCategoria: valores, linhas, formulaPE: formula.rotulo };
}

/**
 * Atalho: da lista bruta de lançamentos até a DRE de uma competência.
 */
export function calcular(lancamentos, categorias, competencia, opcoes = {}) {
  const mapa = agregar(lancamentos, categorias);
  return montar(mapa.get(competencia) || new Map(), categorias, opcoes);
}

/**
 * Várias competências de uma vez (para comparação lado a lado).
 * @returns Map<competencia, resultado de montar()>
 */
export function calcularVarias(lancamentos, categorias, competencias, opcoes = {}) {
  const mapa = agregar(lancamentos, categorias);
  const out = new Map();
  for (const comp of competencias) {
    out.set(comp, montar(mapa.get(comp) || new Map(), categorias, opcoes));
  }
  return out;
}

/** Variação percentual entre dois valores (null quando a base é zero). */
export function variacao(atual, anterior) {
  if (!anterior) return null;
  return ((atual - anterior) / Math.abs(anterior)) * 100;
}

/**
 * Para os KPIs: em despesas, subir é ruim. Define se a variação
 * deve ser pintada como positiva ou negativa.
 */
export const SENTIDO_BOM = {
  RECEITA_TOTAL: 'sobe', RECEITA_LIQUIDA: 'sobe', LUCRO_BRUTO: 'sobe',
  LUCRO_OPERACIONAL: 'sobe', LUCRO_LIQUIDO: 'sobe',
  DEDUCOES: 'desce', CUSTOS_VARIAVEIS: 'desce', DESPESAS_FIXAS: 'desce',
  DESPESAS_FINANCEIRAS: 'desce', PONTO_EQUILIBRIO: 'desce'
};
