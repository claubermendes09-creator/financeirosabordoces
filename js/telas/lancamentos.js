/* ============================================================
   telas/lancamentos.js — lista, filtros, edição e recategorização
   ============================================================ */

import db from '../db.js';
import auth from '../auth.js';
import estado from '../estado.js';
import { montarHistorico } from '../importadores/index.js';
import { nucleoDescricao, ensinar } from '../aprendizado.js';
import {
  el, moeda, dataBR, competenciaLonga, competenciaCurta, truncar,
  normalizar, debounce, inteiro, esc, baixarArquivo, csvCampo
} from '../util.js';
import { selectCategorias, selectSimples, badgeStatus, badgeOrigem, icone } from '../ui/componentes.js';
import modal from '../ui/modal.js';
import toast from '../ui/toast.js';
import { ordenavel } from '../ui/tabela.js';

export const titulo = 'Lançamentos';

let S = null;

export async function render(ctx) {
  const [cats, contas, lancs, comps] = await Promise.all([
    estado.categorias(), estado.contas(), estado.lancamentos(), estado.competencias()
  ]);

  S = {
    ctx, cats, contas, lancs, comps,
    catMap: await estado.catPorId(),
    contaMap: await estado.contaPorId(),
    filtros: {
      mes: ctx.params.mes || '',
      conta: ctx.params.conta || '',
      categoria: ctx.params.categoria || '',
      status: ctx.params.status || '',
      texto: ctx.params.q || ''
    },
    selecionados: new Set(),
    ordem: null,
    pagina: 1,
    porPagina: 100
  };
  // mesmo resumo da fila de classificação: como aquele favorecido já caiu antes
  S.historico = montarHistorico(lancs, cats);

  const raiz = document.createDocumentFragment();
  raiz.append(el('div', { class: 'page-head' },
    el('h1', { class: 'page-title', text: 'Lançamentos' }),
    el('div', { class: 'page-desc', text: 'Filtre, corrija a categoria na própria linha e recategorize em lote.' })
  ));

  S.painel = el('div', {});
  raiz.append(S.painel);
  pintar();
  return raiz;
}

function filtrados() {
  const f = S.filtros;
  const q = normalizar(f.texto);
  return S.lancs.filter(l => {
    if (f.mes && l.competencia !== f.mes) return false;
    if (f.conta && l.conta_id !== f.conta) return false;
    if (f.categoria && l.categoria_id !== f.categoria) return false;
    if (f.status && l.status !== f.status) return false;
    if (q) {
      const alvo = normalizar([l.descricao, l.favorecido, l.documento, l.observacao].filter(Boolean).join(' '));
      if (!alvo.includes(q)) return false;
    }
    return true;
  }).sort(comparadorAtual());
}

/* colunas da tabela, na ordem do cabeçalho: como extrair o valor de ordenação */
const COLUNAS_ORD = {
  1: l => l.data, 2: l => normalizar(l.descricao), 3: l => (S.contaMap.get(l.conta_id) || {}).nome || '',
  4: l => Number(l.valor || 0), 5: l => (S.catMap.get(l.categoria_id) || {}).nome || '',
  6: l => l.status, 7: l => l.origem
};

function comparadorAtual() {
  const o = S.ordem;
  const chave = o && COLUNAS_ORD[o.indice];
  if (!chave) return (a, b) => (b.data.localeCompare(a.data)) || (b.criado_em || '').localeCompare(a.criado_em || '');
  const sinal = o.direcao === 'desc' ? -1 : 1;
  return (a, b) => {
    const va = chave(a), vb = chave(b);
    const r = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb), 'pt-BR', { numeric: true });
    return sinal * (r || b.data.localeCompare(a.data));
  };
}

function pintar() {
  S.painel.textContent = '';
  S.painel.append(barraFiltros());

  const lista = filtrados();
  const total = lista.reduce((a, b) => a + Number(b.valor || 0), 0);
  const pendentes = lista.filter(l => l.status === 'A_CLASSIFICAR').length;

  S.painel.append(el('div', { class: 'stat-row', style: 'margin:4px 0 16px' },
    stat('Lançamentos', inteiro(lista.length)),
    stat('Soma dos valores', moeda(total)),
    stat('A classificar', inteiro(pendentes))
  ));

  if (S.selecionados.size) S.painel.append(barraLote());

  const paginados = lista.slice(0, S.pagina * S.porPagina);
  S.painel.append(tabelaLancamentos(paginados));

  if (paginados.length < lista.length) {
    S.painel.append(el('div', { class: 'form-actions', style: 'margin-top:16px; justify-content:center' },
      el('button', { class: 'btn', onclick: () => { S.pagina++; pintar(); } },
        `Mostrar mais (${inteiro(lista.length - paginados.length)} restantes)`)));
  }
}

function stat(rotulo, valor) {
  return el('div', { class: 'stat' },
    el('div', { class: 's-l', text: rotulo }),
    el('div', { class: 's-v', text: valor }));
}

/* ------------------------------------------------------------
   Filtros
   ------------------------------------------------------------ */

function barraFiltros() {
  const f = S.filtros;
  const barra = el('div', { class: 'toolbar' });

  const busca = el('input', {
    class: 'input', type: 'search', placeholder: 'Buscar por descrição, favorecido ou documento…', value: f.texto, id: 'l-busca'
  });
  // pintar() troca a caixa por outra: o foco tem de ir para a NOVA, com o
  // cursor no fim, senão cada palavra digitada exige clicar de novo
  busca.addEventListener('input', debounce(() => {
    f.texto = busca.value; S.pagina = 1; pintar();
    const nova = document.getElementById('l-busca');
    if (nova) { nova.focus(); const n = nova.value.length; try { nova.setSelectionRange(n, n); } catch { /* type=search em alguns navegadores */ } }
  }, 260));
  barra.append(el('div', { class: 'grow' }, busca));

  const selMes = selectSimples(
    [{ valor: '', rotulo: 'Todos os meses' }, ...S.comps.map(c => ({ valor: c, rotulo: competenciaLonga(c) }))],
    f.mes, { class: 'select select-sm' });
  selMes.addEventListener('change', () => { f.mes = selMes.value; S.pagina = 1; pintar(); });

  const selConta = selectSimples(
    [{ valor: '', rotulo: 'Todas as contas' }, ...S.contas.map(c => ({ valor: c.id, rotulo: c.nome }))],
    f.conta, { class: 'select select-sm' });
  selConta.addEventListener('change', () => { f.conta = selConta.value; S.pagina = 1; pintar(); });

  const selCat = selectCategorias(S.cats, f.categoria, { class: 'select select-sm', placeholder: 'Todas as categorias' });
  selCat.addEventListener('change', () => { f.categoria = selCat.value; S.pagina = 1; pintar(); });

  const selStatus = selectSimples([
    { valor: '', rotulo: 'Todos os status' },
    { valor: 'A_CLASSIFICAR', rotulo: 'A classificar' },
    { valor: 'CLASSIFICADO', rotulo: 'Classificado' },
    { valor: 'CONFERIDO', rotulo: 'Conferido' },
    { valor: 'EXCLUIDO', rotulo: 'Excluído' }
  ], f.status, { class: 'select select-sm' });
  selStatus.addEventListener('change', () => { f.status = selStatus.value; S.pagina = 1; pintar(); });

  barra.append(selMes, selConta, selCat, selStatus);

  const rapido = el('button', {
    class: 'pill', type: 'button', 'aria-pressed': String(f.status === 'A_CLASSIFICAR'),
    onclick: () => { f.status = f.status === 'A_CLASSIFICAR' ? '' : 'A_CLASSIFICAR'; S.pagina = 1; pintar(); }
  }, 'Somente A CLASSIFICAR');

  const limpar = el('button', {
    class: 'btn btn-sm btn-ghost',
    onclick: () => { S.filtros = { mes: '', conta: '', categoria: '', status: '', texto: '' }; S.pagina = 1; pintar(); }
  }, 'Limpar filtros');

  const exportar = el('button', { class: 'btn btn-sm btn-ghost', onclick: exportarCSV }, icone('baixar', 14), 'CSV');

  barra.append(rapido, limpar, exportar);
  return barra;
}

/* ------------------------------------------------------------
   Ações em lote
   ------------------------------------------------------------ */

function barraLote() {
  const sel = selectCategorias(S.cats, null, { class: 'select select-sm', placeholder: 'Recategorizar para…' });
  sel.addEventListener('change', () => { if (sel.value) recategorizarLote(sel.value); });

  return el('div', { class: 'alerta info', style: 'margin-bottom:16px' },
    icone('filtro', 18),
    el('span', { html: `<b>${S.selecionados.size}</b> lançamento(s) selecionado(s).` }),
    sel,
    auth.pode('apagar_lancamento')
      ? el('button', { class: 'btn btn-sm btn-danger', onclick: apagarLote }, icone('lixo', 14), 'Apagar')
      : null,
    el('button', { class: 'btn btn-sm btn-ghost', onclick: () => { S.selecionados.clear(); pintar(); } }, 'Limpar seleção')
  );
}

async function recategorizarLote(categoriaId) {
  if (!auth.pode('editar_lancamento')) { toast.erro('Sem permissão para editar lançamentos.'); return; }
  const cat = S.catMap.get(categoriaId);
  const alvos = S.lancs.filter(l => S.selecionados.has(l.id));
  const bloqueados = await comFechada(alvos);
  if (bloqueados.length) { toast.erro(`${bloqueados.length} lançamento(s) estão em competência fechada.`); return; }

  const ok = await modal.confirmar('Recategorizar em lote',
    `Mover <b>${alvos.length}</b> lançamento(s) para <b>${esc(cat.nome)}</b>?`, { rotuloOk: 'Recategorizar' });
  if (!ok) { pintar(); return; }

  const ops = alvos.map(l => ({
    acao: 'atualizar',
    dados: { ...l, categoria_id: categoriaId, status: statusPara(cat) }
  }));
  await db.emLote('lancamento', ops);
  await db.auditar('lancamento', null, 'UPDATE', { ids: alvos.map(l => l.id) }, { categoria_id: categoriaId }, auth.sessao().usuario_id);

  // uma passada de aprendizado para o lote inteiro: uma escrita por regra
  const aprendeu = await ensinar(alvos.map(l => ({ linha: l, categoria_id: categoriaId })));

  estado.invalidar('lancamentos');
  S.lancs = await estado.lancamentos();
  S.historico = montarHistorico(S.lancs, S.cats);
  S.selecionados.clear();
  toast.ok(`${alvos.length} lançamento(s) recategorizado(s).` +
    (aprendeu.regras ? ` ${aprendeu.regras} regra(s) da memória atualizada(s).` : ''));
  pintar();
}

async function apagarLote() {
  const alvos = S.lancs.filter(l => S.selecionados.has(l.id));
  const bloqueados = await comFechada(alvos);
  if (bloqueados.length) { toast.erro(`${bloqueados.length} lançamento(s) estão em competência fechada.`); return; }

  const ok = await modal.confirmar('Apagar lançamentos',
    `Apagar definitivamente <b>${alvos.length}</b> lançamento(s)? Esta ação não pode ser desfeita.`,
    { rotuloOk: 'Apagar', perigo: true });
  if (!ok) return;

  await db.emLote('lancamento', alvos.map(l => ({ acao: 'remover', id: l.id })));
  await db.auditar('lancamento', null, 'DELETE', { ids: alvos.map(l => l.id) }, null, auth.sessao().usuario_id);
  estado.invalidar('lancamentos');
  S.lancs = await estado.lancamentos();
  S.historico = montarHistorico(S.lancs, S.cats);
  S.selecionados.clear();
  toast.ok(`${alvos.length} lançamento(s) apagado(s).`);
  pintar();
}

async function comFechada(lista) {
  const fechadas = new Set((await estado.fechadas()).map(f => f.competencia));
  return lista.filter(l => fechadas.has(l.competencia));
}

function statusPara(cat) {
  if (!cat) return 'A_CLASSIFICAR';
  if (cat.nome === 'A CLASSIFICAR') return 'A_CLASSIFICAR';
  if (cat.nome === 'EXCLUIR') return 'EXCLUIDO';
  return 'CLASSIFICADO';
}

/* ------------------------------------------------------------
   Tabela
   ------------------------------------------------------------ */

function tabelaLancamentos(lista) {
  const podeEditar = auth.pode('editar_lancamento');
  const podeApagar = auth.pode('apagar_lancamento');

  const chkTodos = el('input', { type: 'checkbox', title: 'Selecionar os visíveis' });
  chkTodos.addEventListener('change', () => {
    for (const l of lista) chkTodos.checked ? S.selecionados.add(l.id) : S.selecionados.delete(l.id);
    pintar();
  });

  const tbody = el('tbody');
  for (const l of lista) {
    const chk = el('input', { type: 'checkbox', checked: S.selecionados.has(l.id) });
    chk.addEventListener('change', () => {
      chk.checked ? S.selecionados.add(l.id) : S.selecionados.delete(l.id);
      pintar();
    });

    const sel = selectCategorias(S.cats, l.categoria_id, {
      class: 'select select-sm', placeholder: false, disabled: !podeEditar
    });
    sel.addEventListener('change', () => trocarCategoria(l, sel.value));

    tbody.append(el('tr', { class: S.selecionados.has(l.id) ? 'sel' : '' },
      el('td', {}, chk),
      el('td', { class: 'nowrap' }, dataBR(l.data)),
      el('td', {},
        el('div', { title: l.descricao, text: truncar(l.descricao, 46) }),
        l.favorecido ? el('div', { class: 'faint', style: 'font-size:11px', text: truncar(l.favorecido, 40) }) : null),
      el('td', { class: 'nowrap' }, (S.contaMap.get(l.conta_id) || {}).nome || '—'),
      el('td', { class: 'right money', style: l.sentido === 'DEBITO' ? '' : 'color:var(--pos)' },
        (l.sentido === 'DEBITO' ? '−' : '+') + moeda(l.valor)),
      el('td', {}, sel, historicoDaLinha(l)),
      el('td', {}, badgeStatus(l.status)),
      el('td', {}, badgeOrigem(l.origem, l.recorrente)),
      el('td', { class: 'right nowrap' },
        el('button', {
          class: 'btn btn-sm btn-icon btn-ghost', title: 'Detalhes / editar',
          onclick: () => abrirDetalhe(l)
        }, icone('editar', 14)),
        podeApagar
          ? el('button', {
            class: 'btn btn-sm btn-icon btn-ghost', title: 'Apagar',
            style: 'margin-left:6px', onclick: () => apagarUm(l)
          }, icone('lixo', 14))
          : null)
    ));
  }

  if (!lista.length) {
    tbody.append(el('tr', {}, el('td', { colspan: 9 },
      el('div', { class: 'vazio', text: 'Nenhum lançamento com estes filtros.' }))));
  }

  const t = el('table', { class: 'tbl', style: 'min-width:1050px' },
    el('thead', {}, el('tr', {},
      el('th', { style: 'width:34px' }, chkTodos),
      el('th', {}, 'Data'), el('th', {}, 'Descrição'), el('th', {}, 'Conta'),
      el('th', { class: 'right' }, 'Valor'), el('th', {}, 'Categoria'),
      el('th', {}, 'Status'), el('th', {}, 'Origem'), el('th', { class: 'right' }, '')
    )), tbody);

  ordenavel(t, { atual: S.ordem, aoOrdenar: (indice, direcao) => { S.ordem = { indice, direcao }; S.pagina = 1; pintar(); } });
  return el('div', { class: 'tbl-scroll' }, t);
}

/**
 * Resumo curto de como este mesmo favorecido foi classificado nas OUTRAS
 * vezes — a própria linha sai da conta, senão ela apareceria confirmando
 * a si mesma. É o mesmo formato da fila de importação.
 */
function historicoDaLinha(l) {
  const h = S.historico.get(chaveDoLancamento(l));
  if (!h) return null;

  // desconta a contribuição da própria linha
  const itens = h.itens
    .map(x => ({ ...x, n: x.categoria_id === l.categoria_id ? x.n - 1 : x.n }))
    .filter(x => x.n > 0);
  if (!itens.length) return null;

  const combina = itens[0].categoria_id === l.categoria_id;
  const resumo = itens.slice(0, 3).map(x => x.n + 'x ' + x.nome).join(' · ');
  const sobra = itens.length > 3 ? ' +' + (itens.length - 3) : '';

  return el('div', {
    class: 'hist' + (combina ? ' ok' : ''),
    title: 'Outros lançamentos de "' + (l.favorecido || l.descricao) + '": ' +
      itens.map(x => x.n + 'x ' + x.nome).join(' · ')
  }, 'antes: ' + resumo + sobra);
}

/** Mesma chave que a fila de classificação usa para agrupar por fornecedor. */
function chaveDoLancamento(l) {
  const fav = normalizar(l.favorecido);
  if (fav && fav.length >= 4) return fav;
  const nucleo = nucleoDescricao(l.descricao);
  return nucleo && nucleo.length >= 8 ? nucleo : '\u0000';
}

async function trocarCategoria(l, categoriaId) {
  if (await estado.estaFechada(l.competencia)) {
    toast.erro(`A competência ${competenciaCurta(l.competencia)} está fechada.`);
    pintar(); return;
  }
  const cat = S.catMap.get(categoriaId);
  const novo = { ...l, categoria_id: categoriaId, status: statusPara(cat) };
  await db.atualizar('lancamento', novo);
  await db.auditar('lancamento', l.id, 'UPDATE', { categoria_id: l.categoria_id }, { categoria_id: categoriaId }, auth.sessao().usuario_id);

  // a correção também ensina: sem isso o mês seguinte repetiria o engano
  const aprendeu = await ensinar([{ linha: l, categoria_id: categoriaId }]);

  estado.invalidar('lancamentos');
  S.lancs = await estado.lancamentos();
  S.historico = montarHistorico(S.lancs, S.cats);
  toast.ok(`Categoria alterada para ${cat.nome}.` +
    (aprendeu.regras ? ` ${aprendeu.regras} regra(s) da memória atualizada(s).` : ''));
  pintar();
}

async function apagarUm(l) {
  if (await estado.estaFechada(l.competencia)) { toast.erro('Competência fechada.'); return; }
  const ok = await modal.confirmar('Apagar lançamento',
    `Apagar <b>${esc(truncar(l.descricao, 60))}</b> de ${dataBR(l.data)} (${moeda(l.valor)})?`,
    { rotuloOk: 'Apagar', perigo: true });
  if (!ok) return;
  await db.remover('lancamento', l.id);
  await db.auditar('lancamento', l.id, 'DELETE', l, null, auth.sessao().usuario_id);
  estado.invalidar('lancamentos');
  S.lancs = await estado.lancamentos();
  S.historico = montarHistorico(S.lancs, S.cats);
  toast.ok('Lançamento apagado.');
  pintar();
}

async function abrirDetalhe(l) {
  const fechada = await estado.estaFechada(l.competencia);
  const podeEditar = auth.pode('editar_lancamento') && !fechada;

  const desc = el('input', { class: 'input', value: l.descricao, disabled: !podeEditar });
  const fav = el('input', { class: 'input', value: l.favorecido || '', disabled: !podeEditar });
  const obs = el('textarea', { class: 'textarea', rows: 3, disabled: !podeEditar }, l.observacao || '');
  const status = selectSimples([
    { valor: 'A_CLASSIFICAR', rotulo: 'A classificar' },
    { valor: 'CLASSIFICADO', rotulo: 'Classificado' },
    { valor: 'CONFERIDO', rotulo: 'Conferido' },
    { valor: 'EXCLUIDO', rotulo: 'Excluído' }
  ], l.status, { disabled: !podeEditar });

  const corpo = el('div', { class: 'form-grid' },
    linhaInfo('Data', dataBR(l.data)),
    linhaInfo('Competência', competenciaLonga(l.competencia) + (fechada ? ' (fechada)' : '')),
    linhaInfo('Valor', (l.sentido === 'DEBITO' ? '−' : '+') + moeda(l.valor)),
    linhaInfo('Conta', (S.contaMap.get(l.conta_id) || {}).nome || '—'),
    linhaInfo('Categoria', (S.catMap.get(l.categoria_id) || {}).nome || '—'),
    linhaInfo('Origem', l.origem + (l.arquivo_origem ? ` · ${l.arquivo_origem}` : '')),
    linhaInfo('Documento', l.documento || '—'),
    linhaInfo('Criado em', dataBR(l.criado_em)),
    campoLivre('Descrição', desc, 'sp-12'),
    campoLivre('Favorecido', fav, 'sp-6'),
    campoLivre('Status', status, 'sp-6'),
    campoLivre('Observação', obs, 'sp-12')
  );

  const acoes = [{ rotulo: 'Fechar', classe: 'btn-ghost', valor: null }];
  if (podeEditar) acoes.push({ rotulo: 'Salvar', classe: 'btn-primary', valor: 'salvar' });

  const r = await modal.abrir({ titulo: 'Detalhes do lançamento', corpo, acoes, largo: true });
  if (r !== 'salvar') return;

  const novo = {
    ...l,
    descricao: desc.value.trim() || l.descricao,
    favorecido: fav.value.trim() || null,
    observacao: obs.value.trim() || null,
    status: status.value
  };
  await db.atualizar('lancamento', novo);
  await db.auditar('lancamento', l.id, 'UPDATE', l, novo, auth.sessao().usuario_id);
  estado.invalidar('lancamentos');
  S.lancs = await estado.lancamentos();
  S.historico = montarHistorico(S.lancs, S.cats);
  toast.ok('Lançamento atualizado.');
  pintar();
}

function linhaInfo(rotulo, valor) {
  return el('div', { class: 'field sp-3' },
    el('label', { text: rotulo }),
    el('div', { style: 'font-size:13.5px; padding-top:2px', text: String(valor) }));
}

function campoLivre(rotulo, ctrl, span) {
  return el('div', { class: 'field ' + span }, el('label', { text: rotulo }), ctrl);
}

/* ------------------------------------------------------------
   Exportação
   ------------------------------------------------------------ */

function exportarCSV() {
  const lista = filtrados();
  const linhas = [['Data', 'Competência', 'Descrição', 'Favorecido', 'Documento', 'Conta', 'Categoria', 'Sentido', 'Valor', 'Status', 'Origem', 'Observação']];
  for (const l of lista) {
    linhas.push([
      dataBR(l.data), l.competencia, l.descricao, l.favorecido || '', l.documento || '',
      (S.contaMap.get(l.conta_id) || {}).nome || '', (S.catMap.get(l.categoria_id) || {}).nome || '',
      l.sentido, String(l.valor).replace('.', ','), l.status, l.origem, l.observacao || ''
    ]);
  }
  const csv = '﻿' + linhas.map(l => l.map(csvCampo).join(';')).join('\r\n');
  baixarArquivo(`lancamentos-${S.filtros.mes || 'todos'}.csv`, csv, 'text/csv');
  toast.ok(`${lista.length} lançamento(s) exportado(s).`);
}

export default { titulo, render };
