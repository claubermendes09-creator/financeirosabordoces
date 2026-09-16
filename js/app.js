/* ============================================================
   app.js — bootstrap, tema, autenticação e roteamento por hash
   ============================================================ */

import db from './db.js';
import auth from './auth.js';
import { garantirSeed } from './seed.js';
import nuvem from './nuvem.js';
import empresa from './empresa.js';
import { el, iniciais, debounce } from './util.js';
import { icone, campo, selectSimples } from './ui/componentes.js';
import modal from './ui/modal.js';
import toast from './ui/toast.js';

/* ------------------------------------------------------------
   Rotas
   ------------------------------------------------------------ */

const ROTAS = [
  { id: 'dashboard',   rotulo: 'Dashboard',        icone: 'dashboard', mod: () => import('./telas/dashboard.js') },
  { id: 'lancamento',  rotulo: 'Lançamento manual', icone: 'lancar',   mod: () => import('./telas/lancamento.js'),  perm: 'lancar' },
  { id: 'importar',    rotulo: 'Importar extrato',  icone: 'importar', mod: () => import('./telas/importar.js'),    perm: 'importar' },
  { id: 'lancamentos', rotulo: 'Lançamentos',       icone: 'lista',    mod: () => import('./telas/lancamentos.js') },
  { id: 'dre',         rotulo: 'DRE',               icone: 'dre',      mod: () => import('./telas/dre.js') },
  { id: 'categorias',  rotulo: 'Categorias & Regras', icone: 'regras', mod: () => import('./telas/categorias.js') },
  { id: 'usuarios',    rotulo: 'Usuários',          icone: 'usuarios', mod: () => import('./telas/usuarios.js'),    perm: 'gerir_usuarios' },
  { id: 'backup',      rotulo: 'Backup',            icone: 'backup',   mod: () => import('./telas/backup.js'),      perm: 'backup' }
];

const APP = document.getElementById('app');

/* ------------------------------------------------------------
   Tema
   ------------------------------------------------------------ */

const CHAVE_TEMA = 'dre_sabor_tema';

export function aplicarTema(tema) {
  document.documentElement.setAttribute('data-theme', tema);
  try { localStorage.setItem(CHAVE_TEMA, tema); } catch { /* ignora */ }
}

function temaAtual() {
  try { return localStorage.getItem(CHAVE_TEMA) || 'dark'; } catch { return 'dark'; }
}

/* ------------------------------------------------------------
   Início
   ------------------------------------------------------------ */

async function iniciar() {
  // avisa o index.html que os módulos carregaram: o aviso de "falhou ao
  // carregar" não pode disparar só porque a sincronização demora
  document.documentElement.dataset.app = 'iniciando';
  const estadoInicial = txt => { const e = document.getElementById('estado-inicial'); if (e) e.textContent = txt; };
  aplicarTema(temaAtual());
  try {
    await db.abrir();
  } catch (e) {
    APP.append(el('div', { class: 'auth-bg' },
      el('div', { class: 'auth-card' },
        el('h1', { text: 'Não consegui abrir o banco local' }),
        el('div', { class: 'sub', text: e.message }))));
    return;
  }

  // Etapa 2: se houver config.js, a nuvem liga sozinha
  await nuvem.carregarConfig();
  let estadoSessao = 'sem-sessao';
  try {
    estadoSessao = await auth.restaurar();
  } catch (e) {
    console.error(e);
    toast.erro('Não consegui falar com o Supabase: ' + e.message);
  }
  if (estadoSessao === 'recuperacao') { await telaRedefinirSenha(); return; }

  // Lembra em que modo este navegador rodou da última vez. Se ele estava em
  // modo local e agora a nuvem ligou, o que foi feito aqui ainda não existe
  // lá — e a sincronização apagaria tudo. Guarda antes, pergunta depois.
  const modoAnterior = await db.getConfig('modo_ultimo', null);
  let resgate = null;
  if (nuvem.ativa() && modoAnterior === 'local') resgate = await guardarDadosLocais();
  await db.setConfig('modo_ultimo', nuvem.ativa() ? 'nuvem' : 'local');

  if (estadoSessao === 'ok' && nuvem.ativa()) {
    estadoInicial('Sincronizando com a nuvem…');
    await sincronizarComAviso(estadoInicial);
    if (!resgate) resgate = await db.getConfig('resgate_local', null);
    if (resgate) await oferecerResgate(resgate);
  }

  auth.aoAvisar(() => toast.aviso('Sua sessão expira em 2 minutos por inatividade.', 115000));
  auth.aoExpirar(() => { toast.erro('Sessão expirada.'); rotear(); });

  ['click', 'keydown'].forEach(ev =>
    document.addEventListener(ev, debounce(() => auth.tocar(), 30000), { passive: true }));

  window.addEventListener('hashchange', rotear);
  await rotear();
}

/* ------------------------------------------------------------
   Roteamento
   ------------------------------------------------------------ */

function partesDaHash() {
  const bruto = location.hash.replace(/^#\/?/, '');
  const [caminho, query] = bruto.split('?');
  const params = {};
  if (query) for (const [k, v] of new URLSearchParams(query)) params[k] = v;
  return { rota: caminho || 'dashboard', params };
}

export function irPara(hash) {
  if (location.hash === hash) rotear();
  else location.hash = hash;
}

let _pintando = false;
let _rotaPendente = false;

async function rotear() {
  // Uma troca de rota disparada no meio de outra não pode ser perdida:
  // fica pendente e roda assim que a atual terminar.
  if (_pintando) { _rotaPendente = true; return; }
  _pintando = true;
  try {
    if (/^#\/redefinir/.test(location.hash) && nuvem.ativa()) { await telaRedefinirSenha(); return; }
    if (/^#\/primeiro-acesso/.test(location.hash) && nuvem.ativa()) { await telaPrimeiroAcesso(); return; }
    if (await auth.precisaConfigurar()) { await telaPrimeiroAcesso(); return; }

    const s = auth.sessao();
    if (!s) { await telaLogin(); return; }

    await garantirSeed();
    await desenharShell(s);
  } finally {
    _pintando = false;
    if (_rotaPendente) { _rotaPendente = false; rotear(); }
  }
}

/* ------------------------------------------------------------
   Shell
   ------------------------------------------------------------ */

async function desenharShell(sessao) {
  const { rota, params } = partesDaHash();
  const def = ROTAS.find(r => r.id === rota) || ROTAS[0];

  if (def.perm && !auth.pode(def.perm)) {
    toast.erro('Seu perfil não tem acesso a esta tela.');
    irPara('#/dashboard');
    return;
  }

  APP.textContent = '';

  /* rail */
  const rail = el('nav', { class: 'rail', 'aria-label': 'Navegação principal' },
    empresa.elementoLogo('rail-logo', await empresa.obter()));

  const nav = el('div', { class: 'rail-nav' });
  for (const r of ROTAS) {
    if (r.perm && !auth.pode(r.perm)) continue;
    nav.append(el('button', {
      class: 'rail-btn', type: 'button',
      'aria-current': r.id === def.id ? 'page' : null,
      'aria-label': r.rotulo,
      onclick: () => irPara('#/' + r.id)
    }, icone(r.icone), el('span', { class: 'tip', text: r.rotulo })));
  }
  rail.append(nav);

  const tema = document.documentElement.getAttribute('data-theme');
  rail.append(el('div', { class: 'rail-foot' },
    el('span', { class: 'rail-sep', 'aria-hidden': 'true' }),
    nuvem.ativa() ? el('button', {
      class: 'rail-btn', type: 'button', 'aria-label': 'Sincronizar com a nuvem',
      onclick: async () => { await sincronizarComAviso(); desenharShell(auth.sessao()); }
    }, icone('backup'), el('span', { class: 'tip', text: 'Sincronizar' })) : null,
    el('button', {
      class: 'rail-btn', type: 'button', 'aria-label': tema === 'dark' ? 'Mudar para tema claro' : 'Mudar para tema escuro',
      onclick: async () => {
        const novo = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        aplicarTema(novo);
        await auth.salvarPreferenciaTema(novo);
        desenharShell(auth.sessao());
      }
    }, icone(tema === 'dark' ? 'sol' : 'lua'), el('span', { class: 'tip', text: tema === 'dark' ? 'Tema claro' : 'Tema escuro' })),
    el('button', {
      class: 'rail-btn', type: 'button', 'aria-label': 'Sair',
      onclick: async () => {
        const ok = await modal.confirmar('Sair', 'Encerrar a sessão neste navegador?', { rotuloOk: 'Sair' });
        if (ok) { auth.sair(); location.hash = ''; rotear(); }
      }
    }, icone('sair'), el('span', { class: 'tip', text: 'Sair' }))
  ));

  /* topbar */
  const busca = el('input', {
    type: 'search', placeholder: 'Buscar lançamento por descrição, favorecido ou documento…',
    'aria-label': 'Busca global', value: rota === 'lancamentos' ? (params.q || '') : ''
  });
  busca.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && busca.value.trim()) irPara('#/lancamentos?q=' + encodeURIComponent(busca.value.trim()));
  });

  const topbar = el('header', { class: 'topbar' },
    el('div', { class: 'brand' },
      el('div', {},
        el('div', { class: 'brand-name', text: 'DRE Sabor' }),
        el('div', { class: 'brand-sub', text: 'Sabor Doces & Salgados · ' + (nuvem.ativa() ? 'nuvem' : 'modo local') }))),
    el('div', { class: 'search' },
      el('span', { class: 'icon' }, icone('lupa', 16)), busca),
    el('div', { class: 'userbox' },
      el('span', { class: 'hello', html: `Olá, <b>${sessao.nome.split(' ')[0]}</b>!` }),
      el('button', {
        class: 'avatar', title: 'Meu perfil', 'aria-label': 'Meu perfil',
        onclick: () => telaPerfil()
      }, iniciais(sessao.nome)))
  );

  const conteudo = el('main', { class: 'content', id: 'conteudo' },
    el('div', { class: 'vazio', text: 'Carregando…' }));

  APP.append(el('div', { class: 'shell' }, rail, el('div', { class: 'main' }, topbar, conteudo)));

  /* tela */
  try {
    const mod = await def.mod();
    const ctx = { rota: def.id, params, irPara, sessao, recarregar: () => desenharShell(auth.sessao()) };
    const no = await mod.render(ctx);
    conteudo.textContent = '';
    conteudo.append(no);
  } catch (e) {
    console.error(e);
    conteudo.textContent = '';
    conteudo.append(el('div', { class: 'card' },
      el('div', { class: 'card-title', text: 'Erro ao montar a tela' }),
      el('pre', { class: 'muted', style: 'white-space:pre-wrap; font-size:12px; margin-top:10px', text: e.stack || e.message })));
  }
}

/* ------------------------------------------------------------
   Telas de autenticação
   ------------------------------------------------------------ */

function cartaoAuth(...conteudo) {
  APP.textContent = '';
  const card = el('div', { class: 'auth-card' },
    empresa.elementoLogo('auth-logo', null),
    ...conteudo);
  APP.append(el('div', { class: 'auth-bg' }, card));
  return card;
}

async function telaPrimeiroAcesso() {
  const nome = el('input', { class: 'input', placeholder: 'Seu nome', autocomplete: 'name' });
  const email = el('input', { class: 'input', type: 'email', placeholder: 'voce@empresa.com.br', autocomplete: 'username' });
  const senha = el('input', { class: 'input', type: 'password', placeholder: 'Mínimo 8 caracteres, com letra e número', autocomplete: 'new-password' });
  const senha2 = el('input', { class: 'input', type: 'password', placeholder: 'Repita a senha', autocomplete: 'new-password' });
  const barra = el('i');
  const forcaTxt = el('div', { class: 'hint' });
  const msg = el('div', {});

  senha.addEventListener('input', () => {
    const f = auth.forcaSenha(senha.value);
    barra.style.width = (f / 4 * 100) + '%';
    barra.style.background = ['var(--neg)', 'var(--neg)', 'var(--warn)', 'var(--accent-soft)', 'var(--accent)'][f];
    forcaTxt.textContent = senha.value ? auth.ROTULO_FORCA[f] : '';
  });

  const botao = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Criar acesso');

  const form = el('form', { novalidate: true },
    campo('Nome', nome, { span: '' }),
    campo('E-mail', email, { span: '' }),
    campo('Senha mestre', senha, { span: '' }),
    el('div', { class: 'forca' }, barra), forcaTxt,
    campo('Confirmar senha', senha2, { span: '' }),
    botao, msg);

  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    msg.textContent = '';
    try {
      if (!nome.value.trim()) throw new Error('Informe seu nome.');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.value.trim())) throw new Error('E-mail inválido.');
      if (senha.value !== senha2.value) throw new Error('As senhas não conferem.');
      botao.disabled = true;
      try {
        await auth.configurar({ nome: nome.value, email: email.value, senha: senha.value });
      } catch (e) {
        if (e.aguardandoConfirmacao) {
          msg.textContent = '';
          msg.append(el('div', { class: 'auth-msg ok', text: e.message }));
          return;
        }
        throw e;
      }
      if (!nuvem.ativa()) await auth.entrar(email.value, senha.value, true);
      else await sincronizarComAviso();
      await garantirSeed();
      toast.ok('Acesso criado. Plano de contas e De/Para carregados.');
      irPara('#/dashboard');
    } catch (e) {
      botao.disabled = false;
      msg.textContent = '';
      msg.append(el('div', { class: 'auth-msg err', text: e.message }));
    }
  });

  cartaoAuth(
    el('h1', { text: 'Primeiro acesso' }),
    el('div', { class: 'sub', text: nuvem.ativa()
      ? 'Crie a conta do administrador. O Supabase pode pedir confirmação por e-mail.'
      : 'Defina a senha mestre deste navegador. Ela é guardada como hash PBKDF2-SHA256 — nunca em texto puro.' }),
    form,
    el('div', { class: 'auth-modo', text: nuvem.ativa()
      ? 'Nuvem: esta conta vira o administrador de uma empresa nova no Supabase.'
      : 'Etapa 1 · modo local: os dados ficam apenas neste navegador (IndexedDB).' })
  );
  nome.focus();
}

async function telaLogin() {
  const email = el('input', { class: 'input', type: 'email', placeholder: 'voce@empresa.com.br', autocomplete: 'username' });
  const senha = el('input', { class: 'input', type: 'password', placeholder: 'Sua senha', autocomplete: 'current-password' });
  const lembrar = el('input', { type: 'checkbox' });
  const msg = el('div', {});
  const botao = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Entrar');

  try {
    const ultimo = localStorage.getItem('dre_sabor_ultimo_email');
    if (ultimo) email.value = ultimo;
  } catch { /* ignora */ }

  const form = el('form', { novalidate: true },
    campo('E-mail', email, { span: '' }),
    campo('Senha', senha, { span: '' }),
    el('label', { class: 'check', style: 'margin-top:6px' }, lembrar, el('span', { text: 'Manter conectado' })),
    botao, msg);

  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    msg.textContent = '';
    botao.disabled = true;
    try {
      await auth.entrar(email.value, senha.value, lembrar.checked);
      try { localStorage.setItem('dre_sabor_ultimo_email', email.value.trim().toLowerCase()); } catch { /* ignora */ }
      const s = auth.sessao();
      if (s.tema) aplicarTema(s.tema);
      if (nuvem.ativa()) await sincronizarComAviso();
      rotear();
    } catch (e) {
      botao.disabled = false;
      msg.textContent = '';
      msg.append(el('div', { class: 'auth-msg err', text: e.message }));
      senha.value = '';
      senha.focus();
    }
  });

  cartaoAuth(
    el('h1', { text: 'DRE Sabor' }),
    el('div', { class: 'sub', text: 'Controle financeiro do Sabor Doces & Salgados' }),
    form,
    el('div', { class: 'auth-links' },
      el('a', { tabindex: '0', role: 'button', onclick: telaEsqueciSenha, onkeydown: e => e.key === 'Enter' && telaEsqueciSenha() }, 'Esqueci minha senha'),
      nuvem.ativa()
        ? el('a', { tabindex: '0', role: 'button', onclick: telaPrimeiroAcesso, onkeydown: e => e.key === 'Enter' && telaPrimeiroAcesso() }, 'Primeiro acesso')
        : null),
    el('div', { class: 'auth-modo', text: nuvem.ativa()
      ? 'Nuvem · Supabase: login com e-mail e senha, recuperação por e-mail.'
      : 'Etapa 1 · modo local: uma senha mestre para este navegador.' })
  );
  (email.value ? senha : email).focus();
}

async function telaEsqueciSenha() {
  const email = el('input', { class: 'input', type: 'email', placeholder: 'voce@empresa.com.br' });
  const msg = el('div', {});
  const botao = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Enviar link de redefinição');

  const form = el('form', { novalidate: true }, campo('E-mail', email, { span: '' }), botao, msg);

  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    msg.textContent = '';
    try {
      const r = await auth.recuperarSenha(email.value);
      msg.append(el('div', { class: 'auth-msg ok', text: r.mensagem }));
      if (r.instrucaoLocal) msg.append(el('div', { class: 'auth-msg', style: 'background:var(--bg-input)', text: r.instrucaoLocal }));
      botao.disabled = true;
    } catch (e) {
      msg.append(el('div', { class: 'auth-msg err', text: e.message }));
    }
  });

  cartaoAuth(
    el('h1', { text: 'Esqueci minha senha' }),
    el('div', { class: 'sub', text: 'Informe o e-mail cadastrado.' }),
    form,
    el('div', { class: 'auth-links' },
      el('a', { tabindex: '0', role: 'button', onclick: telaLogin, onkeydown: e => e.key === 'Enter' && telaLogin() }, 'Voltar ao login')),
    el('div', { class: 'auth-modo', text: nuvem.ativa()
      ? 'O link do e-mail traz você de volta para cá com o formulário de nova senha.'
      : 'No modo local não há envio de e-mail — a recuperação por e-mail entra na Etapa 2 (Supabase).' })
  );
  email.focus();
}

/* ------------------------------------------------------------
   Redefinir senha (chegada pelo link do e-mail)
   ------------------------------------------------------------ */

async function telaRedefinirSenha() {
  const nova = el('input', { class: 'input', type: 'password', placeholder: 'Mínimo 8 caracteres, com letra e número', autocomplete: 'new-password' });
  const nova2 = el('input', { class: 'input', type: 'password', placeholder: 'Repita a senha', autocomplete: 'new-password' });
  const barra = el('i');
  const forcaTxt = el('div', { class: 'hint' });
  const msg = el('div', {});
  nova.addEventListener('input', () => {
    const f = auth.forcaSenha(nova.value);
    barra.style.width = (f / 4 * 100) + '%';
    barra.style.background = ['var(--neg)', 'var(--neg)', 'var(--warn)', 'var(--accent-soft)', 'var(--accent)'][f];
    forcaTxt.textContent = nova.value ? auth.ROTULO_FORCA[f] : '';
  });
  const botao = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Salvar nova senha');

  const form = el('form', { novalidate: true },
    campo('Nova senha', nova, { span: '' }),
    el('div', { class: 'forca' }, barra), forcaTxt,
    campo('Confirmar', nova2, { span: '' }),
    botao, msg);

  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    msg.textContent = '';
    try {
      if (nova.value !== nova2.value) throw new Error('As senhas não conferem.');
      botao.disabled = true;
      await auth.redefinirSenha(nova.value);
      toast.ok('Senha redefinida.');
      history.replaceState(null, '', location.pathname);   // limpa o token da URL
      await sincronizarComAviso();
      irPara('#/dashboard');
    } catch (e) {
      botao.disabled = false;
      msg.append(el('div', { class: 'auth-msg err', text: e.message }));
    }
  });

  cartaoAuth(
    el('h1', { text: 'Redefinir senha' }),
    el('div', { class: 'sub', text: 'Você chegou pelo link do e-mail. Escolha a nova senha.' }),
    form,
    el('div', { class: 'auth-links' },
      el('a', { tabindex: '0', role: 'button', onclick: () => { history.replaceState(null, '', location.pathname); telaLogin(); } }, 'Voltar ao login'))
  );
  nova.focus();
}

/* ------------------------------------------------------------
   Sincronização com a nuvem
   ------------------------------------------------------------ */

/* ------------------------------------------------------------
   Resgate do que foi feito em modo local
   ------------------------------------------------------------ */

/** Copia o que há no navegador antes de a sincronização limpar o cache. */
async function guardarDadosLocais() {
  const lancamentos = await db.listar('lancamento');
  const regras = await db.listar('regra');
  if (!lancamentos.length && !regras.length) return null;
  // guarda também numa cópia persistente: se a pessoa fechar a aba no meio,
  // a próxima abertura ainda encontra o resgate pendente
  const pacote = { quando: new Date().toISOString(), lancamentos, regras };
  await db.setConfig('resgate_local', pacote);
  return pacote;
}

/**
 * Já sincronizado com a nuvem: o que existia localmente e não está lá?
 * Compara por hash (lançamentos) e por padrão+tipo (regras) e oferece enviar.
 */
async function oferecerResgate(pacote) {
  const naNuvem = new Set((await db.listar('lancamento')).map(l => l.hash_dedup));
  const regrasNuvem = new Set((await db.listar('regra')).map(r => `${r.tipo_match}|${r.padrao_norm}|${r.conta_id || ''}`));
  const lancs = pacote.lancamentos.filter(l => !naNuvem.has(l.hash_dedup));
  const regras = pacote.regras.filter(r => !regrasNuvem.has(`${r.tipo_match}|${r.padrao_norm}|${r.conta_id || ''}`));
  if (!lancs.length && !regras.length) { await db.setConfig('resgate_local', null); return; }

  const meses = [...new Set(lancs.map(l => l.competencia))].sort().join(', ');
  const enviar = await modal.confirmar('Dados feitos em modo local',
    `Este navegador estava em <b>modo local</b> e tem <b>${lancs.length}</b> lançamento(s)` +
    (meses ? ` (${meses})` : '') + ` e <b>${regras.length}</b> regra(s) que ainda não existem na nuvem.<br><br>` +
    'Quer enviá-los para a nuvem agora? Se recusar, eles ficam guardados neste navegador e a pergunta volta na próxima abertura.',
    { rotuloOk: 'Enviar para a nuvem' });
  if (!enviar) return;

  try {
    const emp = nuvem.empresaId();
    if (regras.length) await db.importarTudo({ regra: regras.map(r => ({ ...r, empresa_id: emp })) }, 'mesclar');
    if (lancs.length) await db.importarTudo({ lancamento: lancs.map(l => ({ ...l, empresa_id: emp, lote_id: null, criado_por: null })) }, 'mesclar');
    await db.setConfig('resgate_local', null);
    toast.ok(`${lancs.length} lançamento(s) e ${regras.length} regra(s) enviados para a nuvem.`);
  } catch (e) {
    console.error(e);
    toast.erro('Não consegui enviar: ' + e.message + ' — os dados continuam guardados neste navegador.', 12000);
  }
}

async function sincronizarComAviso(aoProgredir = null) {
  if (!nuvem.ativa()) return;
  const t = toast.info('Sincronizando com a nuvem…', 60000);
  try {
    const r = await db.sincronizar(aoProgredir ? (tabela, n) => aoProgredir(`Sincronizando com a nuvem… ${tabela}: ${n}`) : null);
    t.remove();
    const total = Object.values(r || {}).reduce((a, b) => a + b, 0);
    toast.ok(`Sincronizado: ${total} registro(s).`, 2500);
  } catch (e) {
    t.remove();
    console.error(e);
    toast.erro('Falha ao sincronizar: ' + e.message, 8000);
  }
}

/* ------------------------------------------------------------
   Meu perfil
   ------------------------------------------------------------ */

async function telaPerfil() {
  const s = auth.sessao();
  const perfil = await db.obter('perfil_usuario', s.usuario_id);

  const nome = el('input', { class: 'input', value: perfil.nome });
  const tema = selectSimples([
    { valor: 'dark', rotulo: 'Escuro' }, { valor: 'light', rotulo: 'Claro' }
  ], document.documentElement.getAttribute('data-theme'));

  const atual = el('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
  const nova = el('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const nova2 = el('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const barra = el('i');
  nova.addEventListener('input', () => {
    const f = auth.forcaSenha(nova.value);
    barra.style.width = (f / 4 * 100) + '%';
    barra.style.background = ['var(--neg)', 'var(--neg)', 'var(--warn)', 'var(--accent-soft)', 'var(--accent)'][f];
  });

  const corpo = el('div', { class: 'form-grid' },
    campo('Nome', nome, { span: 'sp-6' }),
    el('div', { class: 'field sp-6' }, el('label', { text: 'E-mail' }),
      el('div', { style: 'padding-top:10px', text: perfil.email })),
    campo('Tema preferido', tema, { span: 'sp-6' }),
    el('div', { class: 'field sp-6' }, el('label', { text: 'Perfil de acesso' }),
      el('div', { style: 'padding-top:10px', text: auth.PAPEIS[perfil.papel].rotulo })),
    el('div', { class: 'sp-12', style: 'border-top:1px solid var(--border); padding-top:14px; margin-top:4px' },
      el('div', { class: 'card-title', text: nuvem.ativa() ? 'Trocar a minha senha' : 'Trocar a senha mestre' }),
      el('div', { class: 'card-sub', text: nuvem.ativa()
        ? 'Só a sua conta é alterada.'
        : 'A senha vale para todos os usuários deste navegador (modo local).' })),
    campo('Senha atual', atual, { span: 'sp-4' }),
    campo('Nova senha', nova, { span: 'sp-4' }),
    campo('Confirmar', nova2, { span: 'sp-4' }),
    el('div', { class: 'sp-12' }, el('div', { class: 'forca' }, barra))
  );

  const r = await modal.abrir({
    titulo: 'Meu perfil', corpo, largo: true,
    acoes: [{ rotulo: 'Fechar', classe: 'btn-ghost', valor: null }, { rotulo: 'Salvar', classe: 'btn-primary', valor: 'salvar' }]
  });
  if (r !== 'salvar') return;

  try {
    await db.atualizar('perfil_usuario', { ...perfil, nome: nome.value.trim() || perfil.nome, tema: tema.value });
    aplicarTema(tema.value);
    s.nome = nome.value.trim() || perfil.nome;
    s.tema = tema.value;

    if (atual.value || nova.value) {
      if (nova.value !== nova2.value) throw new Error('As senhas não conferem.');
      await auth.trocarSenha(atual.value, nova.value);
      toast.ok('Senha alterada.');
    } else {
      toast.ok('Perfil atualizado.');
    }
    desenharShell(auth.sessao());
  } catch (e) {
    toast.erro(e.message);
  }
}

/* ------------------------------------------------------------ */

iniciar();
