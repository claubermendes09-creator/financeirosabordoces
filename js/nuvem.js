/* ============================================================
   nuvem.js — ponte com o Supabase (Etapa 2)

   Único lugar que sabe da existência do supabase-js. O resto do app
   continua falando com db.js e auth.js, que consultam `ativa()` para
   decidir se escrevem na nuvem ou só no IndexedDB.

   Ativação: existir um `config.js` na raiz exportando SUPABASE_URL e
   SUPABASE_ANON_KEY, e o vendor/supabase.js ter carregado. Sem isso o
   app segue 100% local — não há flag para ligar, é a presença do arquivo.

   A `anon key` é pública por desenho: quem protege os dados é a RLS do
   schema.sql, não a chave.
   ============================================================ */

let _cfg = null;
let _cliente = null;
let _empresaId = null;

/* ------------------------------------------------------------
   Configuração
   ------------------------------------------------------------ */

/**
 * Tenta carregar config.js. Um 404 é o caminho normal do modo local:
 * o arquivo não está no Git e só existe em quem ligou a nuvem.
 */
export async function carregarConfig() {
  try {
    const m = await import('../config.js');
    if (m.SUPABASE_URL && m.SUPABASE_ANON_KEY) _cfg = { url: m.SUPABASE_URL, chave: m.SUPABASE_ANON_KEY };
  } catch {
    _cfg = null;
  }
  return ativa();
}

export function ativa() {
  return !!(_cfg && globalThis.supabase && globalThis.supabase.createClient);
}

export function cliente() {
  if (!ativa()) return null;
  if (!_cliente) {
    _cliente = globalThis.supabase.createClient(_cfg.url, _cfg.chave, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
  }
  return _cliente;
}

/**
 * Um cliente descartável, sem sessão persistida. Serve para cadastrar um
 * usuário convidado sem derrubar a sessão do administrador que convida.
 */
export function clienteDescartavel() {
  if (!ativa()) return null;
  return globalThis.supabase.createClient(_cfg.url, _cfg.chave, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
}

export function empresaId() { return _empresaId; }
export function definirEmpresa(id) { _empresaId = id || null; }

/* ------------------------------------------------------------
   Colunas por tabela — o IndexedDB aceita qualquer campo, o Postgres
   não. Tudo que não está aqui é descartado antes de subir.
   ------------------------------------------------------------ */

export const COLUNAS = {
  empresa:             ['id', 'nome', 'cnpj', 'logo', 'criado_em'],
  perfil_usuario:      ['id', 'empresa_id', 'nome', 'email', 'papel', 'tema', 'ativo', 'criado_em'],
  categoria:           ['id', 'empresa_id', 'nome', 'tipo', 'grupo', 'ordem', 'ativa'],
  conta:               ['id', 'empresa_id', 'nome', 'tipo', 'documento', 'layout', 'ativa'],
  lancamento:          ['id', 'empresa_id', 'data', 'competencia', 'descricao', 'favorecido', 'documento',
                        'classificacao', 'valor', 'sentido', 'categoria_id', 'conta_id', 'origem', 'status',
                        'arquivo_origem', 'lote_id', 'hash_dedup', 'recorrente', 'observacao', 'criado_por',
                        'criado_em', 'atualizado_em'],
  regra:               ['id', 'empresa_id', 'padrao', 'padrao_norm', 'tipo_match', 'categoria_id', 'conta_id',
                        'acertos', 'erros', 'confianca', 'origem_regra', 'criado_em', 'ultimo_uso'],
  importacao:          ['id', 'empresa_id', 'conta_id', 'competencia', 'arquivo_nome', 'arquivo_hash',
                        'linhas_lidas', 'linhas_gravadas', 'linhas_duplicadas', 'linhas_a_classificar',
                        'status', 'importado_por', 'criado_em'],
  competencia_fechada: ['empresa_id', 'competencia', 'fechada_em', 'fechada_por'],
  auditoria:           ['empresa_id', 'usuario_id', 'entidade', 'entidade_id', 'acao', 'antes', 'depois', 'criado_em']
};

/** Chave de conflito para upsert idempotente. */
export const CONFLITO = {
  lancamento: 'empresa_id,hash_dedup',
  categoria: 'empresa_id,nome',
  conta: 'empresa_id,nome',
  competencia_fechada: 'empresa_id,competencia'
};

/** Chave primária usada em delete/get. */
export const CHAVE = {
  competencia_fechada: 'competencia'
};

/** Tabelas que existem na nuvem (config e o resto ficam só no navegador). */
export const TABELAS_NUVEM = Object.keys(COLUNAS);

export function podar(tabela, obj) {
  const cols = COLUNAS[tabela];
  if (!cols) return obj;
  const out = {};
  for (const c of cols) if (obj[c] !== undefined) out[c] = obj[c];
  if (!out.empresa_id && cols.includes('empresa_id') && _empresaId) out.empresa_id = _empresaId;
  return out;
}

/* ------------------------------------------------------------
   Operações
   ------------------------------------------------------------ */

function erroDe(res, acao, tabela) {
  const e = new Error(`Supabase · ${acao} em ${tabela}: ${res.error.message}`);
  e.codigo = res.error.code;
  e.detalhe = res.error.details || res.error.hint || null;
  return e;
}

export const PAGINA = 1000;

/** Baixa a tabela inteira. O PostgREST corta em 1.000 linhas: pagina com range(). */
export async function baixarTudo(tabela) {
  const sb = cliente();
  const chave = CHAVE[tabela] || 'id';
  const tudo = [];
  for (let de = 0; ; de += PAGINA) {
    const res = await sb.from(tabela).select('*').order(chave, { ascending: true }).range(de, de + PAGINA - 1);
    if (res.error) throw erroDe(res, 'select', tabela);
    const pagina = res.data || [];
    tudo.push(...pagina);
    if (pagina.length < PAGINA) break;
  }
  return tudo;
}

export async function subir(tabela, obj, { ignorarDuplicado = false } = {}) {
  const sb = cliente();
  const dados = podar(tabela, obj);

  // A empresa nasce só pelo bootstrap_empresa: a RLS não tem política de
  // INSERT, e o Postgres checa essa política num upsert mesmo quando a linha
  // já existe. Então aqui é UPDATE puro, pelo id.
  if (tabela === 'empresa') {
    const { id, ...campos } = dados;
    const res = await sb.from(tabela).update(campos).eq('id', id).select();
    if (res.error) throw erroDe(res, 'update', tabela);
    if (!res.data || !res.data.length) throw new Error('Supabase · empresa não encontrada ou sem permissão para editar (é preciso ser administrador).');
    return res.data[0];
  }

  const opts = { onConflict: CONFLITO[tabela] || undefined, ignoreDuplicates: ignorarDuplicado };
  const res = await sb.from(tabela).upsert(dados, opts).select();
  if (res.error) throw erroDe(res, 'upsert', tabela);
  return res.data ? res.data[0] : dados;
}

/**
 * Upsert em lote. Devolve quantos entraram; a diferença para o total é o
 * que colidiu na chave de conflito (duplicados).
 */
export const TAMANHO_LOTE = 400;

export async function subirLote(tabela, lista, { ignorarDuplicado = true } = {}) {
  if (!lista.length) return { gravados: 0, duplicados: 0 };
  const sb = cliente();
  const dados = lista.map(o => podar(tabela, o));
  // em fatias: 2.000 lançamentos num pedido só estouram o limite do PostgREST
  let gravados = 0;
  for (let i = 0; i < dados.length; i += TAMANHO_LOTE) {
    const fatia = dados.slice(i, i + TAMANHO_LOTE);
    const res = await sb.from(tabela)
      .upsert(fatia, { onConflict: CONFLITO[tabela] || undefined, ignoreDuplicates: ignorarDuplicado })
      .select('id');
    if (res.error) throw erroDe(res, 'upsert em lote', tabela);
    gravados += res.data ? res.data.length : fatia.length;
  }
  return { gravados, duplicados: Math.max(0, dados.length - gravados) };
}

export async function apagar(tabela, ids) {
  if (!ids.length) return;
  const sb = cliente();
  const chave = CHAVE[tabela] || 'id';
  // a lista de ids vai na URL: em fatias para não estourar o tamanho
  for (let i = 0; i < ids.length; i += TAMANHO_LOTE) {
    const res = await sb.from(tabela).delete().in(chave, ids.slice(i, i + TAMANHO_LOTE));
    if (res.error) throw erroDe(res, 'delete', tabela);
  }
}

export async function apagarTudo(tabela) {
  const sb = cliente();
  if (!_empresaId) return;
  const res = await sb.from(tabela).delete().eq('empresa_id', _empresaId);
  if (res.error) throw erroDe(res, 'delete tudo', tabela);
}

export async function rpc(nome, args) {
  const sb = cliente();
  const res = await sb.rpc(nome, args);
  if (res.error) throw erroDe(res, 'rpc ' + nome, '—');
  return res.data;
}

export default {
  carregarConfig, ativa, cliente, clienteDescartavel, empresaId, definirEmpresa,
  COLUNAS, CONFLITO, TABELAS_NUVEM, podar,
  baixarTudo, subir, subirLote, apagar, apagarTudo, rpc
};
