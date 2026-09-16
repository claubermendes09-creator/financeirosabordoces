/* ============================================================
   ui/modal.js — diálogos (confirmação, formulário, dupla confirmação)
   Navegação por teclado completa: Tab preso no diálogo, Esc fecha.
   ============================================================ */

import { el, $$ } from '../util.js';

const FOCAVEIS = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * @param {object} opcoes
 *   titulo, corpo (string HTML | Node), acoes: [{ rotulo, classe, valor, autofoco }]
 *   largo: bool
 * @returns {Promise<any>} valor da ação escolhida (null quando cancelado)
 */
export function abrir({ titulo, corpo, acoes = [], largo = false, aoMontar = null }) {
  return new Promise(resolve => {
    const anterior = document.activeElement;

    const painel = el('div', {
      class: 'modal' + (largo ? ' wide' : ''),
      role: 'dialog', 'aria-modal': 'true', 'aria-label': titulo || 'Diálogo'
    });
    if (titulo) painel.append(el('h3', { text: titulo }));

    const corpoEl = el('div', { class: 'modal-body' });
    if (corpo == null) corpoEl.remove();
    else if (typeof corpo === 'string') corpoEl.innerHTML = corpo;
    else corpoEl.append(corpo);
    if (corpo != null) painel.append(corpoEl);

    const rodape = el('div', { class: 'modal-foot' });
    for (const a of acoes) {
      rodape.append(el('button', {
        class: 'btn ' + (a.classe || 'btn-ghost'),
        type: 'button',
        onclick: () => {
          if (a.antes && a.antes(painel) === false) return;
          fechar(a.valor);
        }
      }, a.rotulo));
    }
    painel.append(rodape);

    const fundo = el('div', { class: 'modal-bg' }, painel);
    fundo.addEventListener('mousedown', ev => { if (ev.target === fundo) fechar(null); });

    function onTecla(ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); fechar(null); return; }
      if (ev.key !== 'Tab') return;
      const alvos = $$(FOCAVEIS, painel).filter(n => n.offsetParent !== null);
      if (!alvos.length) return;
      const primeiro = alvos[0], ultimo = alvos[alvos.length - 1];
      if (ev.shiftKey && document.activeElement === primeiro) { ev.preventDefault(); ultimo.focus(); }
      else if (!ev.shiftKey && document.activeElement === ultimo) { ev.preventDefault(); primeiro.focus(); }
    }

    function fechar(valor) {
      document.removeEventListener('keydown', onTecla, true);
      fundo.remove();
      if (anterior && anterior.focus) anterior.focus();
      resolve(valor);
    }

    document.addEventListener('keydown', onTecla, true);
    document.body.append(fundo);

    if (aoMontar) aoMontar(painel, fechar);

    const auto = painel.querySelector('[data-autofoco]') || painel.querySelector(FOCAVEIS);
    if (auto) auto.focus();
  });
}

export function confirmar(titulo, texto, { rotuloOk = 'Confirmar', perigo = false } = {}) {
  return abrir({
    titulo, corpo: texto,
    acoes: [
      { rotulo: 'Cancelar', classe: 'btn-ghost', valor: false },
      { rotulo: rotuloOk, classe: perigo ? 'btn-danger' : 'btn-primary', valor: true }
    ]
  }).then(v => v === true);
}

/**
 * Dupla confirmação: exige digitar uma palavra exata.
 */
export function confirmarDigitando(titulo, texto, palavra) {
  const campo = el('input', { class: 'input', type: 'text', placeholder: palavra, 'data-autofoco': '' });
  const corpo = el('div', {},
    el('p', { html: texto }),
    el('p', { class: 'muted', style: 'margin-top:12px', html: `Digite <b>${palavra}</b> para confirmar:` }),
    campo
  );
  return abrir({
    titulo, corpo,
    acoes: [
      { rotulo: 'Cancelar', classe: 'btn-ghost', valor: false },
      {
        rotulo: 'Confirmar', classe: 'btn-danger', valor: true,
        antes: () => {
          if (campo.value.trim() !== palavra) {
            campo.setAttribute('aria-invalid', 'true');
            campo.focus();
            return false;
          }
        }
      }
    ]
  }).then(v => v === true);
}

export default { abrir, confirmar, confirmarDigitando };
