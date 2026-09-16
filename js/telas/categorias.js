/* ============================================================
   telas/categorias.js — plano de contas e memória de aprendizado
   ============================================================ */

import db from '../db.js';
import auth from '../auth.js';
import estado from '../estado.js';
import { GRUPOS_DESPESA_FIXA } from '../dre.js';
import { exportarMemoria, importarMemoria, reconstruirMemoria, nivelDe, ROTULO_NIVEL, CLASSE_NIVEL, TIPOS_MATCH } from '../aprendizado.js';
import {
  el, dataBR, inteiro, truncar, normalizar, debounce, esc,
  baixarArquivo, uuid, comRolagemMantida
} from '../util.js';
import { selectCategorias, selectSimples, campo, icone } from '../ui/componentes.js';
import modal from '../ui/modal.js';
import toast from '../ui/toast.js';
import { ordenavel } from '../ui/tabela.js';

export const titulo = 'Categorias & Regras';

const TIPOS = [
  ['RECEITA', 'Receita'], ['DEDUCAO', 'Dedução'], ['CUSTO_VARIAVEL', 'Custo variável'],
  ['DESPESA_FIXA', 'Despesa fixa'], ['DESPESA_FINANCEIRA', 'Despesa financeira'], ['CONTROLE', 'Controle']
];

const ROTULO_MATCH = {
  classificacao_exata: 'Classificação exata',
  documento_cnpj: 'CPF/CNPJ',
  favorecido: 'Favorecido',
  contem_descricao: 'Contém na descrição'
};

let S = null;

export async function render(ctx) {
  S = {
    ctx,
    aba: ctx.params.aba === 'regras' ? 'regras' : 'categorias',
    buscaCat: '', buscaRegra: '', filtroOrigem: '', filtroTipoMatch: ''
  };
  await recarregar();

  const raiz = document.createDocumentFragment();
  raiz.append(el('div', { class: 'page-head' },
    el('h1', { class: 'page-title', text: 'Categorias & Regras' }),
    el('div', { class: 'page-desc', text: 'O plano de contas define a DRE. As regras são a memória que sugere as categorias na importação.' }),
    el('div', { class: 'pills' },
      aba('categorias', `Categorias (${S.cats.length})`),
      aba('regras', `Regras (${S.regras.length})`))
  ));

  S.painel = el('div', {});
  raiz.append(S.painel);
  pintar();
  return raiz;
}

function aba(id, rotulo) {
  return el('button', {
    class: 'pill', type: 'button', 'aria-pressed': String(S.aba === id),
    onclick: () => { S.aba = id; pintar(); }
  }, rotulo);
}

async function recarregar() {
  estado.invalidar('categorias');
  S.cats = await estado.categorias();
  S.regras = await db.listar('regra');
  S.lancs = await estado.lancamentos();
  S.contas = await estado.contas();
  S.catMap = new Map(S.cats.map(c => [c.id, c]));
  S.usoPorCategoria = new Map();
  for (const l of S.lancs) {
    S.usoPorCategoria.set(l.categoria_id, (S.usoPorCategoria.get(l.categoria_id) || 0) + 1);
  }
}

function pintar() {
  return comRolagemMantida(S.painel, pintarAgora);
}

function pintarAgora() {
  S.painel.textContent = '';
  S.painel.append(S.aba === 'categorias' ? painelCategorias() : painelRegras());
  // mantém as pílulas em sincronia
  const pills = S.painel.parentElement && S.painel.parentElement.querySelectorAll('.page-head .pill');
  if (pills) pills.forEach((p, i) => p.setAttribute('aria-pressed', String((i === 0) === (S.aba === 'categorias'))));
}

/* ============================================================
   Categorias
   ============================================================ */

function painelCategorias() {
  const podeEditar = auth.pode('editar_categoria');
  const wrap = el('div', {});

  const barra = el('div', { class: 'toolbar' });
  const busca = el('input', { class: 'input', type: 'search', placeholder: 'Buscar categoria…', value: S.buscaCat, id: 'c-busca' });
  busca.addEventListener('input', debounce(() => { S.buscaCat = busca.value; pintar(); refocar('c-busca'); }, 250));
  barra.append(el('div', { class: 'grow' }, busca));
  if (podeEditar) {
    barra.append(el('button', { class: 'btn btn-sm btn-primary', onclick: () => editarCategoria(null) }, icone('lancar', 14), 'Nova categoria'));
  }
  wrap.append(barra);

  const q = normalizar(S.buscaCat);
  const filtrando = !!q;
  const lista = S.cats.filter(c => !q || normalizar(c.nome + ' ' + c.grupo).includes(q));

  // arrastar só faz sentido com a lista inteira à vista
  const arrastavel = podeEditar && !filtrando;

  wrap.append(el('div', { class: 'faint', style: 'font-size:12px; margin:-6px 0 12px' },
    arrastavel
      ? 'Arraste pela alça para reordenar. Soltar dentro de outro bloco move a categoria para ele. As setas fazem o mesmo pelo teclado.'
      : (filtrando ? 'Limpe a busca para poder reordenar arrastando.' : 'A ordem define a posição na DRE.')));

  const tbody = el('tbody');
  let grupoAtual = null;

  for (const c of lista) {
    if (c.grupo !== grupoAtual) {
      grupoAtual = c.grupo;
      const trGrupo = el('tr', { dataset: { grupo: c.grupo } }, el('td', {
        colspan: 6,
        style: 'font-weight:700; background:var(--scrim); font-size:11.5px; letter-spacing:.05em; text-transform:uppercase'
      }, c.grupo));
      if (arrastavel) ligarAlvoGrupo(trGrupo, c.grupo);
      tbody.append(trGrupo);
    }

    const usos = S.usoPorCategoria.get(c.id) || 0;
    const irmaos = lista.filter(x => x.grupo === c.grupo);
    const pos = irmaos.indexOf(c);

    const tr = el('tr', {
      class: arrastavel ? 'arrastavel' : '',
      draggable: arrastavel ? 'true' : null,
      dataset: { id: c.id, grupo: c.grupo }
    },
      el('td', { style: 'padding-left:10px' },
        el('div', { style: 'display:flex; align-items:center; gap:8px' },
          arrastavel
            ? el('span', { class: 'alca', title: 'Arraste para reordenar', 'aria-hidden': 'true' }, icone('arrastar', 16))
            : null,
          el('span', { text: c.nome }))),
      el('td', {}, (TIPOS.find(x => x[0] === c.tipo) || [])[1] || c.tipo),
      el('td', { class: 'right num faint', title: 'posição dentro do bloco' }, `${pos + 1}/${irmaos.length}`),
      el('td', { class: 'right num' }, inteiro(usos)),
      el('td', {}, c.ativa === false ? el('span', { class: 'faint', text: 'inativa' }) : el('span', { class: 'pos', text: 'ativa' })),
      el('td', { class: 'right nowrap' },
        arrastavel ? el('button', {
          class: 'btn btn-sm btn-icon btn-ghost', title: 'Mover para cima',
          disabled: pos === 0, onclick: () => moverPasso(c, -1)
        }, icone('cima', 14)) : null,
        arrastavel ? el('button', {
          class: 'btn btn-sm btn-icon btn-ghost', style: 'margin-left:4px', title: 'Mover para baixo',
          disabled: pos === irmaos.length - 1, onclick: () => moverPasso(c, 1)
        }, icone('baixo', 14)) : null,
        podeEditar ? el('button', { class: 'btn btn-sm btn-icon btn-ghost', style: 'margin-left:6px', title: 'Editar', onclick: () => editarCategoria(c) }, icone('editar', 14)) : null,
        podeEditar ? el('button', {
          class: 'btn btn-sm btn-icon btn-ghost', style: 'margin-left:6px', title: usos ? 'Possui lançamentos — não pode ser apagada' : 'Apagar',
          disabled: usos > 0, onclick: () => apagarCategoria(c)
        }, icone('lixo', 14)) : null)
    );

    if (arrastavel) ligarArrasto(tr, c);
    tbody.append(tr);
  }

  wrap.append(el('div', { class: 'tbl-scroll' },
    el('table', { class: 'tbl' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'Categoria'), el('th', {}, 'Tipo'),
        el('th', { class: 'right' }, 'Posição'), el('th', { class: 'right' }, 'Lançamentos'),
        el('th', {}, 'Situação'), el('th', { class: 'right' }, ''))),
      tbody)));

  return wrap;
}

/* ------------------------------------------------------------
   Reordenação por arrasto
   ------------------------------------------------------------ */

let _arrastado = null;

function limparMarcas() {
  for (const tr of document.querySelectorAll('tr.solta-antes, tr.solta-depois')) {
    tr.classList.remove('solta-antes', 'solta-depois');
  }
}

function ligarArrasto(tr, c) {
  tr.addEventListener('dragstart', ev => {
    _arrastado = c;
    tr.classList.add('arrastando');
    ev.dataTransfer.effectAllowed = 'move';
    // o Firefox exige algum dado no dataTransfer para iniciar o arrasto
    ev.dataTransfer.setData('text/plain', c.id);
  });

  tr.addEventListener('dragend', () => {
    tr.classList.remove('arrastando');
    limparMarcas();
    _arrastado = null;
  });

  tr.addEventListener('dragover', ev => {
    if (!_arrastado || _arrastado.id === c.id) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    const r = tr.getBoundingClientRect();
    const antes = (ev.clientY - r.top) < r.height / 2;
    limparMarcas();
    tr.classList.add(antes ? 'solta-antes' : 'solta-depois');
  });

  tr.addEventListener('dragleave', () => tr.classList.remove('solta-antes', 'solta-depois'));

  tr.addEventListener('drop', ev => {
    if (!_arrastado || _arrastado.id === c.id) return;
    ev.preventDefault();
    const r = tr.getBoundingClientRect();
    const antes = (ev.clientY - r.top) < r.height / 2;
    const origem = _arrastado;
    limparMarcas();
    _arrastado = null;
    soltar(origem, c, antes);
  });
}

/** Soltar sobre o título de um bloco põe a categoria no topo dele. */
function ligarAlvoGrupo(tr, grupo) {
  tr.addEventListener('dragover', ev => {
    if (!_arrastado) return;
    ev.preventDefault();
    limparMarcas();
    tr.classList.add('solta-depois');
  });
  tr.addEventListener('dragleave', () => tr.classList.remove('solta-depois'));
  tr.addEventListener('drop', ev => {
    if (!_arrastado) return;
    ev.preventDefault();
    const origem = _arrastado;
    limparMarcas();
    _arrastado = null;
    const primeiro = S.cats.filter(x => x.grupo === grupo && x.id !== origem.id)[0];
    if (primeiro) soltar(origem, primeiro, true);
  });
}

/** ▲▼: move uma posição dentro do próprio bloco. */
function moverPasso(c, passo) {
  const irmaos = S.cats.filter(x => x.grupo === c.grupo);
  const i = irmaos.indexOf(c);
  const alvo = irmaos[i + passo];
  if (!alvo) return;
  soltar(c, alvo, passo < 0);
}

/**
 * Insere `origem` imediatamente antes/depois de `alvo` e renumera tudo.
 * A categoria assume o bloco (e o tipo) de onde foi solta — é o bloco que
 * define em que linha da DRE ela entra.
 */
async function soltar(origem, alvo, antes) {
  if (!auth.pode('editar_categoria')) { toast.erro('Sem permissão para editar categorias.'); return; }
  if (origem.id === alvo.id) return;

  const mudouDeBloco = origem.grupo !== alvo.grupo;
  if (mudouDeBloco) {
    const usos = S.usoPorCategoria.get(origem.id) || 0;
    const ok = await modal.confirmar('Mover de bloco',
      `Mover <b>${esc(origem.nome)}</b> de <b>${esc(origem.grupo)}</b> para <b>${esc(alvo.grupo)}</b>?` +
      `<br><br>Isso muda a linha da DRE em que ela é somada` +
      (usos ? ` — e ela tem ${usos} lançamento(s).` : '.'),
      { rotuloOk: 'Mover' });
    if (!ok) { pintar(); return; }
  }

  const lista = [...S.cats].sort((a, b) => a.ordem - b.ordem);
  const iOrigem = lista.findIndex(x => x.id === origem.id);
  const [movida] = lista.splice(iOrigem, 1);
  let iAlvo = lista.findIndex(x => x.id === alvo.id);
  if (!antes) iAlvo++;
  lista.splice(iAlvo, 0, movida);

  movida.grupo = alvo.grupo;
  movida.tipo = alvo.tipo;

  const ops = [];
  lista.forEach((x, i) => {
    const nova = (i + 1) * 10;
    if (x.ordem !== nova || x.id === movida.id) {
      ops.push({ acao: 'atualizar', dados: { ...x, ordem: nova } });
    }
  });

  await db.emLote('categoria', ops);
  await db.auditar('categoria', movida.id, 'UPDATE',
    { grupo: origem.grupo, ordem: origem.ordem },
    { grupo: movida.grupo, ordem: movida.ordem }, auth.sessao().usuario_id);

  await recarregar();
  toast.ok(mudouDeBloco
    ? `${movida.nome} movida para ${movida.grupo}.`
    : `${movida.nome} reordenada.`);
  pintar();
}

async function editarCategoria(c) {
  const nome = el('input', { class: 'input', value: c ? c.nome : '', placeholder: 'Ex.: TAXA DE ENTREGA' });
  const tipo = selectSimples(TIPOS.map(([v, r]) => ({ valor: v, rotulo: r })), c ? c.tipo : 'DESPESA_FIXA');
  const grupos = [...new Set(S.cats.map(x => x.grupo))];
  const grupo = selectSimples(grupos.map(g => ({ valor: g, rotulo: g })), c ? c.grupo : GRUPOS_DESPESA_FIXA[1]);
  // a ordem não se digita mais: sai do arrasto na tabela
  const ordemAtual = c ? c.ordem : (Math.max(0, ...S.cats.map(x => x.ordem)) + 10);
  const ativa = el('input', { type: 'checkbox', checked: c ? c.ativa !== false : true });

  const corpo = el('div', { class: 'form-grid' },
    campo('Nome *', nome, { span: 'sp-12' }),
    campo('Tipo na DRE *', tipo, { span: 'sp-6' }),
    campo('Grupo (bloco pai) *', grupo, { span: 'sp-6' }),
    el('div', { class: 'field sp-6' }, el('label', { text: 'Posição na DRE' }),
      el('div', { class: 'hint', style: 'padding-top:10px' },
        c ? 'Arraste a linha na tabela para reordenar.' : 'Entra no fim do bloco escolhido; arraste depois se precisar.')),
    el('div', { class: 'field sp-6' }, el('label', { text: 'Situação' }),
      el('label', { class: 'check' }, ativa, el('span', { text: 'Categoria ativa' })))
  );

  const r = await modal.abrir({
    titulo: c ? 'Editar categoria' : 'Nova categoria', corpo, largo: true,
    acoes: [
      { rotulo: 'Cancelar', classe: 'btn-ghost', valor: null },
      { rotulo: 'Salvar', classe: 'btn-primary', valor: 'salvar' }
    ]
  });
  if (r !== 'salvar') return;

  const n = nome.value.trim();
  if (!n) { toast.erro('O nome é obrigatório.'); return; }
  const conflito = S.cats.find(x => normalizar(x.nome) === normalizar(n) && (!c || x.id !== c.id));
  if (conflito) { toast.erro('Já existe uma categoria com este nome.'); return; }

  const dados = {
    id: c ? c.id : uuid(), empresa_id: db.EMPRESA_LOCAL,
    nome: n, tipo: tipo.value, grupo: grupo.value,
    ordem: ordemAtual, ativa: ativa.checked
  };
  await db.atualizar('categoria', dados);
  await db.auditar('categoria', dados.id, c ? 'UPDATE' : 'INSERT', c || null, dados, auth.sessao().usuario_id);
  await recarregar();
  toast.ok(c ? 'Categoria atualizada.' : 'Categoria criada.');
  pintar();
}

async function apagarCategoria(c) {
  const usos = S.usoPorCategoria.get(c.id) || 0;
  if (usos) { toast.erro('Categoria com lançamentos não pode ser apagada.'); return; }
  const regras = S.regras.filter(r => r.categoria_id === c.id);
  const ok = await modal.confirmar('Apagar categoria',
    `Apagar <b>${esc(c.nome)}</b>?` + (regras.length ? ` ${regras.length} regra(s) da memória apontam para ela e também serão apagadas.` : ''),
    { rotuloOk: 'Apagar', perigo: true });
  if (!ok) return;

  await db.remover('categoria', c.id);
  if (regras.length) await db.emLote('regra', regras.map(r => ({ acao: 'remover', id: r.id })));
  await db.auditar('categoria', c.id, 'DELETE', c, null, auth.sessao().usuario_id);
  await recarregar();
  toast.ok('Categoria apagada.');
  pintar();
}

/* ============================================================
   Regras (memória de aprendizado)
   ============================================================ */

function painelRegras() {
  const podeEditar = auth.pode('editar_regra');
  const wrap = el('div', {});

  const barra = el('div', { class: 'toolbar' });
  const busca = el('input', { class: 'input', type: 'search', placeholder: 'Buscar padrão ou categoria…', value: S.buscaRegra, id: 'r-busca' });
  busca.addEventListener('input', debounce(() => { S.buscaRegra = busca.value; pintar(); refocar('r-busca'); }, 250));
  barra.append(el('div', { class: 'grow' }, busca));

  const selOrigem = selectSimples([
    { valor: '', rotulo: 'Todas as origens' },
    { valor: 'SEED', rotulo: 'Seed (De/Para inicial)' },
    { valor: 'APRENDIDA', rotulo: 'Aprendida' },
    { valor: 'MANUAL', rotulo: 'Manual' }
  ], S.filtroOrigem, { class: 'select select-sm' });
  selOrigem.addEventListener('change', () => { S.filtroOrigem = selOrigem.value; pintar(); });
  barra.append(selOrigem);

  const selTipo = selectSimples([
    { valor: '', rotulo: 'Todos os tipos' },
    ...TIPOS_MATCH.map(x => ({ valor: x, rotulo: ROTULO_MATCH[x] }))
  ], S.filtroTipoMatch, { class: 'select select-sm' });
  selTipo.addEventListener('change', () => { S.filtroTipoMatch = selTipo.value; pintar(); });
  barra.append(selTipo);

  if (podeEditar) barra.append(el('button', { class: 'btn btn-sm btn-primary', onclick: () => editarRegra(null) }, icone('lancar', 14), 'Nova regra'));
  if (podeEditar) {
    barra.append(el('button', {
      class: 'btn btn-sm', onclick: reconstruir,
      title: 'Gera as regras que faltam a partir dos lançamentos já classificados'
    }, icone('backup', 14), 'Reconstruir dos lançamentos'));
  }
  barra.append(el('button', { class: 'btn btn-sm btn-ghost', onclick: baixarMemoria }, icone('baixar', 14), 'Exportar JSON'));
  if (podeEditar) barra.append(el('button', { class: 'btn btn-sm btn-ghost', onclick: subirMemoria }, icone('importar', 14), 'Importar JSON'));
  wrap.append(barra);

  const q = normalizar(S.buscaRegra);
  const lista = S.regras
    .filter(r => !S.filtroOrigem || r.origem_regra === S.filtroOrigem)
    .filter(r => !S.filtroTipoMatch || r.tipo_match === S.filtroTipoMatch)
    .filter(r => {
      if (!q) return true;
      const cat = S.catMap.get(r.categoria_id);
      return normalizar(r.padrao + ' ' + (cat ? cat.nome : '')).includes(q);
    })
    .sort((a, b) => (b.acertos + b.erros) - (a.acertos + a.erros) || a.padrao_norm.localeCompare(b.padrao_norm, 'pt-BR'));

  const tbody = el('tbody');
  for (const r of lista) {
    const cat = S.catMap.get(r.categoria_id);
    const nivel = nivelDe(r);
    tbody.append(el('tr', {},
      el('td', {}, el('div', { title: r.padrao, text: truncar(r.padrao, 40) }),
        el('div', { class: 'faint', style: 'font-size:11px', text: r.padrao_norm })),
      el('td', {}, ROTULO_MATCH[r.tipo_match] || r.tipo_match),
      el('td', {}, cat ? cat.nome : el('span', { class: 'neg', text: 'categoria removida' })),
      el('td', {}, r.conta_id ? ((S.contas.find(c => c.id === r.conta_id) || {}).nome || '—') : el('span', { class: 'faint', text: 'todas' })),
      el('td', { class: 'right num' }, `${r.acertos || 0} / ${r.erros || 0}`),
      el('td', { class: 'right' }, el('span', { class: CLASSE_NIVEL[nivel], style: 'font-weight:600' },
        `${(r.confianca * 100).toFixed(0)}% · ${ROTULO_NIVEL[nivel]}`)),
      el('td', {}, el('span', { class: 'faint', style: 'font-size:11.5px', text: r.origem_regra })),
      el('td', { class: 'nowrap faint', style: 'font-size:11.5px' }, r.ultimo_uso ? dataBR(r.ultimo_uso) : '—'),
      el('td', { class: 'right nowrap' },
        podeEditar ? el('button', { class: 'btn btn-sm btn-icon btn-ghost', title: 'Editar', onclick: () => editarRegra(r) }, icone('editar', 14)) : null,
        podeEditar ? el('button', { class: 'btn btn-sm btn-icon btn-ghost', style: 'margin-left:6px', title: 'Apagar', onclick: () => apagarRegra(r) }, icone('lixo', 14)) : null)
    ));
  }
  if (!lista.length) {
    tbody.append(el('tr', {}, el('td', { colspan: 9 }, el('div', { class: 'vazio', text: 'Nenhuma regra com esse filtro.' }))));
  }

  wrap.append(el('div', { class: 'tbl-scroll' },
    ordenavel(el('table', { class: 'tbl', style: 'min-width:960px' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'Padrão'), el('th', {}, 'Tipo'), el('th', {}, 'Categoria'), el('th', {}, 'Conta'),
        el('th', { class: 'right' }, 'Acertos / Erros'), el('th', { class: 'right' }, 'Confiança'),
        el('th', {}, 'Origem'), el('th', {}, 'Último uso'), el('th', { class: 'right' }, ''))),
      tbody))));

  return wrap;
}

async function editarRegra(r) {
  const padrao = el('input', { class: 'input', value: r ? r.padrao : '', placeholder: 'Texto como aparece no extrato' });
  const tipo = selectSimples(TIPOS_MATCH.map(t => ({ valor: t, rotulo: ROTULO_MATCH[t] })), r ? r.tipo_match : 'classificacao_exata');
  const cat = selectCategorias(S.cats, r ? r.categoria_id : null);
  const conta = selectSimples(
    [{ valor: '', rotulo: 'Todas as contas' }, ...S.contas.map(c => ({ valor: c.id, rotulo: c.nome }))],
    r ? (r.conta_id || '') : '');
  const conf = el('input', { class: 'input num', type: 'number', min: 0, max: 1, step: 0.05, value: r ? r.confianca : 0.9 });

  const corpo = el('div', { class: 'form-grid' },
    campo('Padrão *', padrao, { span: 'sp-12', hint: 'Comparado sem acento, em minúsculas e sem pontuação.' }),
    campo('Tipo de casamento *', tipo, { span: 'sp-6' }),
    campo('Categoria de destino *', cat, { span: 'sp-6' }),
    campo('Vale para a conta', conta, { span: 'sp-6' }),
    campo('Confiança', conf, { span: 'sp-6', hint: '0 a 1. Alta ≥ 0,9 · Média ≥ 0,6' })
  );

  const acao = await modal.abrir({
    titulo: r ? 'Editar regra' : 'Nova regra', corpo, largo: true,
    acoes: [{ rotulo: 'Cancelar', classe: 'btn-ghost', valor: null }, { rotulo: 'Salvar', classe: 'btn-primary', valor: 'salvar' }]
  });
  if (acao !== 'salvar') return;

  if (!padrao.value.trim() || !cat.value) { toast.erro('Padrão e categoria são obrigatórios.'); return; }

  const dados = {
    id: r ? r.id : uuid(), empresa_id: db.EMPRESA_LOCAL,
    padrao: padrao.value.trim(),
    padrao_norm: tipo.value === 'documento_cnpj'
      ? padrao.value.replace(/\D/g, '')
      : normalizar(padrao.value),
    tipo_match: tipo.value,
    categoria_id: cat.value,
    conta_id: conta.value || null,
    acertos: r ? r.acertos : 0, erros: r ? r.erros : 0,
    confianca: Math.max(0, Math.min(1, Number(conf.value) || 0.9)),
    origem_regra: r ? r.origem_regra : 'MANUAL',
    criado_em: r ? r.criado_em : new Date().toISOString(),
    ultimo_uso: r ? r.ultimo_uso : null
  };
  await db.atualizar('regra', dados);
  await recarregar();
  toast.ok(r ? 'Regra atualizada.' : 'Regra criada.');
  pintar();
}

async function apagarRegra(r) {
  const ok = await modal.confirmar('Apagar regra', `Apagar a regra <b>${esc(r.padrao)}</b>?`, { rotuloOk: 'Apagar', perigo: true });
  if (!ok) return;
  await db.remover('regra', r.id);
  await recarregar();
  toast.ok('Regra apagada.');
  pintar();
}

/**
 * Reconstrói a memória varrendo os lançamentos já classificados. Serve para
 * bases que têm histórico mas não têm as regras — backup restaurado, troca de
 * navegador, ou lançamentos feitos antes de o app aprender todas as chaves.
 */
async function reconstruir() {
  const classificados = S.lancs.filter(l =>
    l.status !== 'A_CLASSIFICAR' && l.observacao !== 'RECEITA_MENSAL' && l.categoria_id);

  if (!classificados.length) {
    toast.aviso('Não há lançamentos classificados para aprender.');
    return;
  }

  const meses = [...new Set(classificados.map(l => l.competencia))].sort();
  const ok = await modal.confirmar('Reconstruir a memória',
    `Vou percorrer <b>${classificados.length}</b> lançamento(s) já classificados ` +
    `(${meses.length} competência(s), de ${meses[0]} a ${meses[meses.length - 1]}) e criar as regras ` +
    `de favorecido, CPF/CNPJ e descrição que estiverem faltando.` +
    `<br><br>Nenhum lançamento é alterado — só a memória.` +
    `<br><br><span style="color:var(--text-faint)">Rodar de novo não muda o destino das regras, apenas reforça a contagem de acertos.</span>`,
    { rotuloOk: 'Reconstruir' });
  if (!ok) return;

  const t = toast.info('Reconstruindo a memória…', 60000);
  try {
    const res = await reconstruirMemoria();
    t.remove();
    await recarregar();
    pintar();
    toast.ok(`${res.ensinados} lançamento(s) percorridos. ` +
      `Memória: ${res.regrasAntes} → ${res.regrasDepois} regras.`);
  } catch (e) {
    t.remove();
    toast.erro('Falha ao reconstruir: ' + e.message);
  }
}

async function baixarMemoria() {
  const dump = await exportarMemoria();
  baixarArquivo(`memoria-dre-sabor-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify(dump, null, 2), 'application/json');
  toast.ok(`${dump.regra.length} regra(s) exportada(s).`);
}

function subirMemoria() {
  const input = el('input', { type: 'file', accept: '.json', class: 'sr-only' });
  input.addEventListener('change', async () => {
    const f = input.files[0];
    if (!f) return;
    try {
      const json = JSON.parse(await f.text());
      const res = await importarMemoria(json);
      await recarregar();
      toast.ok(`${res.importadas} regra(s) importada(s)${res.ignoradas ? `, ${res.ignoradas} ignorada(s) por categoria inexistente` : ''}.`);
      pintar();
    } catch (e) {
      toast.erro('Arquivo inválido: ' + e.message);
    }
  });
  document.body.append(input);
  input.click();
  setTimeout(() => input.remove(), 1000);
}

/** A repintura troca a caixa por outra: devolve o foco à nova, cursor no fim. */
function refocar(id) {
  const nova = document.getElementById(id);
  if (!nova) return;
  nova.focus();
  const n = nova.value.length;
  try { nova.setSelectionRange(n, n); } catch { /* type=search em alguns navegadores */ }
}

export default { titulo, render };
