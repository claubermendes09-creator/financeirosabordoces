/* ============================================================
   ui/dividir.js — rateio de um lançamento em várias categorias

   Um pagamento só cobre coisas diferentes: dos R$ 15.000 da fatura do
   cartão, R$ 13.000 foram pro-labore e R$ 2.000 despesa da empresa.
   O extrato traz uma linha; a DRE precisa de duas.

   O modal exige que a soma feche com o valor original — sem isso o
   rateio silenciosamente mudaria o resultado do mês.
   ============================================================ */

import { el, moeda, parseValorBR, round2 } from '../util.js';
import { selectCategorias, campo } from './componentes.js';
import modal from './modal.js';

/**
 * @param {object} o { valor, descricao, categoria_id, categorias }
 * @returns {Promise<null | Array<{categoria_id, valor, rotulo}>>}
 *          null se o operador cancelar
 */
export async function pedirRateio({ valor, descricao, categoria_id, categorias }) {
  const total = round2(valor);
  const linhas = [];
  const corpo = el('div', {});

  const resumo = el('div', {
    style: 'display:flex; justify-content:space-between; align-items:baseline; gap:12px; ' +
      'padding:12px 14px; border-radius:var(--r-sm); background:var(--bg-input); margin-bottom:16px'
  });
  const lista = el('div', {});
  const erro = el('div', { class: 'erro', style: 'min-height:18px' });

  function somar() {
    return round2(linhas.reduce((a, l) => a + parseValorBR(l.campoValor.value).valor, 0));
  }

  function atualizar() {
    const soma = somar();
    const resta = round2(total - soma);
    resumo.textContent = '';
    resumo.append(
      el('div', {},
        el('div', { class: 'faint', style: 'font-size:11.5px', text: 'Valor do lançamento' }),
        el('div', { class: 'num', style: 'font-size:18px; font-weight:700', text: moeda(total) })),
      el('div', { style: 'text-align:right' },
        el('div', { class: 'faint', style: 'font-size:11.5px', text: resta === 0 ? 'fecha' : 'falta distribuir' }),
        el('div', {
          class: 'num ' + (resta === 0 ? 'pos' : 'neg'),
          style: 'font-size:18px; font-weight:700',
          text: moeda(resta)
        }))
    );
    erro.textContent = '';
  }

  function novaLinha(catInicial, valorInicial) {
    const sel = selectCategorias(categorias, catInicial, { class: 'select select-sm', placeholder: false });
    const campoValor = el('input', {
      class: 'input num', type: 'text', inputmode: 'decimal', placeholder: '0,00',
      value: valorInicial != null ? String(valorInicial).replace('.', ',') : '',
      style: 'text-align:right'
    });
    campoValor.addEventListener('input', atualizar);

    const item = { sel, campoValor };
    const btnResto = el('button', {
      class: 'btn btn-sm btn-ghost', type: 'button', title: 'Jogar aqui o que falta',
      onclick: () => {
        const outros = round2(linhas.filter(l => l !== item)
          .reduce((a, l) => a + parseValorBR(l.campoValor.value).valor, 0));
        campoValor.value = String(round2(total - outros)).replace('.', ',');
        atualizar();
      }
    }, 'resto');

    const btnRemover = el('button', {
      class: 'btn btn-sm btn-icon btn-ghost', type: 'button', title: 'Remover esta parte',
      onclick: () => {
        if (linhas.length <= 2) return;
        linhas.splice(linhas.indexOf(item), 1);
        linha.remove();
        atualizar();
      }
    }, '×');

    const linha = el('div', {
      style: 'display:grid; grid-template-columns: 1fr 130px auto auto; gap:8px; align-items:center; margin-bottom:8px'
    }, sel, campoValor, btnResto, btnRemover);

    linhas.push(item);
    lista.append(linha);
    return item;
  }

  corpo.append(
    el('div', { class: 'muted', style: 'font-size:13px; margin-bottom:12px' },
      'Distribua o valor entre as categorias. A soma precisa fechar com o total.'),
    el('div', { class: 'faint', style: 'font-size:12px; margin-bottom:14px' }, descricao),
    resumo, lista, erro
  );

  novaLinha(categoria_id, null);
  novaLinha(null, null);
  atualizar();

  corpo.append(el('button', {
    class: 'btn btn-sm btn-ghost', type: 'button', style: 'margin-top:4px',
    onclick: () => { novaLinha(null, null); atualizar(); }
  }, '+ outra parte'));

  const r = await modal.abrir({
    titulo: 'Dividir o lançamento', corpo, largo: true,
    acoes: [
      { rotulo: 'Cancelar', classe: 'btn-ghost', valor: null },
      {
        rotulo: 'Dividir', classe: 'btn-primary', valor: 'ok',
        antes: () => {
          const partes = linhas
            .map(l => ({ categoria_id: l.sel.value, valor: parseValorBR(l.campoValor.value).valor }))
            .filter(p => p.valor > 0);

          if (partes.length < 2) { erro.textContent = 'Informe pelo menos duas partes com valor.'; return false; }
          if (partes.some(p => !p.categoria_id)) { erro.textContent = 'Escolha a categoria de cada parte.'; return false; }

          const soma = round2(partes.reduce((a, p) => a + p.valor, 0));
          if (soma !== total) {
            erro.textContent = `A soma dá ${moeda(soma)} e o lançamento é ${moeda(total)}. ` +
              `Faltam ${moeda(round2(total - soma))}.`;
            return false;
          }
          corpo._partes = partes;
        }
      }
    ]
  });

  if (r !== 'ok') return null;

  const nomePorId = new Map(categorias.map(c => [c.id, c.nome]));
  return corpo._partes.map((p, i) => ({
    ...p,
    rotulo: `${i + 1}/${corpo._partes.length} ${nomePorId.get(p.categoria_id) || ''}`.trim()
  }));
}

void campo;

export default { pedirRateio };
