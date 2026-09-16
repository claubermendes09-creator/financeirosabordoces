/* ============================================================
   ui/tabela.js — tabela com cabeçalho fixo e rolagem própria
   ============================================================ */

import { el } from '../util.js';

/**
 * @param {Array} colunas [{ chave, rotulo, classe, render(linha, i) }]
 * @param {Array} linhas
 * @param {object} opcoes { chaveLinha, classeLinha, aoClicar, vazio, rolagem }
 */
export function tabela(colunas, linhas, opcoes = {}) {
  const t = el('table', { class: 'tbl' });

  const thead = el('thead');
  const trh = el('tr');
  for (const c of colunas) {
    trh.append(el('th', { class: c.classe || '', scope: 'col' }, c.rotulo));
  }
  thead.append(trh);
  t.append(thead);

  const tbody = el('tbody');
  if (!linhas.length) {
    tbody.append(el('tr', {},
      el('td', { colspan: colunas.length, class: 'center' },
        el('div', { class: 'vazio', text: opcoes.vazio || 'Nada por aqui ainda.' }))));
  } else {
    linhas.forEach((linha, i) => {
      const tr = el('tr', { class: opcoes.classeLinha ? opcoes.classeLinha(linha, i) : '' });
      if (opcoes.chaveLinha) tr.dataset.id = opcoes.chaveLinha(linha);
      for (const c of colunas) {
        const td = el('td', { class: c.classe || '' });
        const v = c.render ? c.render(linha, i) : linha[c.chave];
        if (v == null) td.textContent = '';
        else if (v.nodeType) td.append(v);
        else td.textContent = String(v);
        tr.append(td);
      }
      if (opcoes.aoClicar) {
        tr.style.cursor = 'pointer';
        tr.addEventListener('click', ev => {
          if (ev.target.closest('button, select, input, a')) return;
          opcoes.aoClicar(linha, i, tr);
        });
      }
      tbody.append(tr);
    });
  }
  t.append(tbody);

  return el('div', { class: opcoes.rolagem === false ? 'tbl-wrap' : 'tbl-scroll' }, t);
}

export default { tabela };
