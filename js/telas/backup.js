/* ============================================================
   telas/backup.js — exportar / importar / limpar a base
   ============================================================ */

import db from '../db.js';
import auth from '../auth.js';
import estado from '../estado.js';
import { el, inteiro, baixarArquivo, dataBR } from '../util.js';
import { icone, card, selectSimples } from '../ui/componentes.js';
import modal from '../ui/modal.js';
import toast from '../ui/toast.js';

export const titulo = 'Backup';

export async function render(ctx) {
  const raiz = document.createDocumentFragment();
  raiz.append(el('div', { class: 'page-head' },
    el('h1', { class: 'page-title', text: 'Backup' }),
    el('div', { class: 'page-desc', text: 'No modo local, os dados vivem apenas neste navegador. Exporte com frequência.' })
  ));

  if (!auth.pode('backup')) {
    raiz.append(el('div', { class: 'card' },
      el('div', { class: 'vazio', text: 'Somente administradores podem exportar ou restaurar a base.' })));
    return raiz;
  }

  const contagens = {};
  for (const s of db.STORES) contagens[s] = await db.contar(s);

  const grid = el('div', { class: 'grid' });

  /* ---- exportar ---- */
  grid.append(card({ titulo: 'Exportar tudo', sub: 'JSON com todas as tabelas', span: 'sp-6' },
    el('div', { class: 'stat-row', style: 'margin-bottom:18px' },
      ...['lancamento', 'categoria', 'regra', 'importacao', 'conta']
        .map(s => el('div', { class: 'stat' },
          el('div', { class: 's-l', text: rotuloStore(s) }),
          el('div', { class: 's-v', text: inteiro(contagens[s] || 0) })))),
    el('div', { class: 'form-actions' },
      el('button', { class: 'btn btn-primary', onclick: exportar }, icone('baixar', 16), 'Baixar backup JSON'))
  ));

  /* ---- importar ---- */
  const modo = selectSimples([
    { valor: 'substituir', rotulo: 'Substituir — apaga o que existe e restaura o arquivo' },
    { valor: 'mesclar', rotulo: 'Mesclar — mantém o que existe e sobrescreve por id' }
  ], 'substituir', { class: 'select' });

  const arquivo = el('input', { type: 'file', accept: '.json', class: 'sr-only', id: 'b-arq' });
  const zona = el('label', { class: 'dropzone', for: 'b-arq' },
    el('div', { class: 'big', 'aria-hidden': 'true', text: '⬆' }),
    el('div', { text: 'Escolher arquivo de backup (.json)' }),
    el('div', { class: 'nm' }));
  arquivo.addEventListener('change', () => importar(arquivo.files[0], modo.value, zona));

  grid.append(card({ titulo: 'Restaurar backup', sub: 'a partir de um arquivo JSON exportado por este app', span: 'sp-6' },
    el('div', { class: 'field', style: 'margin-bottom:14px' },
      el('label', { text: 'Modo de restauração' }), modo),
    arquivo, zona
  ));

  /* ---- memória da planilha ---- */
  grid.append(card({ titulo: 'Memória da planilha DRE SABOR', sub: 'regras de classificação (BB, Stone, Caixa e De/Para) e totais mensais extraídos da planilha', span: 'sp-12' },
    el('p', { class: 'muted', style: 'font-size:13px; margin:0 0 14px; line-height:1.6' },
      'Num navegador novo essa memória entra sozinha junto com o seed. Se a base já existia antes, ou se a extração foi ',
      'refeita, use o botão para aplicar de novo: regras repetidas são atualizadas e lançamentos já gravados não duplicam.'),
    el('div', { class: 'form-actions' },
      el('button', { class: 'btn', onclick: () => aplicarPlanilha(ctx) }, icone('backup', 16), 'Aplicar memória e DRE da planilha'))
  ));

  /* ---- limpar ---- */
  grid.append(card({ titulo: 'Zona de risco', sub: 'ações irreversíveis', span: 'sp-12' },
    el('div', { class: 'alerta', style: 'margin-bottom:16px' },
      icone('alerta', 18),
      el('span', { html: '<b>Limpar tudo</b> apaga lançamentos, categorias, contas, regras e importações deste navegador. Exporte antes.' })),
    el('div', { class: 'form-actions' },
      el('button', { class: 'btn btn-danger', onclick: () => limpar(ctx) }, icone('lixo', 16), 'Limpar tudo'),
      el('button', { class: 'btn btn-ghost', onclick: () => recarregarSeed(ctx) }, icone('backup', 16), 'Recarregar seed (categorias, contas e De/Para)'))
  ));

  raiz.append(grid);

  /* ---- últimas importações ---- */
  const imports = (await db.listar('importacao')).sort((a, b) => (b.criado_em || '').localeCompare(a.criado_em || '')).slice(0, 10);
  if (imports.length) {
    const contasMap = await estado.contaPorId();
    const tbody = el('tbody');
    for (const i of imports) {
      tbody.append(el('tr', {},
        el('td', { class: 'nowrap' }, dataBR(i.criado_em)),
        el('td', {}, i.arquivo_nome),
        el('td', {}, (contasMap.get(i.conta_id) || {}).nome || '—'),
        el('td', {}, i.competencia),
        el('td', { class: 'right num' }, inteiro(i.linhas_gravadas)),
        el('td', {}, i.status)));
    }
    raiz.append(el('div', { style: 'margin-top:20px' },
      card({ titulo: 'Histórico de importações' },
        el('div', { class: 'tbl-scroll' },
          el('table', { class: 'tbl' },
            el('thead', {}, el('tr', {},
              el('th', {}, 'Data'), el('th', {}, 'Arquivo'), el('th', {}, 'Conta'),
              el('th', {}, 'Competência'), el('th', { class: 'right' }, 'Gravadas'), el('th', {}, 'Status'))),
            tbody)))));
  }

  return raiz;
}

function rotuloStore(s) {
  return {
    lancamento: 'Lançamentos', categoria: 'Categorias', regra: 'Regras',
    importacao: 'Importações', conta: 'Contas'
  }[s] || s;
}

async function exportar() {
  const dump = await db.exportarTudo();
  const nome = `backup-dre-sabor-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  baixarArquivo(nome, JSON.stringify(dump), 'application/json');
  toast.ok('Backup baixado.');
}

async function importar(file, modo, zona) {
  if (!file) return;
  zona.querySelector('.nm').textContent = file.name;
  try {
    const json = JSON.parse(await file.text());
    if (!json || typeof json !== 'object') throw new Error('Conteúdo inesperado.');

    const resumo = db.STORES
      .filter(s => Array.isArray(json[s]))
      .map(s => `${rotuloStore(s)}: ${json[s].length}`)
      .join(' · ');

    const ok = await modal.confirmar('Restaurar backup',
      `Arquivo de ${json._meta && json._meta.exportado_em ? dataBR(json._meta.exportado_em) : 'origem desconhecida'}.<br><br>${resumo}<br><br>` +
      (modo === 'substituir'
        ? '<b>Modo substituir:</b> os dados atuais deste navegador serão apagados.'
        : '<b>Modo mesclar:</b> registros com o mesmo id serão sobrescritos.'),
      { rotuloOk: 'Restaurar', perigo: modo === 'substituir' });
    if (!ok) return;

    const res = await db.importarTudo(json, modo);
    estado.invalidar();
    toast.ok('Backup restaurado: ' + Object.entries(res).map(([k, v]) => `${rotuloStore(k)} ${v}`).join(', '));
    setTimeout(() => location.reload(), 900);
  } catch (e) {
  console.error('Erro detalhado na restauração:', e);
  const msg = e?.message || e?.error_description || (typeof e === 'string' ? e : 'Falha na conexão com o banco de dados');
  toast.erro('Não consegui restaurar: ' + msg);
}
}

async function limpar(ctx) {
  const ok = await modal.confirmarDigitando('Limpar tudo',
    'Todos os lançamentos, categorias, contas, regras e importações deste navegador serão apagados. <b>Não há como desfazer.</b>',
    'LIMPAR TUDO');
  if (!ok) return;

  const confirma2 = await modal.confirmar('Última confirmação',
    'Você exportou um backup antes? Esta é a última chance de cancelar.',
    { rotuloOk: 'Apagar definitivamente', perigo: true });
  if (!confirma2) return;

  await db.limparTudo(['config', 'perfil_usuario']);
  estado.invalidar();
  toast.ok('Base limpa.');
  setTimeout(() => location.reload(), 700);
  void ctx;
}

async function recarregarSeed(ctx) {
  const ok = await modal.confirmar('Recarregar seed',
    'Recarrega o plano de contas, as contas bancárias e o De/Para inicial a partir de <b>dados-exemplo.json</b>. ' +
    'Registros existentes com o mesmo id são sobrescritos; lançamentos não são tocados.',
    { rotuloOk: 'Recarregar' });
  if (!ok) return;
  try {
    const { carregarSeed } = await import('../seed.js');
    const res = await carregarSeed(true);
    estado.invalidar();
    toast.ok(`Seed recarregado: ${res.categorias} categorias, ${res.contas} contas, ${res.regras} regras.`);
    setTimeout(() => location.reload(), 900);
  } catch (e) {
    toast.erro('Falha ao recarregar o seed: ' + e.message);
  }
  void ctx;
}

async function aplicarPlanilha(ctx) {
  const lancs = await db.listar('lancamento');
  const nosMeses = lancs.filter(l => ['2026-04', '2026-06', '2026-07'].includes(l.competencia)).length;
  const acao = await modal.abrir({
    titulo: 'Aplicar a planilha DRE SABOR',
    corpo:
      'Carrega as <b>regras de classificação</b> e os <b>lançamentos</b> da planilha: as linhas dos extratos de ' +
      'junho e julho já classificadas, os ajustes que fazem a DRE fechar igual à planilha e os totais de abril.<br><br>' +
      (nosMeses
        ? `Esta base já tem <b>${nosMeses}</b> lançamento(s) em abril, junho ou julho de 2026. ` +
          '<b>Substituir</b> apaga esses e deixa os três meses exatamente como a planilha. ' +
          '<b>Mesclar</b> mantém o que existe e só acrescenta o que ainda não está gravado (linhas iguais não duplicam, ' +
          'mas receitas e ajustes podem somar ao que você já lançou).'
        : 'Os três meses ficam exatamente como na planilha.'),
    acoes: [
      { rotulo: 'Cancelar', classe: 'btn-ghost', valor: null },
      ...(nosMeses ? [{ rotulo: 'Mesclar', classe: 'btn', valor: 'mesclar' }] : []),
      { rotulo: nosMeses ? 'Substituir os meses da planilha' : 'Aplicar', classe: nosMeses ? 'btn-danger' : 'btn-primary', valor: 'substituir' }
    ]
  });
  if (!acao) return;
  /* relatório fixo na tela: toast some, isto fica até a pessoa ler */
  const anterior = document.getElementById('relatorio-planilha');
  if (anterior) anterior.remove();
  const titulo = el('div', { class: 'card-title', text: 'Aplicando a planilha…' });
  const lista = el('ul', { style: 'margin:10px 0 0; padding-left:18px; font-size:13px; line-height:1.8' });
  const painel = el('div', { class: 'card', id: 'relatorio-planilha', style: 'margin-top:14px' }, titulo, lista);
  document.querySelector('.grid').after(painel);
  const linha = (txt, classe = '') => lista.append(el('li', { class: classe, text: txt }));

  try {
    const { carregarPlanilha } = await import('../seed.js');
    const r = await carregarPlanilha({ substituirMeses: acao === 'substituir', aoProgredir: linha });
    if (!r.encontrou) {
      titulo.textContent = 'Arquivos da planilha não encontrados no servidor';
      linha('O site precisa servir dados/memoria-planilha.json e dados/dre-planilha.json — confira se a pasta dados/ foi publicada.', 'neg');
      return;
    }
    estado.invalidar();
    titulo.textContent = 'Planilha aplicada';
    linha(`Resumo: ${r.regras} regra(s), ${r.lancamentos} lançamento(s) novo(s)` + (r.removidos ? `, ${r.removidos} anteriores removidos` : '') + '. Recarregando…', 'pos');
    toast.ok('Planilha aplicada.');
    setTimeout(() => location.reload(), 2500);
  } catch (e) {
    console.error('Aplicar planilha:', e);
    titulo.textContent = 'Falha ao aplicar a planilha';
    linha('ERRO: ' + (e.message || String(e)), 'neg');
    linha('Nada do que já estava gravado foi perdido: a gravação vem antes da remoção.', 'faint');
    toast.erro('Falha ao aplicar a planilha: ' + e.message, 12000);
  }
  void ctx;
}

export default { titulo, render };
