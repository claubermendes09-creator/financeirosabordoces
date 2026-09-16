/* ============================================================
   telas/usuarios.js — perfis de acesso (somente admin)
   ============================================================ */

import auth from '../auth.js';
import empresa from '../empresa.js';
import { el, dataBR, esc } from '../util.js';
import { campo, selectSimples, icone, badge } from '../ui/componentes.js';
import modal from '../ui/modal.js';
import toast from '../ui/toast.js';
import { ordenavel } from '../ui/tabela.js';

export const titulo = 'Usuários';

let S = null;

export async function render(ctx) {
  S = { ctx, lista: [] };

  const raiz = document.createDocumentFragment();
  raiz.append(el('div', { class: 'page-head' },
    el('h1', { class: 'page-title', text: 'Usuários' }),
    el('div', { class: 'page-desc', text: 'Quem acessa o app e com qual perfil.' })
  ));

  if (!auth.pode('gerir_usuarios')) {
    raiz.append(el('div', { class: 'card' },
      el('div', { class: 'vazio', text: 'Somente administradores podem gerir usuários.' })));
    return raiz;
  }

  raiz.append(el('div', { class: 'alerta info', style: 'margin-bottom:20px' },
    icone('cadeado', 18),
    el('span', {
      html: auth.modo() === 'nuvem'
        ? 'Nuvem: cada pessoa tem login e senha próprios. Convidar cria a conta e envia um e-mail para ' +
          'a pessoa definir a senha; desativar bloqueia o acesso na hora.'
        : 'Modo local (Etapa 1): todos entram com a <b>mesma senha mestre</b>, e o e-mail define o perfil de acesso. ' +
          'O convite por e-mail e a senha individual chegam na Etapa 2, com o Supabase.'
    })));

  raiz.append(await cardEmpresa());

  S.painel = el('div', {});
  raiz.append(S.painel);
  await recarregar();
  return raiz;
}

/* ------------------------------------------------------------
   Foto da empresa
   ------------------------------------------------------------ */

async function cardEmpresa() {
  const emp = await empresa.obter();
  const preview = el('div', { class: 'logo-preview' });
  const pintarPreview = e => {
    preview.textContent = '';
    if (e && e.logo) preview.append(el('img', { src: e.logo, alt: '' }));
    else preview.textContent = empresa.iniciais(e && e.nome);
  };
  pintarPreview(emp);

  const arquivo = el('input', { type: 'file', accept: 'image/*', class: 'sr-only', id: 'u-logo' });
  const btnRemover = el('button', { class: 'btn btn-sm btn-ghost', disabled: !(emp && emp.logo) }, 'Remover foto');

  arquivo.addEventListener('change', async () => {
    const f = arquivo.files[0];
    arquivo.value = '';
    if (!f) return;
    try {
      const dataUrl = await empresa.prepararImagem(f);
      const nova = await empresa.salvarLogo(dataUrl);
      pintarPreview(nova);
      btnRemover.disabled = false;
      toast.ok('Foto da empresa atualizada.');
      atualizarRail(nova);
    } catch (e) {
      toast.erro(e.message);
    }
  });

  btnRemover.addEventListener('click', async () => {
    try {
      const nova = await empresa.salvarLogo(null);
      pintarPreview(nova);
      btnRemover.disabled = true;
      toast.ok('Foto removida — voltam as iniciais.');
      atualizarRail(nova);
    } catch (e) {
      toast.erro(e.message);
    }
  });

  return el('div', { class: 'card', style: 'margin-bottom:20px' },
    el('div', { class: 'card-head' },
      el('div', {},
        el('div', { class: 'card-title', text: 'Empresa' }),
        el('div', { class: 'card-sub', text: (emp && emp.nome) || 'Sabor Doces & Salgados' }))),
    el('div', { class: 'logo-linha' },
      preview,
      el('div', {},
        el('p', { class: 'muted', style: 'font-size:13px; margin:0 0 12px; line-height:1.6' },
          'A foto aparece no menu lateral e na tela de login. PNG, JPG ou WEBP; ',
          'é recortada em quadrado e reduzida antes de gravar.'),
        el('div', { class: 'form-actions', style: 'margin:0' },
          arquivo,
          el('label', { class: 'btn btn-sm btn-primary', for: 'u-logo', style: 'cursor:pointer' }, icone('editar', 14), 'Trocar foto'),
          btnRemover))));
}

/** Troca o logo do rail sem repintar a tela inteira. */
function atualizarRail(emp) {
  const atual = document.querySelector('.rail-logo');
  if (atual) atual.replaceWith(empresa.elementoLogo('rail-logo', emp));
}

async function recarregar() {
  S.lista = await auth.listarUsuarios();
  pintar();
}

function pintar() {
  S.painel.textContent = '';

  S.painel.append(el('div', { class: 'toolbar' },
    el('span', { style: 'flex:1' }),
    el('button', { class: 'btn btn-sm btn-primary', onclick: () => editar(null) }, icone('lancar', 14), 'Convidar usuário')
  ));

  const eu = auth.sessao();
  const tbody = el('tbody');
  for (const u of S.lista) {
    tbody.append(el('tr', {},
      el('td', {}, el('div', { text: u.nome }),
        u.id === eu.usuario_id ? el('div', { class: 'faint', style: 'font-size:11px', text: 'você' }) : null),
      el('td', {}, u.email),
      el('td', {}, badge(auth.PAPEIS[u.papel].rotulo, u.papel === 'admin' ? 'b-manual' : (u.papel === 'operador' ? 'b-importado' : 'b-excluido'))),
      el('td', {}, u.ativo
        ? el('span', { class: 'pos', text: 'ativo' })
        : el('span', { class: 'faint', text: 'desativado' })),
      el('td', { class: 'faint nowrap', style: 'font-size:11.5px' }, dataBR(u.criado_em)),
      el('td', { class: 'right nowrap' },
        el('button', { class: 'btn btn-sm btn-icon btn-ghost', title: 'Editar', onclick: () => editar(u) }, icone('editar', 14)),
        el('button', {
          class: 'btn btn-sm btn-ghost', style: 'margin-left:6px',
          onclick: () => alternarAtivo(u)
        }, u.ativo ? 'Desativar' : 'Reativar'))
    ));
  }

  S.painel.append(el('div', { class: 'tbl-scroll' },
    ordenavel(el('table', { class: 'tbl' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'Nome'), el('th', {}, 'E-mail'), el('th', {}, 'Perfil'),
        el('th', {}, 'Situação'), el('th', {}, 'Criado em'), el('th', { class: 'right' }, ''))),
      tbody))));

  S.painel.append(el('div', { class: 'grid', style: 'margin-top:20px' },
    ...Object.entries(auth.PAPEIS).map(([k, v]) =>
      el('div', { class: 'card sp-4' },
        el('div', { class: 'card-title', text: v.rotulo }),
        el('div', { class: 'muted', style: 'font-size:12.5px; margin-top:6px', text: v.descricao }),
        el('div', { class: 'faint', style: 'font-size:11px; margin-top:8px', text: `papel: ${k}` })))));
}

async function editar(u) {
  const nome = el('input', { class: 'input', value: u ? u.nome : '', placeholder: 'Nome completo' });
  const email = el('input', { class: 'input', type: 'email', value: u ? u.email : '', placeholder: 'nome@empresa.com.br', disabled: !!u });
  const papel = selectSimples(
    Object.entries(auth.PAPEIS).map(([k, v]) => ({ valor: k, rotulo: `${v.rotulo} — ${v.descricao}` })),
    u ? u.papel : 'operador');

  const corpo = el('div', { class: 'form-grid' },
    campo('Nome *', nome, { span: 'sp-12' }),
    campo('E-mail *', email, { span: 'sp-12', hint: u ? 'O e-mail não pode ser alterado.' : 'Serve como identificação no login.' }),
    campo('Perfil *', papel, { span: 'sp-12' })
  );

  const r = await modal.abrir({
    titulo: u ? 'Editar usuário' : 'Convidar usuário', corpo, largo: true,
    acoes: [{ rotulo: 'Cancelar', classe: 'btn-ghost', valor: null }, { rotulo: 'Salvar', classe: 'btn-primary', valor: 'salvar' }]
  });
  if (r !== 'salvar') return;

  try {
    if (!nome.value.trim()) throw new Error('Informe o nome.');
    if (u) {
      await auth.alterarUsuario(u.id, { nome: nome.value.trim(), papel: papel.value });
      toast.ok('Usuário atualizado.');
    } else {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.value.trim())) throw new Error('E-mail inválido.');
      await auth.convidarUsuario({ nome: nome.value.trim(), email: email.value.trim(), papel: papel.value });
      toast.ok('Usuário criado. Ele entra com a senha mestre e este e-mail.');
    }
    await recarregar();
  } catch (e) {
    toast.erro(e.message);
  }
}

async function alternarAtivo(u) {
  const ok = await modal.confirmar(u.ativo ? 'Desativar usuário' : 'Reativar usuário',
    `${u.ativo ? 'Desativar' : 'Reativar'} <b>${esc(u.nome)}</b>?`,
    { rotuloOk: u.ativo ? 'Desativar' : 'Reativar', perigo: u.ativo });
  if (!ok) return;
  try {
    await auth.alterarUsuario(u.id, { ativo: !u.ativo });
    await recarregar();
    toast.ok(u.ativo ? 'Usuário desativado.' : 'Usuário reativado.');
  } catch (e) {
    toast.erro(e.message);
  }
}

export default { titulo, render };
