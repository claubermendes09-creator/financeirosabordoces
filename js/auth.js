/* ============================================================
   auth.js — sessão, perfis e permissões

   ETAPA 1 (modo local): uma senha mestre definida no primeiro acesso,
   guardada como PBKDF2-SHA256 com salt aleatório via WebCrypto — nunca
   em texto puro. A sessão vive em sessionStorage (ou localStorage quando
   o usuário marca "Manter conectado") e expira com 12h de inatividade,
   avisando 2 minutos antes.

   ETAPA 2 (Supabase): com config.js presente, as mesmas funções passam a
   chamar supabase.auth.* — login real, recuperação por e-mail, convite.
   A janela de 12h de inatividade continua valendo por cima da sessão do
   Supabase, que sozinha duraria mais.
   ============================================================ */

import db from './db.js';
import { uuid, hex } from './util.js';
import nuvem from './nuvem.js';

export function modo() { return nuvem.ativa() ? 'nuvem' : 'local'; }
export const MODO = 'local';

export const PAPEIS = {
  admin:    { rotulo: 'Administrador', descricao: 'Tudo, inclusive convidar usuários, editar categorias e apagar lançamentos' },
  operador: { rotulo: 'Operador',      descricao: 'Lançar, importar, classificar e editar os próprios lançamentos' },
  leitor:   { rotulo: 'Leitor',        descricao: 'Apenas visualizar DRE, dashboard e relatórios' }
};

export const PERMISSOES = {
  ver:                ['admin', 'operador', 'leitor'],
  lancar:             ['admin', 'operador'],
  importar:           ['admin', 'operador'],
  classificar:        ['admin', 'operador'],
  editar_lancamento:  ['admin', 'operador'],
  apagar_lancamento:  ['admin'],
  editar_categoria:   ['admin'],
  editar_regra:       ['admin', 'operador'],
  fechar_competencia: ['admin'],
  gerir_usuarios:     ['admin'],
  backup:             ['admin']
};

const CHAVE_SESSAO = 'dre_sabor_sessao';
const INATIVIDADE_MS = 12 * 60 * 60 * 1000;   // 12h
const AVISO_MS = 2 * 60 * 1000;               // avisa 2 min antes
const ITERACOES = 210000;
const TENTATIVAS_RECUPERACAO = 3;
const JANELA_RECUPERACAO_MS = 60 * 60 * 1000;

let _sessao = null;
let _timerAviso = null;
let _aoExpirar = null;
let _aoAvisar = null;

/* ------------------------------------------------------------
   Hash de senha (PBKDF2-SHA256 + salt aleatório)
   ------------------------------------------------------------ */

async function derivar(senha, saltHex, iteracoes = ITERACOES) {
  const salt = Uint8Array.from(saltHex.match(/../g).map(h => parseInt(h, 16)));
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(senha), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: iteracoes, hash: 'SHA-256' }, base, 256);
  return hex(bits);
}

export async function hashSenha(senha) {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await derivar(senha, salt);
  return { algoritmo: 'PBKDF2-SHA256', iteracoes: ITERACOES, salt, hash };
}

export async function conferirSenha(senha, guardado) {
  if (!guardado || !guardado.salt) return false;
  const h = await derivar(senha, guardado.salt, guardado.iteracoes || ITERACOES);
  // comparação de tempo constante
  if (h.length !== guardado.hash.length) return false;
  let dif = 0;
  for (let i = 0; i < h.length; i++) dif |= h.charCodeAt(i) ^ guardado.hash.charCodeAt(i);
  return dif === 0;
}

/* ------------------------------------------------------------
   Validação de senha
   ------------------------------------------------------------ */

export function validarSenha(senha) {
  const s = String(senha || '');
  if (s.length < 8) return 'A senha precisa de pelo menos 8 caracteres.';
  if (!/[A-Za-zÀ-ÿ]/.test(s)) return 'A senha precisa conter ao menos uma letra.';
  if (!/\d/.test(s)) return 'A senha precisa conter ao menos um número.';
  return null;
}

/** 0 a 4 */
export function forcaSenha(senha) {
  const s = String(senha || '');
  if (!s) return 0;
  let f = 0;
  if (s.length >= 8) f++;
  if (s.length >= 12) f++;
  if (/[A-Za-zÀ-ÿ]/.test(s) && /\d/.test(s)) f++;
  if (/[^A-Za-z0-9À-ÿ]/.test(s)) f++;
  return Math.min(f, 4);
}

export const ROTULO_FORCA = ['Muito fraca', 'Fraca', 'Razoável', 'Boa', 'Forte'];

/* ------------------------------------------------------------
   Primeiro acesso
   ------------------------------------------------------------ */

export async function precisaConfigurar() {
  if (nuvem.ativa()) return false;
  return !(await db.getConfig('senha_mestre'));
}

/**
 * Define a senha mestre e cria o perfil administrador.
 */
export async function configurar({ nome, email, senha }) {
  const erro = validarSenha(senha);
  if (erro) throw new Error(erro);

  if (nuvem.ativa()) return configurarNuvem({ nome, email, senha });

  await db.setConfig('senha_mestre', await hashSenha(senha));

  const perfil = {
    id: uuid(),
    empresa_id: db.EMPRESA_LOCAL,
    nome: nome.trim(),
    email: String(email).trim().toLowerCase(),
    papel: 'admin',
    tema: 'dark',
    ativo: true
  };
  await db.inserir('perfil_usuario', perfil);
  await db.setConfig('empresa_nome', 'Sabor Doces & Salgados');
  return perfil;
}

/* ------------------------------------------------------------
   Login / sessão
   ------------------------------------------------------------ */

/**
 * Mensagens de erro sempre genéricas: nunca revelar se o e-mail existe.
 */
export async function entrar(email, senha, lembrar = false) {
  const generico = new Error('E-mail ou senha inválidos.');
  if (nuvem.ativa()) return entrarNuvem(email, senha, lembrar, generico);

  const guardado = await db.getConfig('senha_mestre');
  if (!guardado) throw generico;

  const ok = await conferirSenha(senha, guardado);
  const perfis = await db.listar('perfil_usuario');
  const alvo = perfis.find(p => p.email === String(email).trim().toLowerCase() && p.ativo);

  if (!ok || !alvo) throw generico;

  _sessao = {
    usuario_id: alvo.id,
    nome: alvo.nome,
    email: alvo.email,
    papel: alvo.papel,
    tema: alvo.tema || 'dark',
    lembrar,
    ultima_atividade: Date.now()
  };
  gravarSessao();
  agendarExpiracao();
  return _sessao;
}

function gravarSessao() {
  const s = JSON.stringify(_sessao);
  try {
    (_sessao.lembrar ? localStorage : sessionStorage).setItem(CHAVE_SESSAO, s);
    (_sessao.lembrar ? sessionStorage : localStorage).removeItem(CHAVE_SESSAO);
  } catch { /* armazenamento bloqueado: sessão só na memória */ }
}

export function sessao() {
  if (_sessao) return _sessao;
  for (const st of [sessionStorage, localStorage]) {
    try {
      const bruto = st.getItem(CHAVE_SESSAO);
      if (!bruto) continue;
      const s = JSON.parse(bruto);
      if (Date.now() - s.ultima_atividade > INATIVIDADE_MS) { st.removeItem(CHAVE_SESSAO); continue; }
      _sessao = s;
      agendarExpiracao();
      return _sessao;
    } catch { /* entrada corrompida: ignora */ }
  }
  return null;
}

export function sair() {
  _sessao = null;
  clearTimeout(_timerAviso);
  if (nuvem.ativa()) { try { nuvem.cliente().auth.signOut(); } catch { /* sessão já morta */ } }
  nuvem.definirEmpresa(null);
  try { sessionStorage.removeItem(CHAVE_SESSAO); localStorage.removeItem(CHAVE_SESSAO); } catch { /* nada a fazer */ }
}

/** Chamado a cada interação para renovar a janela de inatividade. */
export function tocar() {
  if (!_sessao) return;
  _sessao.ultima_atividade = Date.now();
  gravarSessao();
  agendarExpiracao();
}

function agendarExpiracao() {
  clearTimeout(_timerAviso);
  if (!_sessao) return;
  const restante = INATIVIDADE_MS - (Date.now() - _sessao.ultima_atividade);
  const ateAviso = restante - AVISO_MS;
  _timerAviso = setTimeout(() => {
    if (_aoAvisar) _aoAvisar(Math.round(AVISO_MS / 1000));
    _timerAviso = setTimeout(() => {
      sair();
      if (_aoExpirar) _aoExpirar();
    }, AVISO_MS);
  }, Math.max(ateAviso, 0));
}

export function aoExpirar(fn) { _aoExpirar = fn; }
export function aoAvisar(fn) { _aoAvisar = fn; }

/* ------------------------------------------------------------
   Permissões
   ------------------------------------------------------------ */

export function pode(acao, s = sessao()) {
  if (!s) return false;
  const lista = PERMISSOES[acao];
  return !!lista && lista.includes(s.papel);
}

export function exigir(acao) {
  if (!pode(acao)) throw new Error('Seu perfil não tem permissão para esta ação.');
}

/* ------------------------------------------------------------
   Troca de senha e recuperação
   ------------------------------------------------------------ */

export async function trocarSenha(senhaAtual, senhaNova) {
  if (nuvem.ativa()) {
    const erro = validarSenha(senhaNova);
    if (erro) throw new Error(erro);
    const sb = nuvem.cliente();
    // reautentica com a senha atual antes de trocar: sem isso qualquer aba
    // aberta trocaria a senha do dono sem saber a antiga
    const s = sessao();
    const chk = await sb.auth.signInWithPassword({ email: s.email, password: senhaAtual });
    if (chk.error) throw new Error('Senha atual incorreta.');
    const r = await sb.auth.updateUser({ password: senhaNova });
    if (r.error) throw new Error(traduzir(r.error));
    return true;
  }
  const guardado = await db.getConfig('senha_mestre');
  if (!(await conferirSenha(senhaAtual, guardado))) throw new Error('Senha atual incorreta.');
  const erro = validarSenha(senhaNova);
  if (erro) throw new Error(erro);
  await db.setConfig('senha_mestre', await hashSenha(senhaNova));
  return true;
}

/**
 * Recuperação por e-mail só existe na Etapa 2 (Supabase). Aqui a função
 * apenas aplica o rate limit e devolve a resposta neutra — a tela explica
 * que, no modo local, o caminho é restaurar um backup JSON.
 */
export async function recuperarSenha(email) {
  const chave = 'recuperacao_' + String(email).trim().toLowerCase();
  const agora = Date.now();
  const registro = (await db.getConfig(chave)) || { tentativas: [] };
  const recentes = registro.tentativas.filter(t => agora - t < JANELA_RECUPERACAO_MS);

  if (recentes.length >= TENTATIVAS_RECUPERACAO) {
    const espera = Math.ceil((JANELA_RECUPERACAO_MS - (agora - recentes[0])) / 60000);
    throw new Error(`Muitas tentativas. Tente novamente em ${espera} minuto(s).`);
  }

  recentes.push(agora);
  await db.setConfig(chave, { tentativas: recentes });

  if (nuvem.ativa()) {
    // resposta neutra sempre: o erro do servidor (e-mail inexistente, por
    // exemplo) não chega ao formulário — é o que impede enumerar contas
    const destino = location.origin + location.pathname + '#/redefinir';
    try {
      await nuvem.cliente().auth.resetPasswordForEmail(String(email).trim().toLowerCase(), { redirectTo: destino });
    } catch { /* silêncio proposital */ }
    return {
      modo: 'nuvem',
      mensagem: 'Se este e-mail estiver cadastrado, enviamos um link de redefinição.',
      instrucaoLocal: null
    };
  }

  return {
    modo: MODO,
    mensagem: 'Se este e-mail estiver cadastrado, enviamos um link de redefinição.',
    instrucaoLocal: 'No modo local não há envio de e-mail. Para recuperar o acesso, restaure um backup JSON pela tela de Backup em outro navegador/dispositivo onde ainda haja sessão ativa, ou reconfigure o app pelo primeiro acesso (os dados locais são apagados).'
  };
}

/** Reconfiguração de emergência do modo local: apaga tudo e recomeça. */
export async function resetarModoLocal() {
  await db.limparTudo([]);
  sair();
}

/* ------------------------------------------------------------
   Perfis (multiusuário)
   ------------------------------------------------------------ */

export async function listarUsuarios() {
  return (await db.listar('perfil_usuario')).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

export async function convidarUsuario({ nome, email, papel }) {
  exigir('gerir_usuarios');
  const e = String(email).trim().toLowerCase();
  const existe = (await db.listar('perfil_usuario')).some(p => p.email === e);
  if (existe) throw new Error('Já existe um usuário com este e-mail.');
  if (!PAPEIS[papel]) throw new Error('Perfil inválido.');

  if (nuvem.ativa()) return convidarNuvem({ nome: nome.trim(), email: e, papel });

  return db.inserir('perfil_usuario', {
    id: uuid(), empresa_id: db.EMPRESA_LOCAL,
    nome: nome.trim(), email: e, papel, tema: 'dark', ativo: true
  });
}

export async function alterarUsuario(id, mudancas) {
  exigir('gerir_usuarios');
  const p = await db.obter('perfil_usuario', id);
  if (!p) throw new Error('Usuário não encontrado.');
  if (mudancas.papel && p.papel === 'admin' && mudancas.papel !== 'admin') {
    const admins = (await db.listar('perfil_usuario')).filter(u => u.papel === 'admin' && u.ativo);
    if (admins.length <= 1) throw new Error('É preciso manter ao menos um administrador ativo.');
  }
  if (mudancas.ativo === false && p.papel === 'admin') {
    const admins = (await db.listar('perfil_usuario')).filter(u => u.papel === 'admin' && u.ativo);
    if (admins.length <= 1) throw new Error('É preciso manter ao menos um administrador ativo.');
  }
  const novo = { ...p, ...mudancas };
  await db.atualizar('perfil_usuario', novo);
  if (_sessao && _sessao.usuario_id === id) {
    Object.assign(_sessao, { nome: novo.nome, papel: novo.papel, tema: novo.tema });
    gravarSessao();
  }
  return novo;
}

export async function salvarPreferenciaTema(tema) {
  const s = sessao();
  if (!s) return;
  const p = await db.obter('perfil_usuario', s.usuario_id);
  if (p) await db.atualizar('perfil_usuario', { ...p, tema });
  s.tema = tema;
  gravarSessao();
}

/* ------------------------------------------------------------
   Nuvem (Supabase)
   ------------------------------------------------------------ */

function traduzir(erro) {
  const m = String((erro && erro.message) || erro || '');
  if (/invalid login|invalid credentials/i.test(m)) return 'E-mail ou senha inválidos.';
  if (/email not confirmed/i.test(m)) return 'Confirme o e-mail antes de entrar: o Supabase enviou um link.';
  if (/already registered|already exists/i.test(m)) return 'Este e-mail já tem cadastro.';
  if (/password.*(short|weak)|at least/i.test(m)) return 'A senha precisa de pelo menos 8 caracteres.';
  if (/rate limit|too many/i.test(m)) return 'Muitas tentativas. Aguarde um minuto.';
  if (/network|fetch/i.test(m)) return 'Sem conexão com o servidor.';
  return m || 'Falha ao falar com o servidor.';
}

async function montarSessaoNuvem(usuario, lembrar) {
  const sb = nuvem.cliente();
  const r = await sb.from('perfil_usuario').select('*').eq('id', usuario.id).maybeSingle();
  if (r.error) throw new Error(traduzir(r.error));
  const perfil = r.data;
  if (!perfil) return null;                       // autenticou, mas ainda não tem empresa
  if (!perfil.ativo) throw new Error('Este usuário está desativado. Fale com um administrador.');

  nuvem.definirEmpresa(perfil.empresa_id);
  _sessao = {
    usuario_id: perfil.id,
    nome: perfil.nome,
    email: perfil.email || usuario.email,
    papel: perfil.papel,
    tema: perfil.tema || 'dark',
    empresa_id: perfil.empresa_id,
    lembrar,
    ultima_atividade: Date.now()
  };
  gravarSessao();
  agendarExpiracao();
  return _sessao;
}

async function entrarNuvem(email, senha, lembrar, generico) {
  const sb = nuvem.cliente();
  const r = await sb.auth.signInWithPassword({ email: String(email).trim().toLowerCase(), password: senha });
  if (r.error) {
    if (/invalid/i.test(r.error.message)) throw generico;
    throw new Error(traduzir(r.error));
  }
  const s = await montarSessaoNuvem(r.data.user, lembrar);
  if (!s) {
    // usuário sem empresa: primeiro acesso incompleto. Cria a empresa agora.
    await bootstrapNuvem(r.data.user, r.data.user.user_metadata && r.data.user.user_metadata.nome);
    return montarSessaoNuvem(r.data.user, lembrar);
  }
  return s;
}

/**
 * Cria a empresa e o perfil admin para um usuário recém-autenticado.
 * A função no banco é security definer — é o único jeito de nascer a
 * primeira linha em perfil_usuario, já que a RLS exige um admin para
 * inserir e não existe admin ainda.
 */
async function bootstrapNuvem(usuario, nome) {
  await nuvem.rpc('bootstrap_empresa', {
    p_nome_empresa: 'Sabor Doces & Salgados',
    p_nome_usuario: nome || (usuario.email || '').split('@')[0],
    p_email: usuario.email
  });
}

async function configurarNuvem({ nome, email, senha }) {
  const sb = nuvem.cliente();
  const e = String(email).trim().toLowerCase();
  const r = await sb.auth.signUp({ email: e, password: senha, options: { data: { nome: nome.trim() } } });
  if (r.error) throw new Error(traduzir(r.error));

  // Com "confirmar e-mail" ligado no Supabase, não há sessão ainda: a pessoa
  // recebe um link, e o bootstrap acontece no primeiro login (entrarNuvem).
  if (!r.data.session) {
    const err = new Error('Cadastro criado. Confirme o e-mail que o Supabase enviou e depois entre.');
    err.aguardandoConfirmacao = true;
    throw err;
  }
  await bootstrapNuvem(r.data.user, nome.trim());
  return montarSessaoNuvem(r.data.user, true);
}

/**
 * Convite sem servidor próprio: um cliente descartável cadastra o e-mail
 * com senha aleatória (a sessão do admin não é tocada), o perfil nasce na
 * empresa do admin, e a pessoa define a própria senha por "Esqueci minha
 * senha". O Supabase envia o e-mail de confirmação/redefinição.
 */
async function convidarNuvem({ nome, email, papel }) {
  const temp = nuvem.clienteDescartavel();
  const senhaTemp = hex(crypto.getRandomValues(new Uint8Array(16))) + 'Aa1';
  const r = await temp.auth.signUp({ email, password: senhaTemp, options: { data: { nome } } });
  if (r.error) throw new Error(traduzir(r.error));
  const id = r.data.user && r.data.user.id;
  if (!id) throw new Error('O Supabase não devolveu o usuário criado.');

  const perfil = await db.inserir('perfil_usuario', {
    id, empresa_id: nuvem.empresaId(), nome, email, papel, tema: 'dark', ativo: true
  });

  try {
    await nuvem.cliente().auth.resetPasswordForEmail(email, {
      redirectTo: location.origin + location.pathname + '#/redefinir'
    });
  } catch { /* o link de confirmação já foi; a redefinição pode ser pedida depois */ }

  return perfil;
}

/**
 * Após o link de recuperação: o supabase-js já trocou o token da URL por
 * uma sessão de recuperação; basta gravar a senha nova.
 */
export async function redefinirSenha(senhaNova) {
  if (!nuvem.ativa()) throw new Error('Redefinição por link só existe com o Supabase ligado.');
  const erro = validarSenha(senhaNova);
  if (erro) throw new Error(erro);
  const sb = nuvem.cliente();
  const r = await sb.auth.updateUser({ password: senhaNova });
  if (r.error) throw new Error(traduzir(r.error));
  const u = (await sb.auth.getUser()).data.user;
  return montarSessaoNuvem(u, true);
}

/**
 * Chamado uma vez no arranque. Na nuvem, reconstrói a sessão a partir do
 * token que o supabase-js guardou; no modo local, não faz nada.
 * @returns {'ok'|'sem-sessao'|'recuperacao'}
 */
export async function restaurar() {
  if (!nuvem.ativa()) return sessao() ? 'ok' : 'sem-sessao';
  const sb = nuvem.cliente();

  // o link "esqueci minha senha" cai aqui com type=recovery na URL
  const recuperacao = /type=recovery/.test(location.hash) || /type=recovery/.test(location.search);

  const r = await sb.auth.getSession();
  const sess = r.data && r.data.session;
  if (!sess) return recuperacao ? 'recuperacao' : 'sem-sessao';
  if (recuperacao) return 'recuperacao';

  const local = sessao();
  if (local && local.usuario_id === sess.user.id) {
    nuvem.definirEmpresa(local.empresa_id);
    return 'ok';
  }
  const s = await montarSessaoNuvem(sess.user, true);
  return s ? 'ok' : 'sem-sessao';
}

export default {
  MODO, PAPEIS, PERMISSOES,
  modo, precisaConfigurar, configurar, entrar, sair, sessao, tocar, restaurar, redefinirSenha,
  pode, exigir, aoExpirar, aoAvisar,
  trocarSenha, recuperarSenha, resetarModoLocal,
  listarUsuarios, convidarUsuario, alterarUsuario, salvarPreferenciaTema,
  validarSenha, forcaSenha, ROTULO_FORCA
};
