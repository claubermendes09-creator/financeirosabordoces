/* ============================================================
   estado.js — cache de leitura compartilhado pelas telas

   Evita reler o plano de contas e as contas bancárias a cada
   navegação. Qualquer escrita chama `invalidar(...)`.
   ============================================================ */

import db from './db.js';
import { competenciaHoje } from './util.js';
import { PE_PADRAO } from './dre.js';

const cache = {};

export async function categorias() {
  if (!cache.categorias) {
    cache.categorias = (await db.listar('categoria')).sort((a, b) => a.ordem - b.ordem);
  }
  return cache.categorias;
}

export async function contas() {
  if (!cache.contas) {
    cache.contas = (await db.listar('conta')).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  }
  return cache.contas;
}

export async function lancamentos() {
  if (!cache.lancamentos) cache.lancamentos = await db.listar('lancamento');
  return cache.lancamentos;
}

export async function fechadas() {
  if (!cache.fechadas) cache.fechadas = await db.listar('competencia_fechada');
  return cache.fechadas;
}

export async function estaFechada(competencia) {
  return (await fechadas()).some(f => f.competencia === competencia);
}

export async function catPorId() {
  if (!cache.catPorId) cache.catPorId = new Map((await categorias()).map(c => [c.id, c]));
  return cache.catPorId;
}

export async function contaPorId() {
  if (!cache.contaPorId) cache.contaPorId = new Map((await contas()).map(c => [c.id, c]));
  return cache.contaPorId;
}

/** Competências que têm lançamentos, da mais nova para a mais antiga. */
export async function competencias() {
  const lista = [...new Set((await lancamentos()).map(l => l.competencia))].filter(Boolean);
  if (!lista.includes(competenciaHoje())) lista.push(competenciaHoje());
  return lista.sort().reverse();
}

export async function configPE() {
  return (await db.getConfig('formula_pe')) || PE_PADRAO;
}

export function invalidar(...chaves) {
  if (!chaves.length) {
    for (const k of Object.keys(cache)) delete cache[k];
    return;
  }
  for (const k of chaves) {
    delete cache[k];
    if (k === 'categorias') delete cache.catPorId;
    if (k === 'contas') delete cache.contaPorId;
  }
}

export default {
  categorias, contas, lancamentos, fechadas, estaFechada,
  catPorId, contaPorId, competencias, configPE, invalidar
};
