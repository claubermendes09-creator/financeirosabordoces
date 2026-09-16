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
  if (opcoes.ordenavel !== false) ordenavel(t);

  return el('div', { class: opcoes.rolagem === false ? 'tbl-wrap' : 'tbl-scroll' }, t);
}

/* ------------------------------------------------------------
   Ordenar clicando no cabeçalho — vale para qualquer table.tbl
   ------------------------------------------------------------ */

/** Valor comparável de uma célula: número (moeda), data dd/mm/aaaa ou texto. */
export function chaveDeOrdenacao(td) {
  if (td.dataset.ordem != null) {
    const n = Number(td.dataset.ordem);
    return isNaN(n) ? td.dataset.ordem : n;
  }
  const txt = (td.textContent || '').trim();
  const moeda = txt.match(/^([−-]?)\s*R\$\s*([\d.]+,\d{2})$/);
  if (moeda) return (moeda[1] ? -1 : 1) * parseFloat(moeda[2].replace(/\./g, '').replace(',', '.'));
  const data = txt.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (data) return `${data[3]}-${data[2]}-${data[1]}`;
  const pct = txt.match(/^([+−-]?\d+(?:[.,]\d+)?)\s*%$/);
  if (pct) return parseFloat(pct[1].replace('−', '-').replace(',', '.'));
  const num = txt.match(/^-?\d+(?:[.,]\d+)?$/);
  if (num) return parseFloat(txt.replace(/\./g, '').replace(',', '.'));
  // select dentro da célula (categoria): ordena pelo texto escolhido
  const sel = td.querySelector('select');
  if (sel && sel.selectedOptions[0]) return sel.selectedOptions[0].textContent.trim().toLowerCase();
  return txt.toLowerCase();
}

function comparar(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'pt-BR', { numeric: true });
}

/**
 * Deixa os cabeçalhos clicáveis. Cabeçalhos vazios ou com controle dentro
 * (checkbox, filtro) ficam de fora.
 *
 * @param {HTMLTableElement} table
 * @param {object} opcoes
 *   aoOrdenar(indice, direcao)  quem redesenha a partir do estado usa isto e
 *                                ordena os dados; sem callback, as linhas do
 *                                tbody são reordenadas no lugar
 *   atual: { indice, direcao }   para marcar o cabeçalho depois de repintar
 */
export function ordenavel(table, opcoes = {}) {
  const ths = [...table.querySelectorAll('thead tr:first-child th')];
  ths.forEach((th, i) => {
    if (!th.textContent.trim() || th.querySelector('input, select, button')) return;
    th.classList.add('th-ord');
    th.title = 'Clique para ordenar';
    const marcado = opcoes.atual && opcoes.atual.indice === i;
    if (marcado) th.classList.add(opcoes.atual.direcao === 'desc' ? 'ord-desc' : 'ord-asc');
    th.addEventListener('click', () => {
      const direcao = th.classList.contains('ord-asc') ? 'desc' : 'asc';
      if (opcoes.aoOrdenar) { opcoes.aoOrdenar(i, direcao); return; }
      ths.forEach(x => x.classList.remove('ord-asc', 'ord-desc'));
      th.classList.add('ord-' + direcao);
      const tbody = table.tBodies[0];
      const linhas = [...tbody.rows].filter(r => r.cells.length > 1);
      linhas.sort((ra, rb) => {
        const r = comparar(chaveDeOrdenacao(ra.cells[i]), chaveDeOrdenacao(rb.cells[i]));
        return direcao === 'asc' ? r : -r;
      });
      for (const r of linhas) tbody.append(r);
    });
  });
  return table;
}

export default { tabela, ordenavel, chaveDeOrdenacao };
