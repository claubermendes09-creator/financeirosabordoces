/* ============================================================
   ui/grafico.js — barras, donut e sparkline, sem biblioteca
   ============================================================ */

import { el, moeda } from '../util.js';

export const CORES_SERIE = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6'];

export function corSerie(i) {
  return `var(${CORES_SERIE[i % CORES_SERIE.length]})`;
}

/* ------------------------------------------------------------
   Barras — a barra em foco fica sólida, as demais hachuradas
   ------------------------------------------------------------ */

/**
 * @param {Array} dados [{ rotulo, valor }]
 * @param {object} opcoes { foco: índice, cor: 'var(--accent)', aoFocar: fn, formato: fn }
 */
export function barras(dados, opcoes = {}) {
  const fmt = opcoes.formato || moeda;
  const cor = opcoes.cor || 'var(--accent)';
  let foco = opcoes.foco == null ? dados.length - 1 : opcoes.foco;
  const max = Math.max(1, ...dados.map(d => Math.abs(d.valor)));

  const wrap = el('div', { class: 'chart-bars', role: 'img', 'aria-label': opcoes.rotulo || 'Gráfico de barras' });

  function pintar() {
    wrap.textContent = '';
    dados.forEach((d, i) => {
      const alt = Math.max(4, (Math.abs(d.valor) / max) * 100);
      const barra = el('div', {
        class: 'bar' + (i === foco ? ' foco' : ''),
        style: `height:${alt}%; --barc:${cor}`,
        title: `${d.rotulo}: ${fmt(d.valor)}`
      });
      if (i === foco) barra.append(el('div', { class: 'bar-tip', text: fmt(d.valor) }));

      const col = el('div', { class: 'bar-col' + (i === foco ? ' on' : '') },
        el('div', { class: 'bar-track' }, barra),
        el('div', { class: 'lbl', text: d.rotulo })
      );
      col.addEventListener('mouseenter', () => { foco = i; pintar(); });
      col.addEventListener('click', () => { if (opcoes.aoFocar) opcoes.aoFocar(i, d); });
      wrap.append(col);
    });
  }

  pintar();
  return wrap;
}

/* ------------------------------------------------------------
   Donut — espessura generosa, pontas arredondadas, total no centro
   ------------------------------------------------------------ */

/**
 * @param {Array} fatias [{ rotulo, valor }]
 */
export function donut(fatias, opcoes = {}) {
  const total = fatias.reduce((a, b) => a + Math.abs(b.valor), 0);
  const R = 62, ESP = 20, C = 2 * Math.PI * R;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 160 160');
  svg.setAttribute('aria-hidden', 'true');

  const trilho = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  trilho.setAttribute('cx', 80); trilho.setAttribute('cy', 80); trilho.setAttribute('r', R);
  trilho.setAttribute('fill', 'none');
  trilho.setAttribute('stroke', 'var(--track)');
  trilho.setAttribute('stroke-width', ESP);
  svg.append(trilho);

  let acumulado = 0;
  fatias.forEach((f, i) => {
    const frac = total ? Math.abs(f.valor) / total : 0;
    if (frac <= 0) return;
    const arco = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    arco.setAttribute('cx', 80); arco.setAttribute('cy', 80); arco.setAttribute('r', R);
    arco.setAttribute('fill', 'none');
    arco.setAttribute('stroke', corSerie(i));
    arco.setAttribute('stroke-width', ESP);
    arco.setAttribute('stroke-linecap', 'round');
    // pequena folga entre fatias para as pontas arredondadas respirarem
    const comp = Math.max(C * frac - 3, 1);
    arco.setAttribute('stroke-dasharray', `${comp} ${C - comp}`);
    arco.setAttribute('stroke-dashoffset', -(C * acumulado));
    svg.append(arco);
    acumulado += frac;
  });

  const rosca = el('div', { class: 'donut' }, svg,
    el('div', { class: 'mid' },
      el('div', { class: 'v', text: opcoes.formato ? opcoes.formato(total) : moeda(total) }),
      el('div', { class: 'l', text: opcoes.rotuloCentro || 'total' })
    )
  );

  const legenda = el('div', { class: 'legend' });
  fatias.forEach((f, i) => {
    legenda.append(el('div', { class: 'legend-row' },
      el('span', { class: 'bul', style: `background:${corSerie(i)}` }),
      el('span', { class: 'nm', text: f.rotulo, title: f.rotulo }),
      el('span', { class: 'vl', text: moeda(f.valor) })
    ));
  });

  return el('div', { class: 'donut-wrap' }, rosca, legenda);
}

/* ------------------------------------------------------------
   Sparkline — linha de 2px, sem eixos
   ------------------------------------------------------------ */

export function sparkline(valores, cor = 'var(--accent)') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('viewBox', '0 0 100 32');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');

  if (valores.length > 1) {
    const min = Math.min(...valores), max = Math.max(...valores);
    const amp = (max - min) || 1;
    const pontos = valores.map((v, i) => {
      const x = (i / (valores.length - 1)) * 100;
      const y = 30 - ((v - min) / amp) * 28;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(' ');
    const linha = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    linha.setAttribute('points', pontos);
    linha.setAttribute('fill', 'none');
    linha.setAttribute('stroke', cor);
    linha.setAttribute('stroke-width', '2');
    linha.setAttribute('stroke-linecap', 'round');
    linha.setAttribute('stroke-linejoin', 'round');
    linha.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(linha);
  }
  return svg;
}

/* ------------------------------------------------------------
   Barras agrupadas — várias séries por mês (receita × despesas × resultado)
   ------------------------------------------------------------ */

/**
 * @param {string[]} rotulos   um por coluna (mês)
 * @param {Array} series       [{ nome, cor, valores: number[] }]
 * @param {object} opcoes      { foco: índice da coluna, formato }
 */
export function barrasAgrupadas(rotulos, series, opcoes = {}) {
  const fmt = opcoes.formato || moeda;
  let foco = opcoes.foco == null ? rotulos.length - 1 : opcoes.foco;
  const max = Math.max(1, ...series.flatMap(s => s.valores.map(v => Math.abs(v || 0))));

  const wrap = el('div', { class: 'chart-grouped', role: 'img', 'aria-label': opcoes.rotulo || 'Gráfico de barras agrupadas' });
  const legenda = el('div', { class: 'chart-legend' },
    ...series.map(s => el('span', { class: 'chart-legend-item' },
      el('span', { class: 'bul', style: `background:${s.cor}` }), s.nome)));
  const area = el('div', { class: 'chart-bars grouped' });

  function pintar() {
    area.textContent = '';
    rotulos.forEach((rot, i) => {
      const grupo = el('div', { class: 'bar-group' });
      for (const s of series) {
        const v = s.valores[i] || 0;
        const alt = Math.max(3, (Math.abs(v) / max) * 100);
        grupo.append(el('div', {
          class: 'bar' + (i === foco ? ' foco' : '') + (v < 0 ? ' negativa' : ''),
          style: `height:${alt}%; --barc:${s.cor}`,
          title: `${rot} · ${s.nome}: ${fmt(v)}`
        }));
      }
      const col = el('div', { class: 'bar-col' + (i === foco ? ' on' : '') },
        el('div', { class: 'bar-track wide' }, grupo),
        el('div', { class: 'lbl', text: rot }));
      col.addEventListener('mouseenter', () => { foco = i; pintar(); });
      col.addEventListener('click', () => { if (opcoes.aoFocar) opcoes.aoFocar(i); });
      area.append(col);
    });
    // leitura da coluna em foco, em vez de tooltip por barra
    leitura.textContent = '';
    leitura.append(el('b', { text: rotulos[foco] }));
    for (const s of series) {
      const v = s.valores[foco] || 0;
      leitura.append(el('span', { class: 'chart-read-item' },
        el('span', { class: 'bul', style: `background:${s.cor}` }),
        el('span', { class: 'faint', text: s.nome + ' ' }),
        el('span', { class: 'num' + (v < 0 ? ' neg' : ''), text: fmt(v) })));
    }
  }
  const leitura = el('div', { class: 'chart-read' });
  pintar();
  wrap.append(legenda, area, leitura);
  return wrap;
}

/* ------------------------------------------------------------
   Barras horizontais — ranking (onde vai o dinheiro)
   ------------------------------------------------------------ */

/**
 * @param {Array} dados  [{ rotulo, valor, extra?: string, cor?: string }]
 * @param {object} opcoes { formato, aoClicar }
 */
export function barrasHorizontais(dados, opcoes = {}) {
  const fmt = opcoes.formato || moeda;
  const max = Math.max(1, ...dados.map(d => Math.abs(d.valor)));
  const wrap = el('div', { class: 'hbars', role: 'list' });
  dados.forEach((d, i) => {
    const largura = Math.max(1.5, (Math.abs(d.valor) / max) * 100);
    const linha = el('div', { class: 'hbar-row', role: 'listitem', title: `${d.rotulo}: ${fmt(d.valor)}` },
      el('div', { class: 'hbar-head' },
        el('span', { class: 'hbar-pos', text: String(i + 1) }),
        el('span', { class: 'hbar-nm', text: d.rotulo }),
        d.extra ? el('span', { class: 'hbar-extra', text: d.extra }) : null,
        el('span', { class: 'hbar-vl num', text: fmt(d.valor) })),
      el('div', { class: 'hbar-track' },
        el('div', { class: 'hbar-fill', style: `width:${largura}%; background:${d.cor || corSerie(i)}` })));
    if (opcoes.aoClicar) { linha.style.cursor = 'pointer'; linha.addEventListener('click', () => opcoes.aoClicar(d, i)); }
    wrap.append(linha);
  });
  return wrap;
}

export default { barras, barrasAgrupadas, barrasHorizontais, donut, sparkline, corSerie, CORES_SERIE };
