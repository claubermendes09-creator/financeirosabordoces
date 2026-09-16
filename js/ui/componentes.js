/* ============================================================
   ui/componentes.js — cards, badges, pílulas, ícones, selects
   ============================================================ */

import { el, moeda, pct, esc } from '../util.js';

/* ------------------------------------------------------------
   Ícones (SVG inline, stroke currentColor)
   ------------------------------------------------------------ */

const CAMINHOS = {
  dashboard: '<path d="M3 3h7v7H3zM14 3h7v4h-7zM14 10h7v11h-7zM3 13h7v8H3z"/>',
  lancar:    '<path d="M12 5v14M5 12h14"/>',
  importar:  '<path d="M12 3v12M8 11l4 4 4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/>',
  lista:     '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  dre:       '<path d="M4 4v16h16M8 16V9M12 16V5M16 16v-4"/>',
  regras:    '<path d="M4 6h16M4 12h10M4 18h7M17 15l2 2 4-4"/>',
  usuarios:  '<path d="M16 20v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 7a3 3 0 100 6 3 3 0 000-6M22 20v-2a4 4 0 00-3-3.87M16 4.13a4 4 0 010 7.75"/>',
  backup:    '<path d="M21 12a9 9 0 11-3-6.7M21 3v6h-6"/>',
  sair:      '<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/>',
  sol:       '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  lua:       '<path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/>',
  lupa:      '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  lixo:      '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>',
  editar:    '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
  baixar:    '<path d="M12 3v12M8 11l4 4 4-4M4 21h16"/>',
  check:     '<path d="M20 6L9 17l-5-5"/>',
  x:         '<path d="M18 6L6 18M6 6l12 12"/>',
  alerta:    '<path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/>',
  filtro:    '<path d="M22 3H2l8 9.5V19l4 2v-8.5z"/>',
  desfazer:  '<path d="M3 7v6h6M3.5 13a9 9 0 102.1-6.4L3 9"/>',
  cadeado:   '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>',
  arrastar:  '<circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>',
  cima:      '<path d="M18 15l-6-6-6 6"/>',
  baixo:     '<path d="M6 9l6 6 6-6"/>'
};

export function icone(nome, tamanho = 20) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', tamanho);
  svg.setAttribute('height', tamanho);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = CAMINHOS[nome] || CAMINHOS.lista;
  return svg;
}

/* ------------------------------------------------------------
   Badges de status
   ------------------------------------------------------------ */

export const STATUS_BADGE = {
  A_CLASSIFICAR: ['A CLASSIFICAR', 'b-aclassificar'],
  CLASSIFICADO:  ['Classificado',  'b-classificado'],
  EXCLUIDO:      ['Excluído',      'b-excluido'],
  CONFERIDO:     ['Conferido',     'b-conferido']
};

export const ORIGEM_BADGE = {
  IMPORTACAO:  ['Importado',  'b-importado'],
  MANUAL:      ['Manual',     'b-manual'],
  RECORRENCIA: ['Recorrente', 'b-recorrente']
};

export function badge(rotulo, classe) {
  return el('span', { class: 'badge ' + classe },
    el('span', { class: 'dot', 'aria-hidden': 'true' }), rotulo);
}

export function badgeStatus(status) {
  const [r, c] = STATUS_BADGE[status] || [status, 'b-excluido'];
  return badge(r, c);
}

export function badgeOrigem(origem, recorrente) {
  if (recorrente) return badge('Recorrente', 'b-recorrente');
  const [r, c] = ORIGEM_BADGE[origem] || [origem, 'b-manual'];
  return badge(r, c);
}

export function badgeDuplicado() {
  return badge('Duplicado', 'b-duplicado');
}

export function badgeConflito(titulo) {
  const b = badge('Conflito', 'b-conflito');
  if (titulo) b.title = titulo;
  return b;
}

/* ------------------------------------------------------------
   Card KPI
   ------------------------------------------------------------ */

/**
 * @param {object} o { rotulo, valor, formato, variacao, sentidoBom, contexto, destaque, sparkline }
 */
export function cardKPI(o) {
  const corpo = el('div', { class: 'kpi' });
  corpo.append(el('div', { class: 'kpi-label', text: o.rotulo }));
  corpo.append(el('div', { class: 'kpi-value num', text: o.formato ? o.formato(o.valor) : moeda(o.valor) }));

  const rodape = el('div', { class: 'kpi-foot' });
  if (o.variacao != null && isFinite(o.variacao)) {
    // cor pela direção, não pelo "sentido bom": subiu é verde, caiu é vermelho
    // (foi pedido assim — uma despesa que cai aparece em vermelho mesmo sendo boa)
    const sobe = o.variacao >= 0;
    rodape.append(el('span', {
      class: 'delta ' + (Math.abs(o.variacao) < 0.05 ? 'flat' : (sobe ? 'up' : 'down')),
      title: 'Comparado ao mês anterior'
    }, (sobe ? '▲ ' : '▼ ') + pct(Math.abs(o.variacao))));
  }
  if (o.contexto) rodape.append(el('span', { text: o.contexto }));
  if (rodape.childNodes.length) corpo.append(rodape);
  if (o.sparkline) corpo.append(o.sparkline);

  return el('div', { class: 'card' + (o.destaque ? ' destaque' : '') + (o.span ? ' ' + o.span : '') }, corpo);
}

/* ------------------------------------------------------------
   Card genérico
   ------------------------------------------------------------ */

export function card({ titulo, sub, acoes, span = '', classe = '' }, ...conteudo) {
  const c = el('div', { class: `card ${span} ${classe}`.trim() });
  if (titulo || acoes) {
    const cab = el('div', { class: 'card-head' });
    const esq = el('div', {});
    if (titulo) esq.append(el('div', { class: 'card-title', text: titulo }));
    if (sub) esq.append(el('div', { class: 'card-sub', text: sub }));
    cab.append(esq);
    if (acoes) cab.append(acoes);
    c.append(cab);
  }
  c.append(...conteudo.flat().filter(Boolean));
  return c;
}

/* ------------------------------------------------------------
   Pílulas de filtro
   ------------------------------------------------------------ */

/**
 * @param {Array} opcoes [{ valor, rotulo }]
 */
export function pilulas(opcoes, ativo, aoTrocar) {
  const wrap = el('div', { class: 'pills', role: 'group' });
  for (const o of opcoes) {
    wrap.append(el('button', {
      class: 'pill', type: 'button',
      'aria-pressed': String(o.valor === ativo),
      onclick: () => aoTrocar(o.valor)
    }, o.rotulo));
  }
  return wrap;
}

/* ------------------------------------------------------------
   Select de categorias agrupado pelos blocos da DRE
   ------------------------------------------------------------ */

export function selectCategorias(categorias, selecionada, atributos = {}) {
  const s = el('select', { class: 'select', ...atributos });
  if (atributos.placeholder !== false) {
    s.append(el('option', { value: '' }, atributos.placeholder || 'Selecione a categoria…'));
  }
  const grupos = [];
  for (const c of [...categorias].sort((a, b) => a.ordem - b.ordem)) {
    if (c.ativa === false) continue;
    let g = grupos.find(x => x.nome === c.grupo);
    if (!g) { g = { nome: c.grupo, itens: [] }; grupos.push(g); }
    g.itens.push(c);
  }
  for (const g of grupos) {
    const og = el('optgroup', { label: g.nome });
    for (const c of g.itens) {
      og.append(el('option', { value: c.id, selected: c.id === selecionada }, c.nome));
    }
    s.append(og);
  }
  return s;
}

export function selectSimples(opcoes, selecionado, atributos = {}) {
  const s = el('select', { class: 'select', ...atributos });
  for (const o of opcoes) {
    s.append(el('option', { value: o.valor, selected: String(o.valor) === String(selecionado) }, o.rotulo));
  }
  return s;
}

/* ------------------------------------------------------------
   Campo de formulário
   ------------------------------------------------------------ */

export function campo(rotulo, controle, { span = 'sp-4', hint = null, id = null } = {}) {
  if (id) controle.id = id;
  const f = el('div', { class: `field ${span}` });
  const lab = el('label', { text: rotulo });
  if (controle.id) lab.setAttribute('for', controle.id);
  f.append(lab, controle);
  if (hint) f.append(el('div', { class: 'hint', text: hint }));
  f.append(el('div', { class: 'erro', 'data-erro': '' }));
  return f;
}

export function marcarErro(campoEl, mensagem) {
  const ctrl = campoEl.querySelector('.input, .select, .textarea');
  const alvo = campoEl.querySelector('[data-erro]');
  if (alvo) alvo.textContent = mensagem || '';
  if (ctrl) {
    if (mensagem) ctrl.setAttribute('aria-invalid', 'true');
    else ctrl.removeAttribute('aria-invalid');
  }
}

/* ------------------------------------------------------------
   Estado vazio
   ------------------------------------------------------------ */

export function vazio(texto, sub = '') {
  return el('div', { class: 'vazio' },
    el('div', { class: 'big', 'aria-hidden': 'true', text: '◔' }),
    el('div', { text: texto }),
    sub ? el('div', { class: 'faint', style: 'margin-top:6px', text: sub }) : null
  );
}

export function alerta(texto, tipo = '', acao = null) {
  return el('div', { class: 'alerta ' + tipo },
    icone('alerta', 18),
    el('span', { html: esc(texto) }),
    acao
  );
}

export default {
  icone, badge, badgeStatus, badgeOrigem, badgeDuplicado, badgeConflito,
  cardKPI, card, pilulas, selectCategorias, selectSimples,
  campo, marcarErro, vazio, alerta
};
