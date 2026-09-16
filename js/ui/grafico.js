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
    const fracao = total ? Math.abs(f.valor) / total * 100 : 0;
    legenda.append(el('div', { class: 'legend-row' },
      el('span', { class: 'bul', style: `background:${corSerie(i)}` }),
      el('span', { class: 'nm', text: f.rotulo, title: f.rotulo }),
      opcoes.percentual === false ? null : el('span', { class: 'pc', text: fracao.toFixed(1).replace('.', ',') + '%' }),
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

/* ------------------------------------------------------------
   Linhas — evolução mensal de um ou mais indicadores, com eixo e valores
   ------------------------------------------------------------ */

/**
 * @param {string[]} rotulos  um por ponto (mês)
 * @param {Array} series      [{ nome, cor, valores: number[] }]
 * @param {object} opcoes     { formato, altura, zeroNaBase }
 */
export function linhas(rotulos, series, opcoes = {}) {
  const fmt = opcoes.formato || moeda;
  const W = 640, H = opcoes.altura || 220, PAD = { t: 26, r: 18, b: 30, l: 14 };
  const todos = series.flatMap(s => s.valores.map(v => Number(v) || 0));
  let min = Math.min(0, ...todos), max = Math.max(0, ...todos);
  if (opcoes.zeroNaBase === false) { min = Math.min(...todos); max = Math.max(...todos); }
  if (max === min) { max = min + 1; }
  const folga = (max - min) * 0.08; max += folga; if (min < 0) min -= folga;
  const n = rotulos.length;
  const x = i => n > 1 ? PAD.l + (i / (n - 1)) * (W - PAD.l - PAD.r) : W / 2;
  const y = v => PAD.t + (1 - (v - min) / (max - min)) * (H - PAD.t - PAD.b);
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'chart-lines'); svg.setAttribute('role', 'img');
  const mk = (tag, attrs, txt) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (txt != null) e.textContent = txt; return e; };

  // linhas-guia: zero e mais três níveis
  for (let k = 0; k <= 3; k++) {
    const v = min + (max - min) * k / 3;
    svg.append(mk('line', { x1: PAD.l, x2: W - PAD.r, y1: y(v), y2: y(v), class: 'guia' }));
  }
  if (min < 0 && max > 0) svg.append(mk('line', { x1: PAD.l, x2: W - PAD.r, y1: y(0), y2: y(0), class: 'zero' }));

  series.forEach((s, si) => {
    const pts = s.valores.map((v, i) => [x(i), y(Number(v) || 0)]);
    if (pts.length > 1) {
      svg.append(mk('polyline', { points: pts.map(p => p.join(',')).join(' '), fill: 'none', stroke: s.cor, 'stroke-width': 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    }
    pts.forEach(([px, py], i) => {
      const g = mk('g', { class: 'ponto' });
      g.append(mk('circle', { cx: px, cy: py, r: 4.5, fill: s.cor, stroke: 'var(--bg-card)', 'stroke-width': 2 }));
      // valor escrito só quando há uma série (senão vira poluição) — as
      // demais ficam no title (tooltip)
      if (series.length === 1 && n <= 13) {
        g.append(mk('text', { x: px, y: py - 10, 'text-anchor': i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle'), class: 'valor' }, fmt(s.valores[i] || 0)));
      }
      g.append(mk('title', {}, `${rotulos[i]} · ${s.nome}: ${fmt(s.valores[i] || 0)}`));
      svg.append(g);
    });
    void si;
  });
  rotulos.forEach((r, i) => svg.append(mk('text', { x: x(i), y: H - 8, 'text-anchor': i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle'), class: 'eixo' }, r)));

  const wrap = el('div', { class: 'chart-lines-wrap' });
  if (series.length > 1) {
    wrap.append(el('div', { class: 'chart-legend' }, ...series.map(s => el('span', { class: 'chart-legend-item' }, el('span', { class: 'bul', style: `background:${s.cor}` }), s.nome))));
  }
  wrap.append(svg);
  return wrap;
}

export default { barras, barrasAgrupadas, barrasHorizontais, donut, sparkline, linhas, corSerie, CORES_SERIE };
