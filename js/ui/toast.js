/* ============================================================
   ui/toast.js — avisos no canto inferior direito (pílula, 3s)
   ============================================================ */

import { el } from '../util.js';

const ICONES = { ok: '✓', err: '!', warn: '!', info: 'i' };

function caixa() {
  let c = document.querySelector('.toasts');
  if (!c) {
    c = el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(c);
  }
  return c;
}

export function toast(mensagem, tipo = 'ok', ms = 3000) {
  const t = el('div', { class: `toast ${tipo}` },
    el('span', { class: 'ic', 'aria-hidden': 'true', text: ICONES[tipo] || 'i' }),
    el('span', { text: mensagem })
  );
  caixa().append(t);
  setTimeout(() => {
    t.classList.add('out');
    t.addEventListener('animationend', () => t.remove(), { once: true });
  }, ms);
  return t;
}

export const ok   = (m, ms) => toast(m, 'ok', ms);
export const erro = (m, ms) => toast(m, 'err', ms ?? 5000);
export const aviso = (m, ms) => toast(m, 'warn', ms ?? 4500);
export const info = (m, ms) => toast(m, 'info', ms);

export default { toast, ok, erro, aviso, info };
