/* ============================================================
   telas/dashboard.js — visão do mês

   Ordem de leitura: o que importa primeiro.
     1. quatro números do mês (receita, lucro bruto, despesas fixas, lucro)
     2. ponto de equilíbrio, CMV e margem
     3. receita × despesas × resultado nos últimos 6 meses
     4. onde vai o dinheiro (ranking de categorias) e a fatia de cada grupo
     5. os maiores lançamentos do mês
   ============================================================ */

import estado from '../estado.js';
import { calcularVarias, variacao, SENTIDO_BOM, GRUPOS_DESPESA_FIXA } from '../dre.js';
import { el, moeda, dataBR, competenciaCurta, competenciaLonga, competenciaAnterior, competenciaHoje, truncar } from '../util.js';
import { cardKPI, card, selectSimples, icone } from '../ui/componentes.js';
import { barrasAgrupadas, barrasHorizontais, donut, linhas } from '../ui/grafico.js';
import { tabela } from '../ui/tabela.js';

export const titulo = 'Dashboard';

export async function render(ctx) {
  const [cats, lancs, comps, formulaPE, contasMap] = await Promise.all([
    estado.categorias(), estado.lancamentos(), estado.competencias(), estado.configPE(), estado.contaPorId()
  ]);

  // mês pedido na URL; senão o último que tem lançamento (o mês corrente vazio não interessa)
  const comMovimento = [...new Set(lancs.map(l => l.competencia))].filter(Boolean).sort();
  const comp = ctx.params.mes && /^\d{4}-\d{2}$/.test(ctx.params.mes)
    ? ctx.params.mes
    : (comMovimento[comMovimento.length - 1] || comps[0] || competenciaHoje());
  const ultimos = ultimasCompetencias(comp, 6);
  const dres = calcularVarias(lancs, cats, [...new Set([...ultimos, comp])], { formulaPE });
  const atual = dres.get(comp);
  const anterior = dres.get(competenciaAnterior(comp));
  const rt = atual.totais.RECEITA_TOTAL;
  const pctReceita = v => rt ? (v / rt * 100).toFixed(1) + '%' : '—';

  const raiz = document.createDocumentFragment();
  const aba = ctx.params.aba === 'evolucao' ? 'evolucao' : 'mes';

  /* ---- cabeçalho: duas abas ---- */
  const abas = el('div', { class: 'pills aba-dash', role: 'tablist' },
    el('button', { class: 'pill', type: 'button', role: 'tab', 'aria-pressed': String(aba === 'mes'), onclick: () => ctx.irPara('#/dashboard?mes=' + comp) }, 'Visão do mês'),
    el('button', { class: 'pill', type: 'button', role: 'tab', 'aria-pressed': String(aba === 'evolucao'), onclick: () => ctx.irPara('#/dashboard?aba=evolucao') }, 'Evolução mensal'));

  if (aba === 'evolucao') {
    raiz.append(el('div', { class: 'page-head' },
      el('h1', { class: 'page-title', text: 'Dashboard' }),
      el('div', { class: 'page-desc', text: 'Como os indicadores andaram mês a mês' }),
      abas));
    raiz.append(await telaEvolucao(ctx, { cats, lancs, comMovimento, formulaPE }));
    return raiz;
  }

  // um seletor em vez de uma fileira de pílulas: com muitos meses, polui menos
  const mesesOpcoes = [...new Set([...comMovimento, comp])].sort().reverse();
  const selMes = selectSimples(mesesOpcoes.map(c => ({ valor: c, rotulo: competenciaLonga(c) })), comp, { class: 'select', style: 'max-width:240px' });
  selMes.addEventListener('change', () => ctx.irPara('#/dashboard?mes=' + selMes.value));
  raiz.append(el('div', { class: 'page-head' },
    el('h1', { class: 'page-title', text: 'Dashboard' }),
    el('div', { class: 'page-desc', text: `Resultado gerencial de ${competenciaLonga(comp)}` }),
    abas,
    el('div', { class: 'field', style: 'margin-top:14px; max-width:260px' },
      el('label', { text: 'Competência' }), selMes)
  ));

  /* ---- alerta de pendências ---- */
  const pendentes = lancs.filter(l => l.status === 'A_CLASSIFICAR');
  if (pendentes.length) {
    raiz.append(el('div', { style: 'margin-bottom:20px' },
      el('div', { class: 'alerta' },
        icone('alerta', 18),
        el('span', { html: `<b>${pendentes.length}</b> lançamento(s) aguardando classificação.` }),
        el('button', {
          class: 'btn btn-sm btn-primary',
          onclick: () => ctx.irPara('#/lancamentos?status=A_CLASSIFICAR')
        }, 'Classificar agora')
      )));
  }

  const grid = el('div', { class: 'grid' });
  raiz.append(grid);

  /* ---- 1. os quatro números do mês ---- */
  const serie = chave => ultimos.map(c => dres.get(c) ? dres.get(c).totais[chave] : 0);
  const kpi = (chave, rotulo, destaque, contexto) => cardKPI({
    rotulo, valor: atual.totais[chave], destaque,
    variacao: anterior ? variacao(atual.totais[chave], anterior.totais[chave]) : null,
    sentidoBom: SENTIDO_BOM[chave],
    contexto,
    span: 'sp-4'
  });
  grid.append(
    kpi('RECEITA_TOTAL', 'Receita total', true, 'base do %AV'),
    kpi('DESPESAS_FIXAS', 'Despesas fixas', false, pctReceita(atual.totais.DESPESAS_FIXAS) + ' da receita'),
    kpi('LUCRO_LIQUIDO', 'Lucro líquido', false, 'margem de ' + pctReceita(atual.totais.LUCRO_LIQUIDO))
  );

  /* ---- 2. CMV · margem ---- */
  grid.append(cardKPI({
    rotulo: 'CMV', valor: atual.totais.CUSTOS_VARIAVEIS,
    variacao: anterior ? variacao(atual.totais.CUSTOS_VARIAVEIS, anterior.totais.CUSTOS_VARIAVEIS) : null,
    sentidoBom: 'desce', contexto: pctReceita(atual.totais.CUSTOS_VARIAVEIS) + ' da receita',
    span: 'sp-6'
  }));
  const margens = ultimos.map(c => { const d = dres.get(c); return d && d.totais.RECEITA_TOTAL ? d.totais.LUCRO_LIQUIDO / d.totais.RECEITA_TOTAL * 100 : 0; });
  const margemAtual = rt ? atual.totais.LUCRO_LIQUIDO / rt * 100 : 0;
  const margemAnt = anterior && anterior.totais.RECEITA_TOTAL ? anterior.totais.LUCRO_LIQUIDO / anterior.totais.RECEITA_TOTAL * 100 : null;
  grid.append(cardKPI({
    rotulo: 'Margem líquida', valor: margemAtual, formato: v => v.toFixed(1) + '%',
    variacao: margemAnt ? (margemAtual - margemAnt) / Math.abs(margemAnt) * 100 : null,
    sentidoBom: 'sobe', contexto: 'lucro líquido ÷ receita',
    span: 'sp-6'
  }));

  /* ---- 3. receita × despesas × resultado, 6 meses ---- */
  const totalDespesas = c => { const d = dres.get(c); return d ? d.totais.DEDUCOES + d.totais.CUSTOS_VARIAVEIS + d.totais.DESPESAS_FIXAS + d.totais.DESPESAS_FINANCEIRAS : 0; };
  grid.append(card({ titulo: 'Receita × despesas × resultado', sub: 'últimos 6 meses — clique num mês para abrir', span: 'sp-8' },
    barrasAgrupadas(ultimos.map(competenciaCurta), [
      { nome: 'Receita', cor: 'var(--accent)', valores: ultimos.map(c => dres.get(c) ? dres.get(c).totais.RECEITA_TOTAL : 0) },
      { nome: 'Despesas', cor: 'var(--c1)', valores: ultimos.map(totalDespesas) },
      { nome: 'Lucro líquido', cor: 'var(--c5)', valores: serie('LUCRO_LIQUIDO') }
    ], { foco: ultimos.indexOf(comp), aoFocar: i => ctx.irPara('#/dashboard?mes=' + ultimos[i]) })
  ));

  /* ---- cartão glass: resumo do mês ---- */
  grid.append(el('div', { class: 'sp-4' },
    el('div', { class: 'glass-wrap' },
      el('div', { class: 'glass' },
        el('div', { class: 'g-label', text: 'Resultado de ' + competenciaCurta(comp) }),
        el('div', { class: 'g-value num', text: moeda(atual.totais.LUCRO_LIQUIDO) }),
        el('div', { class: 'g-row' }, el('span', { text: 'Receita líquida' }), el('b', { class: 'num', text: moeda(atual.totais.RECEITA_LIQUIDA) })),
        el('div', { class: 'g-row' }, el('span', { text: 'Lucro bruto' }), el('b', { class: 'num', text: moeda(atual.totais.LUCRO_BRUTO) })),
        el('div', { class: 'g-row' }, el('span', { text: 'Lucro operacional' }), el('b', { class: 'num', text: moeda(atual.totais.LUCRO_OPERACIONAL) })),
        el('div', { class: 'g-row' }, el('span', { text: 'Desp. financeiras' }), el('b', { class: 'num', text: moeda(atual.totais.DESPESAS_FINANCEIRAS) })),
        el('div', { class: 'g-row' }, el('span', { text: 'Margem sobre receita' }), el('b', { class: 'num', text: pctReceita(atual.totais.LUCRO_LIQUIDO) }))
      ))
  ));

  /* ---- 4. onde vai o dinheiro ---- */
  const maiores = maioresDespesas(atual, cats, 8);
  grid.append(card({
    titulo: 'Onde vai o dinheiro', sub: '8 maiores categorias do mês, com a fatia da receita', span: 'sp-7',
    acoes: el('button', { class: 'btn btn-sm btn-ghost', onclick: () => ctx.irPara('#/dre?mes=' + comp) }, 'Ver DRE')
  },
    maiores.length
      ? barrasHorizontais(maiores.map(m => ({ ...m, extra: pctReceita(m.valor) })),
        { aoClicar: d => ctx.irPara(`#/lancamentos?mes=${comp}&categoria=${d.id}`) })
      : el('div', { class: 'vazio', text: 'Sem despesas lançadas neste mês.' })
  ));

  const porGrupo = fatiasPorGrupo(atual);
  grid.append(card({ titulo: 'Composição por grupo', sub: 'como a despesa total se divide', span: 'sp-5' },
    porGrupo.length ? donut(porGrupo, { rotuloCentro: 'despesa total' })
      : el('div', { class: 'vazio', text: 'Sem despesas lançadas neste mês.' })
  ));

  /* ---- 5. maiores lançamentos do mês ---- */
  const catMap = await estado.catPorId();
  const maioresLanc = lancs
    // ajustes da planilha são totais artificiais, não um pagamento real
    .filter(l => l.competencia === comp && l.sentido === 'DEBITO' && l.status !== 'EXCLUIDO' && !/AJUSTE_PLANILHA/.test(l.observacao || ''))
    .sort((a, b) => b.valor - a.valor)
    .slice(0, 8);
  grid.append(card({
    titulo: 'Maiores lançamentos do mês', sub: competenciaLonga(comp), span: 'sp-12',
    acoes: el('button', { class: 'btn btn-sm btn-ghost', onclick: () => ctx.irPara('#/lancamentos?mes=' + comp) }, 'Ver todos')
  },
    tabela([
      { rotulo: 'Data', render: l => dataBR(l.data), classe: 'nowrap' },
      { rotulo: 'Descrição', render: l => el('div', {}, el('div', { text: truncar(l.descricao, 60) }),
        l.favorecido ? el('div', { class: 'faint', style: 'font-size:11px', text: l.favorecido }) : null) },
      { rotulo: 'Categoria', render: l => (catMap.get(l.categoria_id) || {}).nome || '—' },
      { rotulo: 'Conta', render: l => (contasMap.get(l.conta_id) || {}).nome || '—', classe: 'nowrap' },
      { rotulo: '% da receita', classe: 'right faint', render: l => pctReceita(l.valor) },
      { rotulo: 'Valor', classe: 'right money', render: l => moeda(l.valor) }
    ], maioresLanc, { vazio: 'Nenhum lançamento neste mês.', rolagem: false })
  ));

  return raiz;
}

/* ------------------------------------------------------------
   Aba "Evolução mensal": escolha os meses, veja cada indicador ao longo deles
   ------------------------------------------------------------ */

const INDICADORES = [
  { chave: 'RECEITA_TOTAL', nome: 'Receita total', cor: 'var(--accent)' },
  { chave: 'CUSTOS_VARIAVEIS', nome: 'CMV', cor: 'var(--c1)' },
  { chave: 'LUCRO_BRUTO', nome: 'Lucro bruto', cor: 'var(--c3)' },
  { chave: 'DESPESAS_FIXAS', nome: 'Despesas fixas', cor: 'var(--c4)' },
  { chave: 'LUCRO_OPERACIONAL', nome: 'Lucro operacional', cor: 'var(--c5)' },
  { chave: 'LUCRO_LIQUIDO', nome: 'Lucro líquido', cor: 'var(--c2)' },
  { chave: 'PONTO_EQUILIBRIO', nome: 'Ponto de equilíbrio', cor: 'var(--c6)' }
];

const EVO = { selecionadas: null };   // seleção de meses sobrevive a trocas de tela

async function telaEvolucao(ctx, { cats, lancs, comMovimento, formulaPE }) {
  const raiz = el('div', {});
  const anos = [...new Set(comMovimento.map(c => c.slice(0, 4)))].sort();
  if (!EVO.selecionadas || !EVO.selecionadas.every(c => comMovimento.includes(c))) EVO.selecionadas = [...comMovimento];

  const painel = el('div', {});
  raiz.append(painel);

  function pintar() {
    painel.textContent = '';
    const sel = EVO.selecionadas;

    /* ---- filtro: pílulas por mês, atalhos por ano e Todos ---- */
    const pills = el('div', { class: 'pills', style: 'margin:0 0 18px' });
    for (const c of comMovimento) {
      pills.append(el('button', {
        class: 'pill', type: 'button', 'aria-pressed': String(sel.includes(c)),
        onclick: () => { const i = sel.indexOf(c); if (i >= 0) sel.splice(i, 1); else sel.push(c); sel.sort(); pintar(); }
      }, competenciaCurta(c)));
    }
    pills.append(el('span', { class: 'faint', style: 'margin:0 4px 0 8px' }, '|'));
    for (const a of anos) {
      const doAno = comMovimento.filter(c => c.startsWith(a));
      const todosDoAno = doAno.every(c => sel.includes(c));
      pills.append(el('button', {
        class: 'pill', type: 'button', 'aria-pressed': String(todosDoAno), title: todosDoAno ? `Desmarcar ${a}` : `Marcar todos os meses de ${a}`,
        onclick: () => { EVO.selecionadas = todosDoAno ? sel.filter(c => !c.startsWith(a)) : [...new Set([...sel, ...doAno])].sort(); pintar(); }
      }, a));
    }
    const todas = comMovimento.every(c => sel.includes(c));
    pills.append(el('button', {
      class: 'pill', type: 'button', 'aria-pressed': String(todas),
      onclick: () => { EVO.selecionadas = todas ? [] : [...comMovimento]; pintar(); }
    }, 'Todos'));
    painel.append(pills);

    if (!sel.length) {
      painel.append(el('div', { class: 'card' }, el('div', { class: 'vazio', text: 'Marque um ou mais meses para ver a evolução.' })));
      return;
    }

    const dres = calcularVarias(lancs, cats, sel, { formulaPE });
    const rotulos = sel.map(competenciaCurta);
    const valores = chave => sel.map(c => dres.get(c) ? dres.get(c).totais[chave] : 0);
    const pctFmt = v => v.toFixed(1).replace('.', ',') + '%';
    const grid = el('div', { class: 'grid' });

    /* ---- visão combinada: receita × despesas × lucro ---- */
    const despesas = sel.map(c => { const d = dres.get(c); return d ? d.totais.DEDUCOES + d.totais.CUSTOS_VARIAVEIS + d.totais.DESPESAS_FIXAS + d.totais.DESPESAS_FINANCEIRAS : 0; });
    grid.append(card({ titulo: 'Receita × despesas × lucro líquido', sub: `${sel.length} mês(es) selecionado(s)`, span: 'sp-12' },
      linhas(rotulos, [
        { nome: 'Receita', cor: 'var(--accent)', valores: valores('RECEITA_TOTAL') },
        { nome: 'Despesas', cor: 'var(--c1)', valores: despesas },
        { nome: 'Lucro líquido', cor: 'var(--c2)', valores: valores('LUCRO_LIQUIDO') }
      ])));

    /* ---- percentuais sobre a receita ---- */
    const margens = sel.map(c => { const d = dres.get(c); return d && d.totais.RECEITA_TOTAL ? d.totais.LUCRO_LIQUIDO / d.totais.RECEITA_TOTAL * 100 : 0; });
    grid.append(card({ titulo: 'Margem líquida', sub: 'lucro líquido ÷ receita', span: 'sp-6' },
      linhas(rotulos, [{ nome: 'Margem', cor: 'var(--c2)', valores: margens }], { formato: pctFmt, altura: 200 })));
    const cmvPct = sel.map(c => { const d = dres.get(c); return d && d.totais.RECEITA_TOTAL ? d.totais.CUSTOS_VARIAVEIS / d.totais.RECEITA_TOTAL * 100 : 0; });
    grid.append(card({ titulo: 'CMV sobre a receita', sub: 'quanto da venda vira custo da mercadoria', span: 'sp-6' },
      linhas(rotulos, [{ nome: 'CMV %', cor: 'var(--c1)', valores: cmvPct }], { formato: pctFmt, altura: 200 })));

    /* ---- um gráfico por indicador ---- */
    for (const ind of INDICADORES) {
      const v = valores(ind.chave);
      const ultimo = v[v.length - 1], primeiro = v[0];
      const varia = primeiro ? ((ultimo - primeiro) / Math.abs(primeiro) * 100) : null;
      grid.append(card({
        titulo: ind.nome,
        sub: sel.length > 1 && varia != null ? `${rotulos[0]} → ${rotulos[rotulos.length - 1]}: ${varia >= 0 ? '+' : ''}${pctFmt(varia)}` : moeda(ultimo),
        span: 'sp-6'
      }, linhas(rotulos, [{ nome: ind.nome, cor: ind.cor, valores: v }], { altura: 200 })));
    }
    painel.append(grid);
  }
  pintar();
  return raiz;
}

/* ------------------------------------------------------------ */

function ultimasCompetencias(comp, n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(competenciaAnterior(comp, i));
  return out;
}

function maioresDespesas(dre, categorias, n) {
  return categorias
    .filter(c => ['CUSTO_VARIAVEL', 'DESPESA_FIXA', 'DESPESA_FINANCEIRA', 'DEDUCAO'].includes(c.tipo))
    .map(c => ({ id: c.id, rotulo: c.nome, valor: dre.porCategoria.get(c.id) || 0 }))
    .filter(x => x.valor > 0)
    .sort((a, b) => b.valor - a.valor)
    .slice(0, n);
}

/** Despesa total repartida por grupo da DRE (CMV, pessoal, ocupação…). */
function fatiasPorGrupo(dre) {
  const grupos = ['CUSTOS VARIÁVEIS', ...GRUPOS_DESPESA_FIXA, 'DESPESAS FINANCEIRAS/FINANCIAMENTOS', 'DEDUÇÕES DAS VENDAS (IMPOSTOS)'];
  const nomeCurto = {
    'CUSTOS VARIÁVEIS': 'CMV', 'DESPESAS DE OCUPAÇÃO': 'Ocupação', 'DESPESAS ADMINISTRATIVAS': 'Administrativas',
    'DESPESAS COM PESSOAL': 'Pessoal', 'DESPESAS C/ VENDAS': 'Vendas',
    'DESPESAS C/ DIRETORIA': 'Diretoria', 'DESPESAS C/ MARKETING LOCAL': 'Marketing',
    'DESPESAS FINANCEIRAS/FINANCIAMENTOS': 'Financeiras', 'DEDUÇÕES DAS VENDAS (IMPOSTOS)': 'Impostos'
  };
  return grupos
    .map(g => ({ rotulo: nomeCurto[g] || g, valor: dre.porGrupo[g] || 0 }))
    .filter(x => x.valor > 0)
    .sort((a, b) => b.valor - a.valor);
}

export default { titulo, render };
