/* ============================================================
   telas/dre.js — DRE Gerencial consolidada
   ============================================================ */

import db from '../db.js';
import auth from '../auth.js';
import estado from '../estado.js';
import { calcularVarias, FORMULAS_PE } from '../dre.js';
import {
  el, moeda, pct, competenciaLonga, competenciaCurta, competenciaHoje,
  baixarArquivo, csvCampo, round2
} from '../util.js';
import { selectSimples, icone, card } from '../ui/componentes.js';
import modal from '../ui/modal.js';
import toast from '../ui/toast.js';

export const titulo = 'DRE';

let S = null;

export async function render(ctx) {
  const [cats, lancs, comps, formulaPE] = await Promise.all([
    estado.categorias(), estado.lancamentos(), estado.competencias(), estado.configPE()
  ]);

  // competências que realmente têm lançamento — o mês corrente vazio não conta.
  // Ordem cronológica (mais antigo à esquerda), como na planilha.
  const comMovimento = [...new Set(lancs.map(l => l.competencia))].filter(Boolean).sort();
  const compsAsc = [...comps].sort();

  // por padrão mostra todas; um ?mes=… na URL restringe àquele mês
  const selecionadas = ctx.params.mes && comps.includes(ctx.params.mes)
    ? [ctx.params.mes]
    // cópia: `selecionadas` é mutada por alternar(), e não pode levar
    // `comMovimento` junto — é ela que o atalho "Todos" usa para restaurar
    : (comMovimento.length ? [...comMovimento] : [comps[0] || competenciaHoje()]);

  S = {
    ctx, cats, lancs, comps: compsAsc, comMovimento, formulaPE,
    selecionadas,
    colapsados: new Set(),
    zeradas: true,
    mostrarAV: true
  };

  const raiz = document.createDocumentFragment();
  S.painel = el('div', {});
  raiz.append(S.painel);
  pintar();
  return raiz;
}

function pintar() {
  S.painel.textContent = '';

  const dres = calcularVarias(S.lancs, S.cats, S.selecionadas, { formulaPE: S.formulaPE });
  const principal = dres.get(S.selecionadas[S.selecionadas.length - 1]);

  /* ---- cabeçalho ---- */
  const cabecalho = el('div', { class: 'page-head' },
    el('h1', { class: 'page-title', text: 'DRE Gerencial' }),
    el('div', { class: 'page-desc' },
      S.selecionadas.length > 1
        ? `${S.selecionadas.length} competências: ${S.selecionadas.map(competenciaCurta).join(' · ')}`
        : `Competência de ${competenciaLonga(S.selecionadas[0])}`)
  );

  const pills = el('div', { class: 'pills' });
  for (const c of S.comps) {
    const ativo = S.selecionadas.includes(c);
    const temMovimento = S.comMovimento.includes(c);
    pills.append(el('button', {
      class: 'pill', type: 'button', 'aria-pressed': String(ativo),
      title: (ativo ? 'Tirar da comparação' : 'Pôr na comparação') + (temMovimento ? '' : ' — sem lançamentos'),
      style: temMovimento ? '' : 'opacity:.55',
      onclick: () => alternar(c)
    }, competenciaCurta(c)));
  }

  pills.append(el('span', { class: 'faint', style: 'margin: 0 4px 0 8px' }, '|'));
  pills.append(el('button', {
    class: 'pill', type: 'button', title: 'Mostrar todas as competências com lançamento',
    onclick: () => { S.selecionadas = [...S.comMovimento]; pintar(); }
  }, 'Todos'));
  pills.append(el('button', {
    class: 'pill', type: 'button', title: 'Voltar a um mês só',
    onclick: () => { S.selecionadas = [S.comMovimento[S.comMovimento.length - 1] || S.comps[S.comps.length - 1]]; pintar(); }
  }, 'Só o último'));

  cabecalho.append(pills);
  S.painel.append(cabecalho);

  /* ---- barra de ações ---- */
  const barra = el('div', { class: 'toolbar' });

  const chkZeradas = el('input', { type: 'checkbox', checked: S.zeradas });
  chkZeradas.addEventListener('change', () => { S.zeradas = chkZeradas.checked; pintar(); });
  barra.append(el('label', { class: 'check' }, chkZeradas, el('span', { text: 'Mostrar linhas zeradas' })));

  const selPE = selectSimples(
    Object.entries(FORMULAS_PE).map(([k, v]) => ({ valor: k, rotulo: v.rotulo })),
    S.formulaPE, { class: 'select select-sm', title: 'Fórmula do ponto de equilíbrio' });
  selPE.addEventListener('change', async () => {
    S.formulaPE = selPE.value;
    await db.setConfig('formula_pe', S.formulaPE);
    pintar();
  });
  const chkAV = el('input', { type: 'checkbox', checked: S.mostrarAV });
  chkAV.addEventListener('change', () => { S.mostrarAV = chkAV.checked; pintar(); });
  barra.append(el('label', { class: 'check', title: 'Cada mês ocupa duas colunas quando o %AV está ligado' },
    chkAV, el('span', { text: 'Mostrar %AV' })));

  barra.append(el('span', { class: 'muted', style: 'font-size:12px' }, 'Ponto de equilíbrio:'), selPE);

  barra.append(el('span', { style: 'flex:1' }));
  barra.append(el('button', { class: 'btn btn-sm', onclick: () => exportarXLSX(dres) }, icone('baixar', 14), 'Exportar .xlsx'));
  barra.append(el('button', { class: 'btn btn-sm', onclick: () => exportarCSV(dres) }, icone('baixar', 14), 'Exportar .csv'));
  if (auth.pode('fechar_competencia')) {
    barra.append(el('button', { class: 'btn btn-sm btn-ghost', onclick: fecharCompetencia }, icone('cadeado', 14), 'Fechar competência'));
  }
  S.painel.append(barra);

  /* ---- resumo em cartões: soma do período selecionado ---- */
  const soma = chave => round2(S.selecionadas.reduce((a, c) => a + (dres.get(c).totais[chave] || 0), 0));
  const varios = S.selecionadas.length > 1;
  const rodape = varios
    ? `soma de ${S.selecionadas.length} meses`
    : competenciaLonga(S.selecionadas[0]);

  // cada card diz também quanto aquilo representa do faturamento do período
  const receita = varios ? soma('RECEITA_TOTAL') : principal.totais.RECEITA_TOTAL;
  const valorDe = chave => varios ? soma(chave) : principal.totais[chave];
  const pctFat = v => receita ? (v / receita * 100).toFixed(1).replace('.', ',') + '% do faturamento' : '';

  S.painel.append(el('div', { class: 'grid', style: 'margin-bottom:20px' },
    resumo('Receita líquida', valorDe('RECEITA_LIQUIDA'), false, rodape, pctFat(valorDe('RECEITA_LIQUIDA'))),
    resumo('Lucro bruto', valorDe('LUCRO_BRUTO'), false, rodape, pctFat(valorDe('LUCRO_BRUTO'))),
    resumo('Lucro operacional', valorDe('LUCRO_OPERACIONAL'), false, rodape, pctFat(valorDe('LUCRO_OPERACIONAL'))),
    resumo('Lucro líquido', valorDe('LUCRO_LIQUIDO'), true, rodape, pctFat(valorDe('LUCRO_LIQUIDO')))
  ));

  /* ---- tabela ---- */
  // painel congelado como no Excel: cabeçalho dos meses e coluna da conta
  // ficam fixos enquanto o resto rola (ver .dre-wrap no CSS)
  const wrap = el('div', { class: 'tbl-wrap dre-wrap' }, tabelaDRE(dres));
  S.painel.append(card({}, wrap));
  ajustarAlturaCongelada(wrap);

  /* ---- nota de rodapé ---- */
  S.painel.append(el('div', { class: 'faint', style: 'font-size:11.5px; margin-top:14px; line-height:1.7' },
    el('div', { text: `%AV = valor ÷ RECEITA TOTAL do mês. Entram na DRE apenas lançamentos com status Classificado ou Conferido; as categorias de controle (A CLASSIFICAR e EXCLUIR) ficam de fora.` }),
    el('div', { text: `Ponto de equilíbrio: ${FORMULAS_PE[S.formulaPE].rotulo}.` })
  ));
}

function resumo(rotulo, valor, destaque = false, rodape = '', percentual = '') {
  return el('div', { class: 'card sp-3' + (destaque ? ' destaque' : '') },
    el('div', { class: 'kpi' },
      el('div', { class: 'kpi-label', text: rotulo }),
      el('div', { class: 'kpi-value num' + (!destaque && valor < 0 ? ' neg' : ''), text: moeda(valor) }),
      el('div', { class: 'kpi-foot' },
        percentual ? el('span', { class: 'kpi-pct', text: percentual }) : null,
        rodape ? el('span', { text: rodape }) : null)));
}

function alternar(comp) {
  const i = S.selecionadas.indexOf(comp);
  if (i >= 0) {
    if (S.selecionadas.length === 1) { toast.aviso('Deixe ao menos uma competência selecionada.'); return; }
    S.selecionadas.splice(i, 1);
  } else {
    S.selecionadas.push(comp);
  }
  S.selecionadas.sort();
  pintar();
}

/* ------------------------------------------------------------
   Tabela
   ------------------------------------------------------------ */

/**
 * A tabela ocupa exatamente o que sobra da janela abaixo dos cards: assim a
 * página não rola, quem rola é a tabela — e o cabeçalho dos meses e a coluna
 * Conta ficam congelados como no Excel. Recalcula ao redimensionar.
 */
function ajustarAlturaCongelada(wrap) {
  const medir = () => {
    if (!wrap.isConnected) { window.removeEventListener('resize', medir); return; }
    const topo = wrap.getBoundingClientRect().top;
    wrap.style.maxHeight = Math.max(320, window.innerHeight - topo - 28) + 'px';
  };
  requestAnimationFrame(medir);
  window.addEventListener('resize', medir);
}

function tabelaDRE(dres) {
  const comps = S.selecionadas;
  const comparando = comps.length > 1;

  const thead = el('thead');
  const trh = el('tr', {}, el('th', {}, 'Conta'));
  for (const c of comps) {
    trh.append(el('th', { class: 'right' }, competenciaCurta(c)));
    if (S.mostrarAV) trh.append(el('th', { class: 'right av' }, '%AV'));
  }
  if (comparando) {
    trh.append(el('th', {
      class: 'right',
      title: `Variação de ${competenciaCurta(comps[0])} para ${competenciaCurta(comps[comps.length - 1])}`
    }, `Var. ${competenciaCurta(comps[0])} → ${competenciaCurta(comps[comps.length - 1])}`));
  }
  thead.append(trh);

  const tbody = el('tbody');
  const linhas = dres.get(comps[0]).linhas;

  for (const linha of linhas) {
    if (escondida(linha)) continue;

    const valores = comps.map(c => valorDaLinha(dres.get(c), linha));
    if (!S.zeradas && linha.kind === 'item' && valores.every(v => !v.valor)) continue;

    const classe = {
      grupo: 'l-grupo', sub: 'l-sub', item: 'l-item',
      total: 'l-total', pe: 'l-pe'
    }[linha.kind] || '';
    const nivel = linha.kind === 'item' && linha.nivel === 2 ? ' nivel2' : '';

    const tr = el('tr', { class: classe + nivel + (valores.every(v => !v.valor) ? ' zerada' : '') });

    /* primeira coluna: rótulo, com toggle nos grupos e subgrupos */
    const primeira = el('td');
    if (linha.kind === 'grupo' || linha.kind === 'sub') {
      const aberto = !S.colapsados.has(linha.id);
      primeira.append(el('button', {
        class: 'dre-toggle', type: 'button', 'aria-expanded': String(aberto),
        onclick: () => { aberto ? S.colapsados.add(linha.id) : S.colapsados.delete(linha.id); pintar(); }
      }, el('span', { class: 'caret', 'aria-hidden': 'true', text: '▾' }), linha.rotulo));
    } else {
      primeira.textContent = linha.rotulo;
    }
    tr.append(primeira);

    for (const v of valores) {
      tr.append(el('td', { class: v.valor < 0 ? 'neg' : '' }, moeda(v.valor)));
      if (S.mostrarAV) tr.append(el('td', { class: 'av' }, linha.kind === 'pe' ? '—' : pct(v.av)));
    }

    if (comparando) {
      // do mais antigo (esquerda) para o mais recente (direita)
      const a = valores[valores.length - 1].valor, b = valores[0].valor;
      const varia = b ? ((a - b) / Math.abs(b)) * 100 : null;
      tr.append(el('td', { class: varia == null ? 'faint' : (varia >= 0 ? 'pos' : 'neg') },
        varia == null ? '—' : (varia >= 0 ? '+' : '') + pct(varia)));
    }

    tbody.append(tr);
  }

  return el('table', { class: 'dre' }, thead, tbody);
}

function escondida(linha) {
  if (!linha.pai) return false;
  if (S.colapsados.has(linha.pai)) return true;
  // item dentro de subgrupo colapsado, cujo pai é o bloco de despesas fixas
  const raizDoPai = String(linha.pai).split(':')[0];
  return raizDoPai !== linha.pai && S.colapsados.has(raizDoPai);
}

function valorDaLinha(dre, modelo) {
  const l = dre.linhas.find(x => x.id === modelo.id);
  return l ? { valor: l.valor, av: l.av } : { valor: 0, av: 0 };
}

/* ------------------------------------------------------------
   Fechamento de competência
   ------------------------------------------------------------ */

async function fecharCompetencia() {
  const comp = S.selecionadas[0];
  const jaFechada = await estado.estaFechada(comp);

  if (jaFechada) {
    const ok = await modal.confirmar('Reabrir competência',
      `A competência ${competenciaLonga(comp)} está fechada. Reabrir permite editar e apagar lançamentos deste mês.`,
      { rotuloOk: 'Reabrir' });
    if (!ok) return;
    await db.remover('competencia_fechada', comp);
    estado.invalidar('fechadas');
    toast.ok(`${competenciaLonga(comp)} reaberta.`);
    return;
  }

  const pendentes = S.lancs.filter(l => l.competencia === comp && l.status === 'A_CLASSIFICAR').length;
  const ok = await modal.confirmar('Fechar competência',
    `Fechar <b>${competenciaLonga(comp)}</b>? Depois disso nenhum lançamento deste mês poderá ser criado, editado ou apagado.` +
    (pendentes ? `<br><br><b>Atenção:</b> ainda há ${pendentes} lançamento(s) em A CLASSIFICAR, que ficarão fora da DRE.` : ''),
    { rotuloOk: 'Fechar competência' });
  if (!ok) return;

  await db.atualizar('competencia_fechada', {
    competencia: comp,
    empresa_id: db.EMPRESA_LOCAL,
    fechada_em: new Date().toISOString(),
    fechada_por: auth.sessao().usuario_id
  });
  estado.invalidar('fechadas');
  await db.auditar('competencia_fechada', null, 'INSERT', null, { competencia: comp }, auth.sessao().usuario_id);
  toast.ok(`${competenciaLonga(comp)} fechada.`);
}

/* ------------------------------------------------------------
   Exportação
   ------------------------------------------------------------ */

function matrizExport(dres) {
  const comps = S.selecionadas;
  const cab = ['Conta'];
  for (const c of comps) {
    cab.push(competenciaLonga(c));
    if (S.mostrarAV) cab.push('%AV ' + competenciaCurta(c));
  }
  const linhas = [cab];

  for (const linha of dres.get(comps[0]).linhas) {
    const valores = comps.map(c => valorDaLinha(dres.get(c), linha));
    const prefixo = linha.kind === 'item' ? (linha.nivel === 2 ? '      ' : '   ') : '';
    const l = [prefixo + linha.rotulo];
    for (const v of valores) {
      l.push(v.valor);
      if (S.mostrarAV) l.push(linha.kind === 'pe' ? '' : Number((v.av || 0).toFixed(2)));
    }
    linhas.push(l);
  }
  return linhas;
}

function exportarCSV(dres) {
  const linhas = matrizExport(dres);
  const csv = '﻿' + linhas.map(l => l.map(v =>
    csvCampo(typeof v === 'number' ? v.toFixed(2).replace('.', ',') : v)).join(';')).join('\r\n');
  baixarArquivo(`DRE-${S.selecionadas.join('_')}.csv`, csv, 'text/csv');
  toast.ok('DRE exportada em CSV.');
}

function exportarXLSX(dres) {
  const XLSX = globalThis.XLSX;
  if (!XLSX) { toast.erro('SheetJS não carregou.'); return; }
  const linhas = matrizExport(dres);
  const ws = XLSX.utils.aoa_to_sheet(linhas);

  ws['!cols'] = [{ wch: 44 }, ...S.selecionadas.flatMap(() =>
    S.mostrarAV ? [{ wch: 16 }, { wch: 9 }] : [{ wch: 16 }])];

  // formato monetário nas colunas de valor
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let r = 1; r <= range.e.r; r++) {
    for (let c = 1; c <= range.e.c; c++) {
      const cel = ws[XLSX.utils.encode_cell({ r, c })];
      if (!cel || typeof cel.v !== 'number') continue;
      cel.z = (!S.mostrarAV || c % 2 === 1) ? '#,##0.00' : '0.0"%"';
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'DRE');
  XLSX.writeFile(wb, `DRE-${S.selecionadas.join('_')}.xlsx`);
  toast.ok('DRE exportada em XLSX.');
}

export default { titulo, render };
