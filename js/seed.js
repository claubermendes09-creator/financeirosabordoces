/* ============================================================
   seed.js — carga inicial de categorias, contas e De/Para

   Lê `dados-exemplo.json` (na raiz do projeto) e grava no banco.
   Roda automaticamente no primeiro acesso; pode ser refeita pela
   tela de Backup.
   ============================================================ */

import db from './db.js';
import nuvem from './nuvem.js';

export const ARQUIVO_SEED = 'dados-exemplo.json';

/**
 * @param {boolean} forcar  sobrescreve registros existentes (mesmo id)
 */
export async function carregarSeed(forcar = false) {
  const resp = await fetch(new URL('../' + ARQUIVO_SEED, import.meta.url));
  if (!resp.ok) throw new Error(`Não encontrei ${ARQUIVO_SEED} (HTTP ${resp.status}).`);
  const dados = await resp.json();

  const res = { categorias: 0, contas: 0, regras: 0, empresa: 0 };

  if (Array.isArray(dados.empresa)) {
    // na nuvem a empresa já nasceu no bootstrap; o JSON só vale para o modo local
    if (!nuvem.ativa()) for (const e of dados.empresa) {
      if (forcar || !(await db.obter('empresa', e.id))) { await db.atualizar('empresa', e); res.empresa++; }
    }
  }

  for (const [store, chave] of [['categoria', 'categorias'], ['conta', 'contas'], ['regra', 'regras']]) {
    const lista = dados[store] || [];
    const existentes = new Set((await db.listar(store)).map(x => x.id));
    const ops = [];
    const emp = nuvem.empresaId();
    for (const item of lista) {
      if (existentes.has(item.id) && !forcar) continue;
      // o JSON traz a empresa do modo local; na nuvem cada conta tem a sua
      const linha = emp ? { ...item, empresa_id: emp } : item;
      ops.push({ acao: existentes.has(item.id) ? 'atualizar' : 'inserir', dados: linha });
    }
    if (ops.length) {
      const r = await db.emLote(store, ops);
      res[chave] = r.inseridos + r.atualizados;
    }
  }

  await db.setConfig('seed_versao', dados._meta ? dados._meta.gerado_em : '1');
  return res;
}

/* ------------------------------------------------------------
   Planilha DRE SABOR: memória de classificação + histórico da DRE
   ------------------------------------------------------------ */

export const ARQUIVO_MEMORIA_PLANILHA = 'dados/memoria-planilha.json';
export const ARQUIVO_DRE_PLANILHA = 'dados/dre-planilha.json';

async function buscarOpcional(caminho) {
  const resp = await fetch(new URL('../' + caminho, import.meta.url));
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`Falha ao ler ${caminho} (HTTP ${resp.status}).`);
  const dados = await resp.json();
  // dados/ é ignorado pelo Git: quem clonou o projeto pode não ter os arquivos
  return dados && typeof dados === 'object' ? dados : null;
}

/**
 * Aplica o que foi extraído da planilha "DRE SABOR": as regras de
 * classificação (BB, Stone e Caixa de junho/julho, mais o De/Para) e os
 * totais mensais da DRE. Os dois arquivos são opcionais — se não existirem,
 * não faz nada. Idempotente: regras já conhecidas são atualizadas, e os
 * lançamentos entram por hash, então repetir não duplica.
 */
export async function carregarPlanilha({ substituirMeses = false, aoProgredir = null } = {}) {
  const res = { regras: 0, regrasIgnoradas: 0, lancamentos: 0, semCategoria: 0, removidos: 0, encontrou: false, etapas: [] };
  const passo = txt => { res.etapas.push(txt); if (aoProgredir) aoProgredir(txt); };

  /* 1. lê os dois arquivos ANTES de tocar em qualquer coisa: falhou a leitura,
     nada muda na base */
  const mem = await buscarOpcional(ARQUIVO_MEMORIA_PLANILHA);
  const dre = await buscarOpcional(ARQUIVO_DRE_PLANILHA);
  passo(`memória: ${mem && Array.isArray(mem.regra) ? mem.regra.length + ' regras no arquivo' : 'arquivo não encontrado'}`);
  passo(`DRE: ${dre && Array.isArray(dre.lancamento) ? dre.lancamento.length + ' lançamentos no arquivo' : 'arquivo não encontrado'}`);
  if (!(mem && Array.isArray(mem.regra)) && !(dre && Array.isArray(dre.lancamento))) return res;
  res.encontrou = true;

  /* 2. os ids do JSON são os do seed; a base pode ter outros (restaurada de
     backup, criada de outro jeito). Casa categoria e conta pelo NOME. */
  const { normalizar } = await import('./util.js');
  const cats = await db.listar('categoria');
  const contas = await db.listar('conta');
  const catPorNome = new Map(cats.map(c => [normalizar(c.nome), c.id]));
  const contaPorNome = new Map(contas.map(c => [normalizar(c.nome), c.id]));
  const catIdPorSeed = new Map(), contaIdPorSeed = new Map();
  const seed = await fetch(new URL('../' + ARQUIVO_SEED, import.meta.url)).then(r => r.ok ? r.json() : null).catch(() => null);
  if (seed) {
    for (const c of seed.categoria || []) catIdPorSeed.set(c.id, catPorNome.get(normalizar(c.nome)) || null);
    for (const c of seed.conta || []) contaIdPorSeed.set(c.id, contaPorNome.get(normalizar(c.nome)) || null);
  }
  const idsCat = new Set(cats.map(c => c.id)), idsConta = new Set(contas.map(c => c.id));
  const catAtual = id => idsCat.has(id) ? id : (catIdPorSeed.get(id) || null);
  const contaAtual = id => idsConta.has(id) ? id : (contaIdPorSeed.get(id) || null);
  passo(`base: ${cats.length} categorias, ${contas.length} contas`);

  if (mem && Array.isArray(mem.regra)) {
    const { importarMemoria } = await import('./aprendizado.js');
    const r = await importarMemoria(mem);
    res.regras = r.importadas != null ? r.importadas : (r.inseridas || 0) + (r.atualizadas || 0);
    res.regrasIgnoradas = r.ignoradas || 0;
    passo(`regras gravadas: ${res.regras}` + (res.regrasIgnoradas ? ` (${res.regrasIgnoradas} sem categoria na base)` : ''));
  }

  if (dre && Array.isArray(dre.lancamento)) {
    const emp = nuvem.empresaId();
    const prontos = [];
    for (const l of dre.lancamento) {
      const categoria_id = catAtual(l.categoria_id), conta_id = contaAtual(l.conta_id);
      if (!categoria_id || !conta_id) { res.semCategoria++; continue; }
      prontos.push({ ...l, categoria_id, conta_id, empresa_id: emp || l.empresa_id });
    }
    if (res.semCategoria) passo(`${res.semCategoria} linha(s) sem categoria/conta correspondente na base — puladas`);

    /* 3. grava primeiro, apaga depois: se a gravação falhar, nada foi perdido */
    const jaTem = new Set((await db.listar('lancamento')).map(l => l.hash_dedup));
    const novos = prontos.filter(l => !jaTem.has(l.hash_dedup));
    for (let i = 0; i < novos.length; i += 400) {
      await db.importarTudo({ lancamento: novos.slice(i, i + 400) }, 'mesclar');
      passo(`lançamentos gravados: ${Math.min(i + 400, novos.length)} de ${novos.length}`);
    }
    res.lancamentos = novos.length;

    if (substituirMeses) {
      const meses = new Set(prontos.map(l => l.competencia));
      const daPlanilha = new Set(prontos.map(l => l.hash_dedup));
      const sobras = (await db.listar('lancamento')).filter(l => meses.has(l.competencia) && !daPlanilha.has(l.hash_dedup));
      if (sobras.length) {
        await db.emLote('lancamento', sobras.map(l => ({ acao: 'remover', id: l.id })));
        res.removidos = sobras.length;
      }
      passo(`removidos dos meses da planilha: ${res.removidos}`);
    }
  }

  return res;
}

/** Carrega o seed apenas se o banco ainda estiver vazio. */
export async function garantirSeed() {
  if (!(await db.vazio())) return null;
  const res = await carregarSeed(false);
  try {
    res.planilha = await carregarPlanilha();
  } catch (e) {
    console.warn('Planilha não carregada:', e.message);
  }
  return res;
}

export default { carregarSeed, carregarPlanilha, garantirSeed, ARQUIVO_SEED };
