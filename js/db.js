/* ============================================================
   db.js — camada de dados

   ÚNICO módulo que conhece o mecanismo de persistência.
   O IndexedDB é sempre a leitura: rápido e funciona offline. Quando a
   nuvem está ativa (ver nuvem.js), toda escrita vai PRIMEIRO ao Supabase
   — que é a fonte da verdade — e só depois espelha no IndexedDB. Uma
   falha na nuvem interrompe a operação antes de tocar o cache local, para
   os dois nunca divergirem. `sincronizar()` refaz o cache do zero.

   API pública:
     db.abrir()
     db.listar(store, filtro?)          -> Promise<Array>
     db.obter(store, id)                -> Promise<obj|null>
     db.inserir(store, obj)             -> Promise<obj>
     db.atualizar(store, obj)           -> Promise<obj>
     db.remover(store, id)              -> Promise<void>
     db.emLote(store, ops)              -> Promise<{inseridos,atualizados,removidos,duplicados}>
     db.contar(store, filtro?)          -> Promise<number>
     db.porIndice(store, indice, valor) -> Promise<Array>
     db.limparTudo()                    -> Promise<void>
     db.exportarTudo() / db.importarTudo(json)
   ============================================================ */

import { uuid } from './util.js';
import nuvem from './nuvem.js';

export const NOME_BANCO = 'dre_sabor';
export const VERSAO_BANCO = 1;

export const STORES = [
  'empresa', 'perfil_usuario', 'categoria', 'conta', 'lancamento',
  'regra', 'importacao', 'competencia_fechada', 'auditoria', 'config'
];

/** Empresa única no modo local (espelha empresa_id do Postgres). */
export const EMPRESA_LOCAL = '00000000-0000-4000-8000-000000000001';

let _bd = null;

/* ------------------------------------------------------------
   Abertura / migração
   ------------------------------------------------------------ */

export function abrir() {
  if (_bd) return Promise.resolve(_bd);
  return new Promise((ok, erro) => {
    const req = indexedDB.open(NOME_BANCO, VERSAO_BANCO);

    req.onupgradeneeded = ev => {
      const bd = req.result;

      const cria = (nome, keyPath, indices = []) => {
        const st = bd.objectStoreNames.contains(nome)
          ? ev.target.transaction.objectStore(nome)
          : bd.createObjectStore(nome, { keyPath });
        for (const [ix, campo, opts] of indices) {
          if (!st.indexNames.contains(ix)) st.createIndex(ix, campo, opts || {});
        }
        return st;
      };

      cria('empresa', 'id');
      cria('perfil_usuario', 'id', [['papel', 'papel'], ['email', 'email', { unique: true }]]);

      cria('categoria', 'id', [
        ['nome', 'nome', { unique: true }],
        ['tipo', 'tipo'],
        ['grupo', 'grupo'],
        ['ordem', 'ordem']
      ]);

      cria('conta', 'id', [
        ['nome', 'nome', { unique: true }],
        ['layout', 'layout']
      ]);

      cria('lancamento', 'id', [
        ['competencia', 'competencia'],
        ['categoria_id', 'categoria_id'],
        ['conta_id', 'conta_id'],
        ['status', 'status'],
        ['data', 'data'],
        ['lote_id', 'lote_id'],
        ['hash_dedup', 'hash_dedup', { unique: true }],
        ['comp_cat', ['competencia', 'categoria_id']]
      ]);

      cria('regra', 'id', [
        ['padrao_norm', 'padrao_norm'],
        ['tipo_match', 'tipo_match'],
        ['categoria_id', 'categoria_id'],
        ['lookup', ['tipo_match', 'padrao_norm']]
      ]);

      cria('importacao', 'id', [
        ['competencia', 'competencia'],
        ['conta_id', 'conta_id'],
        ['arquivo_hash', 'arquivo_hash'],
        ['status', 'status']
      ]);

      cria('competencia_fechada', 'competencia');
      cria('auditoria', 'id', [['entidade', 'entidade'], ['criado_em', 'criado_em']]);
      cria('config', 'chave');
    };

    req.onsuccess = () => {
      _bd = req.result;
      _bd.onversionchange = () => { _bd.close(); _bd = null; };
      ok(_bd);
    };
    req.onerror = () => erro(req.error);
    req.onblocked = () => erro(new Error('Banco bloqueado por outra aba aberta. Feche as demais abas do app.'));
  });
}

function tx(store, modo = 'readonly') {
  return _bd.transaction(store, modo).objectStore(store);
}

function req2promise(r) {
  return new Promise((ok, erro) => {
    r.onsuccess = () => ok(r.result);
    r.onerror = () => erro(r.error);
  });
}

/* ------------------------------------------------------------
   Leitura
   ------------------------------------------------------------ */

/**
 * filtro: objeto de igualdade simples ({ competencia:'2026-06', status:'CLASSIFICADO' })
 *         ou função predicado. Valores em array viram "IN".
 */
export async function listar(store, filtro = null) {
  await abrir();
  let linhas = await req2promise(tx(store).getAll());
  if (!filtro) return linhas;
  if (typeof filtro === 'function') return linhas.filter(filtro);
  return linhas.filter(l => aplicaFiltro(l, filtro));
}

function aplicaFiltro(linha, filtro) {
  for (const [k, v] of Object.entries(filtro)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) { if (!v.includes(linha[k])) return false; }
    else if (linha[k] !== v) return false;
  }
  return true;
}

export async function obter(store, id) {
  await abrir();
  if (id == null) return null;
  const r = await req2promise(tx(store).get(id));
  return r === undefined ? null : r;
}

export async function porIndice(store, indice, valor) {
  await abrir();
  const ix = tx(store).index(indice);
  return req2promise(ix.getAll(valor));
}

export async function contar(store, filtro = null) {
  if (!filtro) { await abrir(); return req2promise(tx(store).count()); }
  return (await listar(store, filtro)).length;
}

/* ------------------------------------------------------------
   Escrita
   ------------------------------------------------------------ */

/**
 * Empresa dona da linha. Na nuvem é SEMPRE a empresa da sessão: a RLS recusa
 * qualquer outra, e várias telas ainda carimbam o id da empresa local — aqui
 * é o único lugar que precisa saber disso.
 */
function empresaDaLinha(atual) {
  const emp = nuvem.empresaId();
  if (emp) return emp;
  return atual || EMPRESA_LOCAL;
}

function carimbar(store, obj, novo) {
  const o = { ...obj };
  if (store !== 'config' && store !== 'empresa' && store !== 'perfil_usuario') {
    if (store !== 'competencia_fechada' && !o.id) o.id = uuid();
    o.empresa_id = empresaDaLinha(o.empresa_id);
  } else if (store !== 'config' && !o.empresa_id && store === 'perfil_usuario') {
    o.empresa_id = empresaDaLinha(null);
  }
  const agora = new Date().toISOString();
  if (novo && !o.criado_em) o.criado_em = agora;
  if ('atualizado_em' in o || store === 'lancamento') o.atualizado_em = agora;
  return o;
}

const naNuvem = store => nuvem.ativa() && nuvem.TABELAS_NUVEM.includes(store);

export async function inserir(store, obj) {
  await abrir();
  const o = carimbar(store, obj, true);
  if (naNuvem(store)) await nuvem.subir(store, o);
  const t = _bd.transaction(store, 'readwrite');
  await req2promise(t.objectStore(store).add(o));
  await fim(t);
  return o;
}

export async function atualizar(store, obj) {
  await abrir();
  const o = carimbar(store, obj, false);
  if (naNuvem(store)) await nuvem.subir(store, o);
  const t = _bd.transaction(store, 'readwrite');
  await req2promise(t.objectStore(store).put(o));
  await fim(t);
  return o;
}

/** put "cego": insere ou substitui, sem erro de chave duplicada */
export async function salvar(store, obj) {
  return atualizar(store, obj);
}

export async function remover(store, id) {
  await abrir();
  if (naNuvem(store)) await nuvem.apagar(store, [id]);
  const t = _bd.transaction(store, 'readwrite');
  await req2promise(t.objectStore(store).delete(id));
  await fim(t);
}

function fim(t) {
  return new Promise((ok, erro) => {
    t.oncomplete = () => ok();
    t.onerror = () => erro(t.error);
    t.onabort = () => erro(t.error || new Error('Transação abortada'));
  });
}

/**
 * Operações em lote numa única transação.
 * ops: [{ acao:'inserir'|'atualizar'|'remover', dados|id }]
 * Chave duplicada (hash_dedup) NÃO aborta o lote: conta em `duplicados`.
 */
export async function emLote(store, ops) {
  await abrir();
  const res = { inseridos: 0, atualizados: 0, removidos: 0, duplicados: 0, erros: [] };
  if (!ops.length) return res;

  // Nuvem primeiro. Os que a nuvem recusar como duplicados são retirados do
  // lote local, senão o cache ficaria com linhas que o servidor não tem.
  if (naNuvem(store)) {
    const remover = ops.filter(o => o.acao === 'remover').map(o => o.id);
    const inserir = ops.filter(o => o.acao !== 'atualizar' && o.acao !== 'remover');
    const atualizar = ops.filter(o => o.acao === 'atualizar');

    for (const op of [...inserir, ...atualizar]) op.dados = carimbar(store, op.dados, op.acao !== 'atualizar');

    if (remover.length) await nuvem.apagar(store, remover);
    if (atualizar.length) await nuvem.subirLote(store, atualizar.map(o => o.dados), { ignorarDuplicado: false });
    if (inserir.length) {
      const r = await nuvem.subirLote(store, inserir.map(o => o.dados), { ignorarDuplicado: true });
      if (r.duplicados) {
        // descobre quais ficaram de fora pela chave de conflito
        const chave = (nuvem.CONFLITO[store] || 'id').split(',');
        const aceitos = new Set((await nuvem.baixarTudo(store)).map(x => chave.map(c => x[c]).join('|')));
        for (const op of inserir) {
          if (!aceitos.has(chave.map(c => op.dados[c]).join('|'))) { op.acao = '_pular'; res.duplicados++; }
        }
      }
    }
    ops = ops.filter(o => o.acao !== '_pular');
    if (!ops.length) return res;
  }

  const t = _bd.transaction(store, 'readwrite');
  const st = t.objectStore(store);

  for (const op of ops) {
    if (op.acao === 'remover') {
      st.delete(op.id);
      res.removidos++;
      continue;
    }
    const novo = op.acao !== 'atualizar';
    const o = carimbar(store, op.dados, novo);
    op.dados = o;
    const r = novo ? st.add(o) : st.put(o);
    r.onsuccess = () => { novo ? res.inseridos++ : res.atualizados++; };
    r.onerror = ev => {
      // ConstraintError = já existe registro com o mesmo hash_dedup
      if (r.error && r.error.name === 'ConstraintError') res.duplicados++;
      else res.erros.push(String(r.error));
      ev.preventDefault();     // não aborta a transação inteira
      ev.stopPropagation();
    };
  }

  await fim(t);
  return res;
}

/* ------------------------------------------------------------
   Config (chave/valor)
   ------------------------------------------------------------ */

export async function getConfig(chave, padrao = null) {
  const r = await obter('config', chave);
  return r ? r.valor : padrao;
}

export async function setConfig(chave, valor) {
  await abrir();
  const t = _bd.transaction('config', 'readwrite');
  await req2promise(t.objectStore('config').put({ chave, valor }));
  await fim(t);
  return valor;
}

/* ------------------------------------------------------------
   Backup / restauração
   ------------------------------------------------------------ */

export async function exportarTudo() {
  await abrir();
  const dump = { _meta: { app: 'dre-sabor', versao: VERSAO_BANCO, exportado_em: new Date().toISOString() } };
  for (const s of STORES) {
    if (!_bd.objectStoreNames.contains(s)) continue;
    dump[s] = await listar(s);
  }
  return dump;
}

/** modo: 'substituir' limpa antes; 'mesclar' faz put por cima */
export async function importarTudo(dump, modo = 'substituir') {
  await abrir();
  const res = {};
  for (const s of STORES) {
    if (!_bd.objectStoreNames.contains(s) || !Array.isArray(dump[s])) continue;
    const linhas = (s === 'config' || s === 'empresa' || s === 'perfil_usuario')
      ? dump[s]
      : dump[s].map(l => ({ ...l, empresa_id: empresaDaLinha(l.empresa_id) }));
    if (naNuvem(s) && s !== 'perfil_usuario' && s !== 'empresa') {
      if (modo === 'substituir') await nuvem.apagarTudo(s);
      await nuvem.subirLote(s, linhas, { ignorarDuplicado: true });
    }
    const t = _bd.transaction(s, 'readwrite');
    const st = t.objectStore(s);
    if (modo === 'substituir') st.clear();
    for (const linha of linhas) st.put(linha);
    await fim(t);
    res[s] = dump[s].length;
  }
  return res;
}

export async function limparTudo(exceto = ['config']) {
  await abrir();
  for (const s of STORES) {
    if (!_bd.objectStoreNames.contains(s) || exceto.includes(s)) continue;
    if (naNuvem(s) && s !== 'perfil_usuario' && s !== 'empresa') await nuvem.apagarTudo(s);
    const t = _bd.transaction(s, 'readwrite');
    t.objectStore(s).clear();
    await fim(t);
  }
}

/**
 * Baixa todas as tabelas da empresa e substitui o cache local. Chamado no
 * login e sob demanda. `config` (preferências) nunca é tocado.
 */
export async function sincronizar(aoProgredir = null) {
  if (!nuvem.ativa()) return null;
  await abrir();
  const res = {};
  for (const tabela of nuvem.TABELAS_NUVEM) {
    if (!_bd.objectStoreNames.contains(tabela)) continue;
    // a auditoria só é escrita pelo app (e pelos triggers): nenhuma tela a lê.
    // Baixar milhares de linhas com JSON inteiro a cada login era o que
    // segurava a abertura por vários segundos.
    if (tabela === 'auditoria') continue;
    const linhas = await nuvem.baixarTudo(tabela);
    const t = _bd.transaction(tabela, 'readwrite');
    const st = t.objectStore(tabela);
    st.clear();
    for (const l of linhas) {
      if (tabela === 'auditoria' && l.id == null) continue;
      st.put(l);
    }
    await fim(t);
    res[tabela] = linhas.length;
    if (aoProgredir) aoProgredir(tabela, linhas.length);
  }
  return res;
}

export async function vazio() {
  return (await contar('categoria')) === 0;
}

/* ------------------------------------------------------------
   Auditoria (espelha a tabela `auditoria` do Postgres)
   ------------------------------------------------------------ */

export async function auditar(entidade, entidadeId, acao, antes, depois, usuarioId = null) {
  try {
    await inserir('auditoria', {
      empresa_id: EMPRESA_LOCAL,
      usuario_id: usuarioId,
      entidade, entidade_id: entidadeId, acao,
      antes: antes || null, depois: depois || null
    });
  } catch { /* auditoria nunca derruba a operação principal */ }
}

const db = {
  abrir, listar, obter, porIndice, contar,
  inserir, atualizar, salvar, remover, emLote,
  getConfig, setConfig,
  exportarTudo, importarTudo, limparTudo, sincronizar, vazio, auditar,
  EMPRESA_LOCAL, STORES
};

if (typeof window !== 'undefined') {
  window.db = db;
}

export default db;
