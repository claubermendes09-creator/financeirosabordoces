/* ============================================================
   empresa.js — dados da empresa (nome, CNPJ, foto)

   A foto fica como data URL na própria linha da empresa: pequena
   (redimensionada para 256px antes de gravar), viaja no backup e,
   na nuvem, é a mesma para todo mundo da empresa.
   ============================================================ */

import db from './db.js';
import nuvem from './nuvem.js';
import { el } from './util.js';

export const LADO_LOGO = 256;

export function idEmpresa() {
  return nuvem.empresaId() || db.EMPRESA_LOCAL;
}

export async function obter() {
  return (await db.obter('empresa', idEmpresa())) || null;
}

/** Iniciais para quando não há foto: "Sabor Doces & Salgados" → "SD". */
export function iniciais(nome) {
  const partes = String(nome || '').split(/\s+/).filter(p => /^[\p{L}\d]/u.test(p));
  const s = partes.slice(0, 2).map(p => p[0]).join('').toUpperCase();
  return s || 'SD';
}

/**
 * Bloco de logo para o rail e para a tela de login. Recebe a classe CSS
 * e a empresa (ou null antes do login — aí usa as iniciais padrão).
 */
export function elementoLogo(classe, empresa) {
  if (empresa && empresa.logo) {
    return el('div', { class: classe + ' com-foto', 'aria-hidden': 'true' },
      el('img', { src: empresa.logo, alt: '' }));
  }
  return el('div', { class: classe, 'aria-hidden': 'true', text: iniciais(empresa && empresa.nome) });
}

/**
 * Lê a imagem escolhida, encaixa num quadrado de LADO_LOGO e devolve o
 * data URL. PNG mantém transparência; fotos vão em JPEG para não pesar.
 */
export function prepararImagem(file) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) { reject(new Error('Escolha um arquivo de imagem (PNG, JPG ou WEBP).')); return; }
    if (file.size > 8 * 1024 * 1024) { reject(new Error('Imagem grande demais (máximo 8 MB).')); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const lado = Math.min(img.naturalWidth, img.naturalHeight);
      const c = document.createElement('canvas');
      c.width = LADO_LOGO; c.height = LADO_LOGO;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      // recorte central em quadrado, sem esticar
      ctx.drawImage(img, (img.naturalWidth - lado) / 2, (img.naturalHeight - lado) / 2, lado, lado, 0, 0, LADO_LOGO, LADO_LOGO);
      const png = file.type === 'image/png' || file.type === 'image/svg+xml';
      resolve(png ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.86));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Não consegui ler essa imagem.')); };
    img.src = url;
  });
}

/** Grava (ou remove, com null) a foto da empresa. */
export async function salvarLogo(dataUrl) {
  const emp = await obter();
  if (!emp) throw new Error('Empresa não encontrada na base.');
  const nova = { ...emp, logo: dataUrl || null };
  await db.atualizar('empresa', nova);
  return nova;
}

export default { idEmpresa, obter, iniciais, elementoLogo, prepararImagem, salvarLogo, LADO_LOGO };
