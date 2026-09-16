/* ============================================================
   telas/importar.js — importação de extratos com validação humana

   Regra de ouro: NADA é gravado sem uma ação explícita do operador.
   Três caminhos de confirmação:
     • Confirmar selecionados  (checkbox por linha)
     • Confirmar tudo          (só habilita sem nenhuma linha A CLASSIFICAR)
     • Revisar uma a uma       (↑/↓ navega, Enter confirma, E exclui, Esc sai)
   ============================================================ */

import db from '../db.js';
import auth from '../auth.js';
import estado from '../estado.js';
import imp from '../importadores/index.js';
import { carregarMemoria, chaveDeAgrupamento, ROTULO_NIVEL, CLASSE_NIVEL } from '../aprendizado.js';
import {
  el, moeda, dataBR, competenciaHoje, competenciaLonga, competenciaCurta,
  inteiro, truncar, esc, normalizar, debounce, uuid, round2
} from '../util.js';
import { campo, selectCategorias, selectSimples, icone, badgeDuplicado, badgeConflito, card } from '../ui/componentes.js';
import modal from '../ui/modal.js';
import { pedirRateio } from '../ui/dividir.js';
import toast from '../ui/toast.js';
import { ordenavel } from '../ui/tabela.js';

export const titulo = 'Importar extrato';

/* Estado local da tela (vive enquanto a tela estiver montada) */
let S = null;

export async function render(ctx) {
  const [cats, contas, opcoesSalvas] = await Promise.all([
    estado.categorias(), estado.contas(), db.getConfig('import_opcoes', null)
  ]);
  S = {
    ctx, cats, contas,
    conta: contas[0] || null,
    competencia: competenciaHoje(),
    arquivo: null, wb: null, arquivo_hash: null, arquivo_nome: null,
    fila: [], resumo: null, avisos: [], deteccao: null,
    memoria: null,
    opcoes: { ...imp.OPCOES_PADRAO, ...(opcoesSalvas || {}) },
    etapa: 1,
    filtroFila: 'todas',
    ordem: null,
    filtroCol: { data: '', descricao: '', favorecido: '', valor: '', categoria: '', confianca: '' },
    focoFiltro: null,
    focoRevisao: -1
  };

  const raiz = document.createDocumentFragment();
  raiz.append(el('div', { class: 'page-head' },
    el('h1', { class: 'page-title', text: 'Importar extrato' }),
    el('div', { class: 'page-desc', text: 'O sistema sugere a categoria a partir do histórico. Você confirma — sempre.' })
  ));

  if (!auth.pode('importar')) {
    raiz.append(el('div', { class: 'card' },
      el('div', { class: 'vazio', text: 'Seu perfil (leitor) não permite importar arquivos.' })));
    return raiz;
  }

  S.painel = el('div', {});
  raiz.append(S.painel);
  await pintar();
  return raiz;
}

async function pintar() {
  // a fila é redesenhada a cada decisão: guarda onde a pessoa estava (a
  // página e a própria tabela rolam separado) e devolve depois de repintar
  const conteudo = S.painel.closest('.content');
  const tabela = S.painel.querySelector('.tbl-scroll');
  const rolagem = { pagina: conteudo ? conteudo.scrollTop : 0, tabela: tabela ? tabela.scrollTop : 0, lado: tabela ? tabela.scrollLeft : 0 };

  S.painel.textContent = '';
  S.painel.append(passos());
  if (S.etapa === 1) S.painel.append(await telaEscolha());
  else S.painel.append(await telaFila());

  if (S.etapa === 2 && (rolagem.pagina || rolagem.tabela)) {
    requestAnimationFrame(() => {
      if (conteudo) conteudo.scrollTop = rolagem.pagina;
      const nova = S.painel.querySelector('.tbl-scroll');
      if (nova) { nova.scrollTop = rolagem.tabela; nova.scrollLeft = rolagem.lado; }
    });
  }
}

function passos() {
  const nomes = ['Arquivo e competência', 'Conferir e confirmar', 'Resumo'];
  const wrap = el('div', { class: 'steps' });
  nomes.forEach((n, i) => {
    const num = i + 1;
    wrap.append(el('div', { class: 'step ' + (S.etapa === num ? 'on' : (S.etapa > num ? 'done' : '')) },
      el('span', { class: 'n', text: S.etapa > num ? '✓' : String(num) }),
      el('span', { text: n })));
    if (i < nomes.length - 1) wrap.append(el('span', { class: 'step-sep' }));
  });
  return wrap;
}

/* ============================================================
   Etapa 1 — conta, competência, arquivo, opções
   ============================================================ */

async function telaEscolha() {
  const fConta = campo('Conta / origem *',
    selectSimples(S.contas.map(c => ({ valor: c.id, rotulo: `${c.nome}  ·  layout ${c.layout}` })), S.conta && S.conta.id),
    { span: 'sp-5', id: 'i-conta' });
  fConta.querySelector('select').addEventListener('change', ev => {
    S.conta = S.contas.find(c => c.id === ev.target.value);
    pintar();
  });

  const comps = mesesDisponiveis();
  const fComp = campo('Competência *',
    selectSimples(comps.map(c => ({ valor: c, rotulo: competenciaLonga(c) })), S.competencia),
    {
      span: 'sp-4', id: 'i-comp',
      hint: !S.deteccao
        ? 'o mês é detectado quando você escolhe o arquivo'
        : S.deteccao.distribuicao.length > 1
          ? 'o arquivo cobre ' + S.deteccao.distribuicao.length + ' meses — desmarque "apenas linhas dentro da competência" para trazer todos de uma vez'
          : 'detectada no arquivo: ' + competenciaLonga(S.deteccao.competencia) +
            ' (' + S.deteccao.linhas + ' de ' + S.deteccao.total + ' linhas)'
    });
  fComp.querySelector('select').addEventListener('change', ev => { S.competencia = ev.target.value; });

  /* ---- opções por layout ---- */
  const opcoes = el('div', { class: 'sp-12', style: 'display:flex; gap:20px; flex-wrap:wrap; align-items:center' });

  opcoes.append(check('Trazer somente despesas (ignorar as entradas)', 'somenteDespesas', true));
  opcoes.append(check('Trazer apenas linhas dentro da competência', 'somenteDaCompetencia', true));

  if (S.conta && S.conta.layout === 'STONE' && !S.opcoes.somenteDespesas) {
    const sel = selectSimples([
      { valor: 'agrupar', rotulo: 'agrupar num total por dia' },
      { valor: 'ignorar', rotulo: 'ignorar (a receita vem do relatório de caixa)' },
      { valor: 'detalhar', rotulo: 'trazer uma a uma (lento)' }
    ], S.opcoes.receitasCartao, { class: 'select select-sm' });
    sel.addEventListener('change', ev => { S.opcoes.receitasCartao = ev.target.value; });
    opcoes.append(el('label', { class: 'check' },
      el('span', { class: 'muted', text: 'Vendas em cartão (Transação / Recebível):' }), sel));
    opcoes.append(check('Gerar lançamentos de TAXAS DE CARTÃO a partir das tarifas', 'gerarTarifas'));
    opcoes.append(check('Somar as tarifas num lançamento por dia', 'agruparTarifas'));
    opcoes.append(check('Somar também os Pix recebidos sem classificação por dia', 'agruparPixCredito'));
  }

  if (S.conta && S.conta.layout === 'BB' && !S.opcoes.somenteDespesas) {
    opcoes.append(check('Somar por dia os recebimentos de venda (Stone, Pix, boleto, TED, fornecedor)', 'agruparRecebimentos'));
  }

  if (S.conta && S.conta.layout === 'STONE' && S.opcoes.somenteDespesas) {
    opcoes.append(check('Gerar lançamentos de TAXAS DE CARTÃO a partir das tarifas', 'gerarTarifas'));
    opcoes.append(check('Somar as tarifas num lançamento por dia', 'agruparTarifas'));
  }

  if (S.conta && S.conta.layout === 'CAIXA') {
    opcoes.append(check('Incluir também [DESPESAS NAO OPERACIONAIS]', 'incluirNaoOperacionais'));
  }

  /* ---- dropzone ---- */
  const input = el('input', { type: 'file', accept: '.xlsx,.xls', class: 'sr-only', id: 'i-arquivo' });
  const zona = el('label', { class: 'dropzone', for: 'i-arquivo' },
    el('div', { class: 'big', 'aria-hidden': 'true', text: '⬆' }),
    el('div', { text: 'Clique para escolher o arquivo, ou arraste aqui' }),
    el('div', { class: 'faint', style: 'margin-top:6px', text: dicaArquivo() }),
    el('div', { class: 'nm', text: S.arquivo_nome || '' })
  );

  ['dragenter', 'dragover'].forEach(e => zona.addEventListener(e, ev => { ev.preventDefault(); zona.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(e => zona.addEventListener(e, ev => { ev.preventDefault(); zona.classList.remove('drag'); }));
  zona.addEventListener('drop', ev => { if (ev.dataTransfer.files[0]) escolher(ev.dataTransfer.files[0], zona, btn); });
  input.addEventListener('change', ev => { if (ev.target.files[0]) escolher(ev.target.files[0], zona, btn); });

  const btn = el('button', { class: 'btn btn-primary', disabled: !S.wb, onclick: analisar }, icone('importar', 16), 'Analisar arquivo');

  const historico = await cardHistorico();

  return el('div', { class: 'grid' },
    card({ span: 'sp-8' },
      el('div', { class: 'form-grid' }, fConta, fComp, opcoes),
      el('div', { style: 'margin-top:18px' }, input, zona),
      el('div', { class: 'form-actions', style: 'margin-top:18px' }, btn)
    ),
    historico
  );
}

function check(rotulo, chave, repintar = false) {
  const c = el('input', { type: 'checkbox', checked: !!S.opcoes[chave] });
  c.addEventListener('change', () => {
    S.opcoes[chave] = c.checked;
    salvarOpcoes();
    if (repintar) pintar();
  });
  return el('label', { class: 'check' }, c, el('span', { text: rotulo }));
}

/** A preferência de importação vale para as próximas vezes. */
function salvarOpcoes() {
  db.setConfig('import_opcoes', { ...S.opcoes }).catch(() => { /* preferência é conveniência */ });
}

function dicaArquivo() {
  if (!S.conta) return '';
  return {
    BB: 'Extrato BB - MMAAAA.xlsx  ·  aba "Extrato Conta"',
    STONE: 'Extrato ... stone - MMAAAA.xlsx  ·  aba "Extrato"',
    BRADESCO: 'extrato Bradesco ....XLS  ·  Bradesco Net Empresa',
    CAIXA: 'relátório de despesas de caixa MMAA.xls'
  }[S.conta.layout] || '';
}

function mesesDisponiveis() {
  const hoje = competenciaHoje();
  const [a, m] = hoje.split('-').map(Number);
  const out = [];
  for (let i = -18; i <= 2; i++) {
    const d = new Date(Date.UTC(a, m - 1 + i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out.reverse();
}

async function escolher(file, zona, btn) {
  try {
    zona.querySelector('.nm').textContent = 'Lendo ' + file.name + '…';
    const r = await imp.lerArquivo(file);
    Object.assign(S, r);
    S.arquivo = file;
    zona.querySelector('.nm').textContent = `${file.name} — ${(file.size / 1024).toFixed(0)} KB`;
    btn.disabled = false;

    const anterior = await imp.importacaoAnterior(r.arquivo_hash);
    if (anterior) {
      const ok = await modal.confirmar('Arquivo já importado',
        `Este arquivo idêntico já foi importado em ${dataBR(anterior.criado_em)} para ${competenciaLonga(anterior.competencia)} (${anterior.linhas_gravadas} lançamentos). Deseja processar de novo? As linhas já gravadas aparecem como duplicadas, desmarcadas — você decide se grava alguma de novo.`,
        { rotuloOk: 'Processar mesmo assim' });
      if (!ok) { btn.disabled = true; S.wb = null; zona.querySelector('.nm').textContent = ''; return; }
    }

    // A competência vem do próprio arquivo: importar um extrato de julho com
    // o mês corrente selecionado deixaria a fila vazia sem explicação.
    S.deteccao = imp.detectarCompetencia(r.wb, S.conta, S.opcoes);
    if (S.deteccao && S.deteccao.competencia !== S.competencia) {
      const antes = S.competencia;
      S.competencia = S.deteccao.competencia;
      toast.info(`Competência ajustada de ${competenciaLonga(antes)} para ${competenciaLonga(S.competencia)} — é o mês de ${S.deteccao.linhas} das ${S.deteccao.total} linhas do arquivo.`, 6000);
    }
    await pintar();
  } catch (e) {
    toast.erro('Não consegui ler o arquivo: ' + e.message);
    btn.disabled = true;
  }
}

async function analisar() {
  if (!S.wb || !S.conta) return;
  const t = toast.info('Processando o arquivo…', 60000);
  try {
    S.memoria = await carregarMemoria();
    const { fila, resumo, avisos } = await imp.montarFila({
      wb: S.wb, arquivo_nome: S.arquivo_nome, conta: S.conta,
      competencia: S.competencia, memoria: S.memoria, categorias: S.cats, opcoes: S.opcoes
    });
    S.fila = fila; S.resumo = resumo; S.avisos = avisos;
    S.etapa = 2;
    t.remove();
    if (!fila.length) toast.aviso('Nenhuma linha aproveitável foi encontrada neste arquivo.');
    await pintar();
  } catch (e) {
    t.remove();
    toast.erro('Falha ao processar: ' + e.message);
    console.error(e);
  }
}

async function cardHistorico() {
  const importacoes = (await db.listar('importacao')).sort((a, b) => (b.criado_em || '').localeCompare(a.criado_em || '')).slice(0, 6);
  const contasMap = await estado.contaPorId();
  const corpo = el('div', {});
  if (!importacoes.length) {
    corpo.append(el('div', { class: 'vazio', text: 'Nenhuma importação ainda.' }));
  }
  for (const i of importacoes) {
    const podeDesfazer = imp.podeDesfazer(i);
    corpo.append(el('div', {
      style: 'display:flex; gap:10px; align-items:center; padding:9px 0; border-bottom:1px solid var(--border)'
    },
      el('div', { style: 'flex:1; min-width:0' },
        el('div', { style: 'font-size:12.5px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap', text: i.arquivo_nome }),
        el('div', { class: 'faint', style: 'font-size:11.5px' },
          `${(contasMap.get(i.conta_id) || {}).nome || '—'} · ${competenciaCurta(i.competencia)} · ${i.linhas_gravadas} gravadas` +
          (i.status === 'CANCELADA' ? ' · desfeita' : ''))),
      podeDesfazer && i.status !== 'CANCELADA'
        ? el('button', {
          class: 'btn btn-sm btn-danger', title: 'Desfazer este lote',
          onclick: () => desfazer(i)
        }, icone('desfazer', 14), 'Desfazer')
        : null
    ));
  }
  return card({ titulo: 'Importações recentes', sub: 'lotes podem ser desfeitos por 24h', span: 'sp-4' }, corpo);
}

async function desfazer(importacao) {
  const ok = await modal.confirmar('Desfazer importação',
    `Isso apaga os ${importacao.linhas_gravadas} lançamentos gravados a partir de "${esc(importacao.arquivo_nome)}". A memória de aprendizado não é revertida.`,
    { rotuloOk: 'Desfazer lote', perigo: true });
  if (!ok) return;
  const n = await imp.desfazerLote(importacao.id, auth.sessao());
  estado.invalidar('lancamentos');
  toast.ok(`${n} lançamento(s) removido(s).`);
  await pintar();
}

/* ============================================================
   Etapa 2 — fila de classificação
   ============================================================ */

async function telaFila() {
  const wrap = el('div', {});
  const r = S.resumo;

  /* ---- resumo do parsing ---- */
  /* Os números da fila são recalculados a cada repintura: classificar uma
     linha tem de mexer nos cards na hora, senão o painel mente. */
  const vivas = S.fila.filter(l => !l.duplicado);
  const classificadas = vivas.filter(l => !ehALancar(l)).length;
  const decididas = vivas.filter(l => l.decididaAqui || l.propagada).length;
  wrap.append(card({ span: '' },
    el('div', { class: 'stat-row' },
      stat('Lidas do arquivo', inteiro(r.lidas)),
      stat('Na fila', inteiro(r.naFila)),
      stat('Classificadas', inteiro(classificadas)),
      stat('Alta confiança', inteiro(vivas.filter(l => nivel(l) === 'ALTA').length)),
      stat('Decididas por você', inteiro(decididas)),
      stat('A classificar', inteiro(vivas.length - classificadas)),
      stat('Decisões a tomar', inteiro(decisoesPendentes())),
      stat('Conflitos', inteiro(r.conflitos || 0)),
      stat('Entradas ignoradas', inteiro(r.recebimentosIgnorados || 0)),
      stat('Duplicadas', inteiro(r.duplicadas)),
      stat('Descartadas', inteiro(r.descartadas))
    ),
    S.avisos.length
      ? el('ul', { class: 'muted', style: 'margin:14px 0 0; padding-left:18px; font-size:12.5px; line-height:1.7' },
        ...S.avisos.map(a => el('li', { text: a })))
      : null
  ));

  if (!S.fila.length) {
    /* Fila vazia quase sempre significa competência errada — diga isso,
       e ofereça o mês certo em um clique. */
    const outros = (S.deteccao ? S.deteccao.distribuicao : [])
      .filter(d => d.competencia !== S.competencia);

    if (r.foraDaCompetencia) {
      wrap.append(el('div', { class: 'alerta', style: 'margin-top:18px' },
        icone('alerta', 18),
        el('span', {
          html: `Nenhuma linha caiu em <b>${competenciaLonga(S.competencia)}</b>. ` +
            `As ${r.foraDaCompetencia} linhas do arquivo são de outro mês — ` +
            `escolha a competência certa abaixo.`
        })));
    } else {
      wrap.append(el('div', { class: 'vazio', text: 'Nenhuma linha aproveitável foi encontrada neste arquivo.' }));
    }

    wrap.append(el('div', { class: 'form-actions', style: 'margin-top:18px' },
      ...outros.slice(0, 4).map(d => el('button', {
        class: 'btn btn-primary',
        onclick: () => { S.competencia = d.competencia; analisar(); }
      }, `Analisar em ${competenciaLonga(d.competencia)} (${d.linhas} linhas)`)),
      el('button', { class: 'btn btn-ghost', onclick: voltar }, 'Escolher outro arquivo')
    ));
    return wrap;
  }

  /* ---- barra de ações ---- */
  const barra = el('div', { class: 'toolbar', style: 'margin-top:18px' });

  const filtros = [
    { valor: 'todas', rotulo: `Todas (${S.fila.length})` },
    { valor: 'alta', rotulo: `Alta confiança (${S.fila.filter(l => nivel(l) === 'ALTA').length})` },
    { valor: 'pendentes', rotulo: `A classificar (${S.fila.filter(ehALancar).length})` },
    { valor: 'conflitos', rotulo: `Conflitos (${divergentes().length})` },
    { valor: 'duplicadas', rotulo: `Duplicadas (${S.fila.filter(l => l.duplicado).length})` }
  ].filter(f => f.valor !== 'conflitos' || divergentes().length);
  for (const f of filtros) {
    barra.append(el('button', {
      class: 'pill', type: 'button', 'aria-pressed': String(S.filtroFila === f.valor),
      onclick: () => { S.filtroFila = f.valor; pintar(); }
    }, f.rotulo));
  }

  const btnMarcarAlta = el('button', { class: 'btn btn-sm', onclick: marcarAltaConfianca },
    icone('check', 14), 'Marcar todos de alta confiança');
  const btnRevisar = el('button', { class: 'btn btn-sm', onclick: revisarUmaAUma },
    icone('lista', 14), 'Revisar uma a uma');
  const nDiv = divergentes().length;
  const btnAlinhar = nDiv
    ? el('button', { class: 'btn btn-sm btn-danger', onclick: alinharComMaioria },
      icone('alerta', 14), `Alinhar ${nDiv} divergente(s) com a maioria`)
    : null;

  barra.append(el('span', { style: 'flex:1' }), btnAlinhar, btnMarcarAlta, btnRevisar);
  wrap.append(barra);

  /* ---- tabela da fila ---- */
  const visiveis = ordenarFila(S.fila.filter(filtroAtivo));

  /* ---- aplicar uma categoria a tudo que passou pelos filtros ----
     Filtrou "diaria" na descrição? Escolhe DIÁRIAS aqui e resolve as 40
     linhas de uma vez. Só aparece quando há um filtro restringindo. */
  const filtrando = S.filtroFila !== 'todas' || temFiltroDeColuna();
  const alvosLote = visiveis.filter(l => !l.duplicado);
  if (filtrando && alvosLote.length) {
    const selLote = selectCategorias(S.cats, S.categoriaLote || '', { class: 'select select-sm', placeholder: 'Escolha a categoria…' });
    selLote.addEventListener('change', () => { S.categoriaLote = selLote.value; });
    wrap.append(el('div', { class: 'toolbar lote-filtro' },
      icone('filtro', 14),
      el('span', { class: 'muted', style: 'font-size:12.5px' },
        `${alvosLote.length} linha(s) passam pelos filtros — aplicar a todas:`),
      selLote,
      el('button', {
        class: 'btn btn-sm btn-primary',
        onclick: () => aplicarAosFiltrados(alvosLote, selLote.value)
      }, icone('check', 14), `Aplicar às ${alvosLote.length}`)
    ));
  }
  const tbody = el('tbody');

  const nConflitos = visiveis.filter(l => l.conflito && l.conflito.minoria).length;
  const chkTodos = el('input', {
    type: 'checkbox',
    title: nConflitos
      ? `Selecionar os visíveis — as ${nConflitos} linha(s) em conflito ficam de fora`
      : 'Selecionar/limpar os visíveis'
  });
  chkTodos.addEventListener('change', () => {
    for (const l of visiveis) {
      // marcar tudo não pode atropelar o aviso: linha em conflito exige
      // decisão individual, senão o alerta não serve para nada
      const emConflito = l.conflito && l.conflito.minoria;
      l.selecionada = chkTodos.checked && !l.duplicado && !emConflito;
    }
    if (chkTodos.checked && nConflitos) {
      toast.aviso(`${nConflitos} linha(s) em conflito ficaram de fora. Use o filtro "Conflitos" para decidir uma a uma.`);
    }
    pintar();
  });

  for (const l of visiveis) tbody.append(linhaDaFila(l));

  // só as categorias que aparecem na fila, para o filtro não virar uma
  // lista de 58 itens onde apenas uma dúzia tem linha
  const catsNaFila = [...new Set(S.fila.map(l => l.categoria_id))]
    .map(id => S.cats.find(c => c.id === id))
    .filter(Boolean)
    .sort((a, b) => a.ordem - b.ordem);

  const tabela = el('table', { class: 'tbl', style: 'min-width:1180px' },
    el('thead', {},
      el('tr', {},
        el('th', { style: 'width:34px' }, chkTodos),
        el('th', {}, 'Data'),
        el('th', {}, 'Descrição'),
        el('th', {}, 'Favorecido'),
        el('th', { class: 'right' }, 'Valor'),
        el('th', {}, 'Categoria'),
        el('th', {}, 'Confiança'),
        el('th', { class: 'right', title: 'Dividir em várias categorias' }, '⁝')
      ),
      el('tr', { class: 'linha-filtro' },
        el('th', {},
          temFiltroDeColuna()
            ? el('button', {
              class: 'btn btn-icon btn-ghost', title: 'Limpar filtros das colunas',
              style: 'width:26px; height:26px', onclick: limparFiltrosDeColuna
            }, icone('x', 13))
            : null),
        celulaFiltro('data', { placeholder: 'dd/mm' }),
        celulaFiltro('descricao', { placeholder: 'contém…' }),
        celulaFiltro('favorecido', { placeholder: 'nome ou CNPJ' }),
        celulaFiltro('valor', { placeholder: 'a partir de', inputmode: 'decimal' }),
        celulaFiltroSelect('categoria', [
          { valor: '', rotulo: 'todas' },
          ...catsNaFila.map(c => ({ valor: c.id, rotulo: c.nome }))
        ]),
        celulaFiltroSelect('confianca', [
          { valor: '', rotulo: 'todas' },
          { valor: 'ALTA', rotulo: 'Alta' },
          { valor: 'MEDIA', rotulo: 'Média' },
          { valor: 'BAIXA', rotulo: 'Baixa' },
          { valor: 'SEM', rotulo: 'Sem sugestão' }
        ]),
        el('th', {})
      )
    ),
    tbody
  );
  ordenavel(tabela, { atual: S.ordem, aoOrdenar: (indice, direcao) => { S.ordem = { indice, direcao }; pintar(); } });
  wrap.append(el('div', { class: 'tbl-scroll', style: 'margin-top:4px' }, tabela));

  if (temFiltroDeColuna()) {
    wrap.append(el('div', { class: 'faint', style: 'font-size:12px; margin-top:8px' },
      visiveis.length + ' de ' + S.fila.length + ' linhas passam pelos filtros de coluna. ',
      el('a', {
        style: 'color:var(--accent-soft); cursor:pointer; text-decoration:underline',
        onclick: limparFiltrosDeColuna
      }, 'limpar')));
  }

  // a tabela é redesenhada a cada tecla: devolve o cursor onde ele estava
  if (S.focoFiltro) {
    const chave = S.focoFiltro;
    setTimeout(() => {
      const alvo = document.querySelector('[data-filtro="' + chave + '"]');
      if (!alvo) return;
      alvo.focus();
      if (alvo.setSelectionRange) {
        const n = alvo.value.length;
        try { alvo.setSelectionRange(n, n); } catch { /* type=search recusa em alguns navegadores */ }
      }
    }, 0);
  }

  /* ---- rodapé de confirmação ---- */
  const nSelecionadas = S.fila.filter(l => l.selecionada).length;
  const nPendentes = S.fila.filter(ehALancar).length;

  const btnSelecionados = el('button', {
    class: 'btn btn-primary', disabled: !nSelecionadas,
    onclick: () => confirmar(S.fila.filter(l => l.selecionada))
  }, icone('check', 16), `Confirmar selecionados (${nSelecionadas})`);

  const btnTudo = el('button', {
    class: 'btn', disabled: nPendentes > 0,
    title: nPendentes ? `Ainda há ${nPendentes} linha(s) em A CLASSIFICAR` : '',
    onclick: () => confirmar(S.fila)
  }, `Confirmar tudo (${S.fila.length})`);

  wrap.append(el('div', { class: 'form-actions', style: 'margin-top:18px' },
    btnSelecionados, btnTudo,
    el('button', { class: 'btn btn-ghost', onclick: voltar }, 'Cancelar'),
    nPendentes
      ? el('span', { class: 'faint', style: 'font-size:12.5px' },
        `"Confirmar tudo" libera quando não houver linhas em A CLASSIFICAR. Você também pode gravá-las como pendentes usando "Confirmar selecionados".`)
      : null
  ));

  return wrap;
}

/**
 * Pendentes distintas: é o número de decisões que o operador realmente
 * precisa tomar, já descontadas as repetições.
 */
function decisoesPendentes() {
  const chaves = new Set();
  let soltas = 0;
  for (const l of S.fila) {
    if (l.duplicado || !ehALancar(l)) continue;
    const k = chaveDeAgrupamento(l);
    if (k) chaves.add(k); else soltas++;
  }
  return chaves.size + soltas;
}

function stat(rotulo, valor) {
  return el('div', { class: 'stat' },
    el('div', { class: 's-l', text: rotulo }),
    el('div', { class: 's-v', text: valor }));
}

function nivel(l) {
  return l.sugestao ? l.sugestao.nivel : null;
}

/** Linhas que contradizem a maioria do próprio favorecido. */
function divergentes() {
  return S.fila.filter(l => l.conflito && l.conflito.minoria);
}

function resumoDoConflito(c) {
  return c.distribuicao.map(d => `${d.linhas}x ${d.nome}`).join(' · ');
}

async function alinharComMaioria() {
  const alvos = divergentes();
  if (!alvos.length) return;

  /* Um grupo por favorecido, cada um com sua própria decisão: nem toda
     divergência é erro. "PREFEITURA MUNICIPAL" recebe IPTU, ISS e outros
     tributos legitimamente — alinhar tudo em bloco criaria o erro oposto. */
  const grupos = new Map();
  for (const l of alvos) {
    if (!grupos.has(l.conflito.chave)) grupos.set(l.conflito.chave, { conflito: l.conflito, linhas: [] });
    grupos.get(l.conflito.chave).linhas.push(l);
  }

  const corpo = el('div', {});
  corpo.append(el('p', { class: 'muted', style: 'margin-bottom:14px' },
    'Marque os favorecidos em que a minoria é engano. Nada é gravado agora — as linhas apenas passam a valer a categoria predominante e ficam marcadas para você confirmar.'));

  const caixas = [];
  for (const [chave, g] of grupos) {
    const chk = el('input', { type: 'checkbox', checked: true });
    caixas.push({ chk, g });
    corpo.append(el('label', {
      class: 'check',
      style: 'display:flex; align-items:flex-start; gap:10px; padding:10px 0; border-bottom:1px solid var(--border)'
    },
      chk,
      el('span', {},
        el('div', { style: 'font-weight:600' }, g.conflito.rotulo),
        el('div', { class: 'faint', style: 'font-size:12px; margin-top:2px' },
          `${resumoDoConflito(g.conflito)}`),
        el('div', { style: 'font-size:12px; margin-top:3px' },
          `${g.linhas.length} linha(s) passam para `,
          el('b', { text: g.conflito.maioria.nome })))
    ));
    void chave;
  }

  const r = await modal.abrir({
    titulo: 'Alinhar com a maioria', corpo, largo: true,
    acoes: [
      { rotulo: 'Cancelar', classe: 'btn-ghost', valor: null },
      { rotulo: 'Alinhar selecionados', classe: 'btn-primary', valor: 'alinhar' }
    ]
  });
  if (r !== 'alinhar') return;

  let n = 0;
  for (const { chk, g } of caixas) {
    if (!chk.checked) continue;
    for (const l of g.linhas) {
      l.categoria_id = g.conflito.maioria.categoria_id;
      l.selecionada = !l.duplicado;
      l.conflito = { ...l.conflito, minoria: false, alinhado: true };
      n++;
    }
  }
  if (!n) { toast.aviso('Nenhum grupo marcado.'); return; }
  toast.ok(`${n} linha(s) alinhada(s) com a maioria.`);
  pintar();
}

/* ordem escolhida no cabeçalho (data, descrição, favorecido, valor, categoria, confiança) */
function ordenarFila(lista) {
  const o = S.ordem;
  if (!o) return lista;
  const nomeCat = id => (S.cats.find(c => c.id === id) || {}).nome || '';
  const chaves = {
    1: l => l.data, 2: l => normalizar(l.descricao), 3: l => normalizar(l.favorecido || ''),
    4: l => l.valor, 5: l => nomeCat(l.categoria_id), 6: l => l.sugestao ? l.sugestao.confianca : -1
  };
  const chave = chaves[o.indice];
  if (!chave) return lista;
  const sinal = o.direcao === 'desc' ? -1 : 1;
  return [...lista].sort((a, b) => {
    const va = chave(a), vb = chave(b);
    const r = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb), 'pt-BR', { numeric: true });
    return sinal * r;
  });
}

function ehALancar(l) {
  const cat = S.cats.find(c => c.id === l.categoria_id);
  return !cat || cat.nome === 'A CLASSIFICAR';
}

function filtroAtivo(l) {
  return filtroDePilula(l) && filtroDeColuna(l);
}

function filtroDePilula(l) {
  if (S.filtroFila === 'alta') return nivel(l) === 'ALTA';
  if (S.filtroFila === 'pendentes') return ehALancar(l);
  if (S.filtroFila === 'conflitos') return !!(l.conflito && l.conflito.minoria);
  if (S.filtroFila === 'duplicadas') return l.duplicado;
  return true;
}

/** Filtros digitados na linha logo abaixo do cabeçalho da tabela. */
function filtroDeColuna(l) {
  const f = S.filtroCol;

  if (f.data && !dataBR(l.data).includes(f.data.trim())) return false;

  if (f.descricao && !normalizar(l.descricao).includes(normalizar(f.descricao))) return false;

  if (f.favorecido) {
    const alvo = normalizar([l.favorecido, l.documento].filter(Boolean).join(' '));
    if (!alvo.includes(normalizar(f.favorecido))) return false;
  }

  if (f.valor) {
    const min = parseFloat(String(f.valor).replace(/\./g, '').replace(',', '.'));
    if (isFinite(min) && l.valor < min) return false;
  }

  if (f.categoria && l.categoria_id !== f.categoria) return false;

  if (f.confianca) {
    if (f.confianca === 'SEM') { if (l.sugestao) return false; }
    else if (nivel(l) !== f.confianca) return false;
  }

  return true;
}

function limparFiltrosDeColuna() {
  S.filtroCol = { data: '', descricao: '', favorecido: '', valor: '', categoria: '', confianca: '' };
  S.focoFiltro = null;
  pintar();
}

function temFiltroDeColuna() {
  return Object.values(S.filtroCol).some(Boolean);
}

/** Célula de filtro de texto. O foco é devolvido depois da repintura. */
function celulaFiltro(chave, atributos = {}) {
  const inp = el('input', {
    class: 'input filtro-col', type: 'search', autocomplete: 'off',
    value: S.filtroCol[chave], ...atributos
  });
  inp.dataset.filtro = chave;
  inp.addEventListener('input', debounce(() => {
    S.filtroCol[chave] = inp.value;
    S.focoFiltro = chave;
    pintar();
  }, 250));
  return el('th', { class: 'th-filtro' }, inp);
}

function celulaFiltroSelect(chave, opcoes) {
  const sel = selectSimples(opcoes, S.filtroCol[chave], { class: 'select select-sm filtro-col' });
  sel.dataset.filtro = chave;
  sel.addEventListener('change', () => {
    S.filtroCol[chave] = sel.value;
    S.focoFiltro = null;
    pintar();
  });
  return el('th', { class: 'th-filtro' }, sel);
}

function linhaDaFila(l) {
  // duplicada não vem travada: desmarcada por padrão, mas o operador pode
  // marcar para gravar mesmo assim e ela volta a contar na DRE
  const chk = el('input', {
    type: 'checkbox', checked: l.selecionada,
    title: l.duplicado ? 'Duplicada — marque para gravar mesmo assim' : ''
  });
  chk.addEventListener('change', () => { l.selecionada = chk.checked; atualizarRodape(); });

  const sel = selectCategorias(S.cats, l.categoria_id, { class: 'select select-sm', placeholder: false });
  sel.addEventListener('change', () => {
    l.categoria_id = sel.value;
    l.trocouSugestao = !l.sugestao || l.sugestao.categoria_id !== sel.value;
    l.decididaAqui = true;
    const n = propagarParaIguais(l);
    if (n) toast.ok(`${n} linha(s) idêntica(s) receberam a mesma categoria.`);
    pintar();
  });

  const conf = l.sugestao
    ? el('span', { class: CLASSE_NIVEL[l.sugestao.nivel], style: 'font-size:12px; font-weight:600' },
      `${ROTULO_NIVEL[l.sugestao.nivel]} · ${(l.sugestao.confianca * 100).toFixed(0)}%`)
    : el('span', { class: 'faint', style: 'font-size:12px', text: 'Sem sugestão' });

  const origem = l.sugestao
    ? el('div', { class: 'faint', style: 'font-size:11px', text: rotuloMatch(l.sugestao) })
    : null;

  const tr = el('tr', {
    class: (l.selecionada ? 'sel' : '') + (l.duplicado && !l.selecionada ? ' zerada' : '') +
      ((l.conflito && l.conflito.minoria) ? ' conflito' : ''),
    dataset: { uid: l.uid }
  },
    el('td', {}, chk),
    el('td', { class: 'nowrap' }, dataBR(l.data)),
    el('td', {}, el('div', { title: l.descricao, text: truncar(l.descricao, 52) }),
      l.duplicado ? explicacaoDuplicada(l) : null,
      (!l.duplicado && l.sintetica) ? el('span', { class: 'faint', style: 'font-size:11px', text: `${l.qtd_origem} linha(s) somadas` }) : null,
      (() => {
        const n = ehALancar(l) ? iguaisPendentes(l) : 0;
        return n
          ? el('div', { class: 'faint', style: 'font-size:11px; margin-top:2px' },
            `+${n} linha(s) igual(is) — classificar aqui resolve todas`)
          : null;
      })(),
      l.propagada
        ? el('div', { class: 'pos', style: 'font-size:11px; margin-top:2px', text: 'aplicada em lote' })
        : null,
      l.rateio
        ? el('div', { class: 'faint', style: 'font-size:11px; margin-top:2px' },
          `parte ${l.rateio.parte}/${l.rateio.total} de ${moeda(l.rateio.valorOriginal)}`)
        : null,
      (l.conflito && l.conflito.minoria)
        ? el('div', { style: 'margin-top:3px' },
          badgeConflito(`Outras linhas de "${l.conflito.rotulo}" neste arquivo: ${resumoDoConflito(l.conflito)}`),
          el('span', { class: 'faint', style: 'font-size:11px; margin-left:7px', text: `maioria: ${l.conflito.maioria.linhas}x ${l.conflito.maioria.nome}` }))
        : null),
    el('td', { class: 'col-fav' },
      el('div', { text: l.favorecido || '—' }),
      l.documento ? el('div', { class: 'faint', style: 'font-size:11px', text: l.documento }) : null),
    el('td', { class: 'right money' }, (l.sentido === 'DEBITO' ? '−' : '') + moeda(l.valor)),
    el('td', {}, sel, historicoDaLinha(l)),
    el('td', {}, conf, origem),
    el('td', { class: 'right' },
      l.duplicado ? null : el('button', {
        class: 'btn btn-sm btn-icon btn-ghost', title: 'Dividir este lançamento em várias categorias',
        onclick: () => dividirNaFila(l)
      }, icone('filtro', 14)))
  );
  return tr;
}

/** Badge "Duplicada" + de onde vem a duplicidade, para o operador decidir. */
function explicacaoDuplicada(l) {
  const d = l.duplicadoDe || {};
  let detalhe;
  if (d.tipo === 'gravado') {
    const cat = S.cats.find(c => c.id === d.categoria_id);
    detalhe = `já gravada em ${dataBR(d.data)}` +
      (cat ? ` como ${cat.nome}` : '') +
      (d.status === 'EXCLUIDO' ? ' (excluída)' : '') +
      (d.arquivo ? ` · ${d.arquivo}` : '');
  } else if (d.tipo === 'arquivo') {
    detalhe = `${d.ocorrencia}ª linha idêntica neste arquivo`;
  } else {
    detalhe = 'idêntica a outra linha';
  }
  return el('div', { style: 'margin-top:3px' },
    badgeDuplicado(),
    el('span', { class: 'faint', style: 'font-size:11px; margin-left:7px', text: detalhe }),
    el('span', {
      class: l.selecionada ? 'pos' : 'faint',
      style: 'font-size:11px; margin-left:7px',
      text: l.selecionada ? '· será gravada mesmo assim' : '· marque para gravar mesmo assim'
    }));
}

/**
 * Resumo de uma linha: em que categorias este mesmo favorecido já caiu
 * nas importações anteriores. Curto de propósito — é para bater o olho.
 */
function historicoDaLinha(l) {
  if (!l.historico || !l.historico.itens.length) return null;

  const itens = l.historico.itens;
  const atual = l.categoria_id;
  const principal = itens[0];
  const combina = principal.categoria_id === atual;

  const resumo = itens.slice(0, 3).map(x => `${x.n}x ${x.nome}`).join(' · ');
  const sobra = itens.length > 3 ? ` +${itens.length - 3}` : '';

  return el('div', {
    class: 'hist' + (combina ? ' ok' : ''),
    title: `Histórico de "${l.favorecido || l.descricao}": ` +
      itens.map(x => `${x.n}x ${x.nome}`).join(' · ')
  }, `antes: ${resumo}${sobra}`);
}

/**
 * Divide uma linha da fila em várias categorias antes de gravar.
 * O pagamento é um só no extrato, mas na DRE precisa entrar repartido —
 * dos R$ 15.000 da fatura do cartão, R$ 13.000 podem ser pro-labore.
 */
async function dividirNaFila(l) {
  const partes = await pedirRateio({
    valor: l.valor, descricao: `${dataBR(l.data)} · ${truncar(l.descricao, 70)}`,
    categoria_id: ehALancar(l) ? null : l.categoria_id, categorias: S.cats
  });
  if (!partes) return;

  const i = S.fila.indexOf(l);
  const novas = [];
  for (let k = 0; k < partes.length; k++) {
    const p = partes[k];
    const descricao = `${l.descricao} [${k + 1}/${partes.length}]`;
    novas.push({
      ...l,
      uid: uuid(),
      descricao,
      valor: round2(p.valor),
      categoria_id: p.categoria_id,
      // hash da linha original + sufixo da parte: as partes não colidem entre
      // si, e o extrato reimportado reconhece a linha inteira como já gravada
      hash_dedup: `${l.hash_dedup.split('#')[0]}#r${k + 1}`,
      // o rateio é decisão caso a caso — não vira regra, senão o mês seguinte
      // herdaria uma proporção que talvez não se repita
      sugestao: null,
      conflito: null,
      historico: null,
      propagada: null,
      decididaAqui: true,
      rateio: { de: l.uid, parte: k + 1, total: partes.length, valorOriginal: l.valor },
      selecionada: true,
      observacao: `Parte ${k + 1}/${partes.length} de ${moeda(l.valor)}`
    });
  }

  S.fila.splice(i, 1, ...novas);
  toast.ok(`Dividido em ${partes.length} partes: ${partes.map(p => moeda(p.valor)).join(' + ')}.`);
  pintar();
}

/**
 * Classificar uma linha resolve as idênticas que ainda estão pendentes.
 * "Idêntica" = mesma Classificação escrita no extrato e mesmo favorecido
 * (ver chaveDeAgrupamento). Nunca sobrescreve uma linha que já tem sugestão
 * da memória nem uma que o operador já decidiu — só as que estão em branco.
 */
function propagarParaIguais(origem) {
  const chave = chaveDeAgrupamento(origem);
  if (!chave) return 0;

  let n = 0;
  for (const l of S.fila) {
    if (l.uid === origem.uid || l.duplicado || l.rateio) continue;
    if (l.decididaAqui) continue;
    if (chaveDeAgrupamento(l) !== chave) continue;

    // pendente ainda em branco, ou linha que já veio deste mesmo grupo:
    // corrigir a origem tem de corrigir o bloco todo, senão o grupo racha
    if (!ehALancar(l) && !l.propagada) continue;

    l.categoria_id = origem.categoria_id;
    l.selecionada = true;
    l.propagada = { de: origem.uid };
    n++;
  }
  return n;
}

/** Quantas outras linhas pendentes são idênticas a esta. */
function iguaisPendentes(l) {
  const chave = chaveDeAgrupamento(l);
  if (!chave) return 0;
  return S.fila.filter(x =>
    x.uid !== l.uid && !x.duplicado && ehALancar(x) && chaveDeAgrupamento(x) === chave).length;
}

function rotuloMatch(sug) {
  return {
    classificacao_exata: 'coluna Classificação',
    documento_cnpj: 'CPF/CNPJ do favorecido',
    favorecido: 'nome do favorecido',
    contem_descricao: 'trecho da descrição',
    nome_categoria: 'nome da categoria',
    importador: 'regra do importador'
  }[sug.tipo_match] || sug.tipo_match;
}

function atualizarRodape() {
  pintar();
}

function marcarAltaConfianca() {
  let n = 0;
  for (const l of S.fila) {
    if (!l.duplicado && nivel(l) === 'ALTA') { l.selecionada = true; n++; }
  }
  toast.ok(`${n} linha(s) de alta confiança marcada(s).`);
  pintar();
}

/**
 * Categoria escolhida para todas as linhas que passaram pelos filtros.
 * Cada linha conta como decidida pelo operador (entra no aprendizado), e
 * as idênticas fora do filtro vêm junto pela propagação normal.
 */
function aplicarAosFiltrados(alvos, categoriaId) {
  if (!categoriaId) { toast.aviso('Escolha a categoria primeiro.'); return; }
  const cat = S.cats.find(c => c.id === categoriaId);
  let n = 0, extra = 0;
  for (const l of alvos) {
    if (l.duplicado || l.rateio) continue;
    l.categoria_id = categoriaId;
    l.trocouSugestao = !l.sugestao || l.sugestao.categoria_id !== categoriaId;
    l.decididaAqui = true;
    l.selecionada = true;
    l.propagada = null;
    n++;
    extra += propagarParaIguais(l);
  }
  toast.ok(`${n} linha(s) marcadas como ${cat ? cat.nome : 'categoria'}` +
    (extra ? ` — mais ${extra} idêntica(s) fora do filtro.` : '.'));
  pintar();
}

function voltar() {
  S.etapa = 1;
  S.fila = []; S.resumo = null;
  pintar();
}

/* ------------------------------------------------------------
   Revisão uma a uma (teclado)
   ------------------------------------------------------------ */

function revisarUmaAUma() {
  const lista = S.fila.filter(filtroAtivo);
  if (!lista.length) { toast.aviso('Nada para revisar neste filtro.'); return; }

  let i = 0;
  const catExcluir = S.cats.find(c => c.nome === 'EXCLUIR');

  const corpoLinha = el('div', {});
  const sel = selectCategorias(S.cats, lista[0].categoria_id);
  const contador = el('div', { class: 'faint', style: 'font-size:12px; margin-bottom:10px' });

  const corpo = el('div', {}, contador, corpoLinha,
    el('div', { style: 'margin-top:14px' }, el('label', { style: 'font-size:12px; font-weight:600; color:var(--text-muted)' }, 'Categoria'), sel),
    el('div', { class: 'faint', style: 'margin-top:14px; font-size:12px; line-height:1.9' },
      el('div', {}, el('kbd', {}, '↑'), ' ', el('kbd', {}, '↓'), ' navegar  ·  ',
        el('kbd', {}, 'Enter'), ' confirmar e avançar  ·  ',
        el('kbd', {}, 'E'), ' marcar EXCLUIR  ·  ',
        el('kbd', {}, 'Esc'), ' sair'))
  );

  function mostrar() {
    const l = lista[i];
    contador.textContent = `Linha ${i + 1} de ${lista.length}${l.selecionada ? ' · marcada' : ''}`;
    corpoLinha.textContent = '';
    corpoLinha.append(
      el('div', { style: 'font-size:16px; font-weight:600' }, truncar(l.descricao, 80)),
      el('div', { class: 'muted', style: 'margin-top:4px' },
        `${dataBR(l.data)} · ${l.favorecido || 'sem favorecido'} · ${(l.sentido === 'DEBITO' ? '−' : '')}${moeda(l.valor)}`),
      l.sugestao
        ? el('div', { class: CLASSE_NIVEL[l.sugestao.nivel], style: 'margin-top:8px; font-size:12.5px; font-weight:600' },
          `Sugestão ${ROTULO_NIVEL[l.sugestao.nivel]} · ${rotuloMatch(l.sugestao)}`)
        : el('div', { class: 'faint', style: 'margin-top:8px; font-size:12.5px', text: 'Sem sugestão da memória' })
    );
    sel.value = l.categoria_id || '';
  }

  sel.addEventListener('change', () => { lista[i].categoria_id = sel.value; });

  modal.abrir({
    titulo: 'Revisar uma a uma',
    corpo, largo: true,
    acoes: [{ rotulo: 'Fechar', classe: 'btn-ghost', valor: null }],
    aoMontar: (painel, fechar) => {
      mostrar();
      painel.addEventListener('keydown', ev => {
        if (ev.key === 'ArrowDown') { ev.preventDefault(); i = Math.min(i + 1, lista.length - 1); mostrar(); }
        else if (ev.key === 'ArrowUp') { ev.preventDefault(); i = Math.max(i - 1, 0); mostrar(); }
        else if (ev.key === 'Enter') {
          ev.preventDefault();
          lista[i].categoria_id = sel.value;
          lista[i].selecionada = !lista[i].duplicado;
          lista[i].decididaAqui = true;
        propagarParaIguais(lista[i]);
        if (i < lista.length - 1) { i++; mostrar(); } else { fechar(null); }
        } else if ((ev.key === 'e' || ev.key === 'E') && ev.target !== sel) {
          ev.preventDefault();
          if (catExcluir) { lista[i].categoria_id = catExcluir.id; lista[i].selecionada = true; sel.value = catExcluir.id; }
          if (i < lista.length - 1) { i++; mostrar(); }
        }
      });
      setTimeout(() => sel.focus(), 0);
    }
  }).then(() => pintar());
}

/* ------------------------------------------------------------
   Gravação
   ------------------------------------------------------------ */

async function confirmar(linhas) {
  // duplicada entra só quando o operador a marcou de propósito
  const gravaveis = linhas.filter(l => !l.duplicado || l.selecionada);
  const puladas = linhas.length - gravaveis.length;
  const aceitas = gravaveis.filter(l => l.duplicado).length;
  if (!gravaveis.length) { toast.aviso('Todas as linhas escolhidas são duplicadas e nenhuma foi marcada para gravar.'); return; }

  const pendentes = gravaveis.filter(ehALancar).length;
  const ok = await modal.confirmar('Confirmar gravação',
    `Serão gravados <b>${gravaveis.length}</b> lançamento(s) em ${competenciaLonga(S.competencia)}, na conta <b>${esc(S.conta.nome)}</b>.` +
    (pendentes ? `<br><br>${pendentes} entram como <b>A CLASSIFICAR</b> e continuam pendentes na tela de Lançamentos.` : '') +
    (aceitas ? `<br><br><b>${aceitas}</b> duplicada(s) marcada(s) por você serão gravadas e passam a contar na DRE.` : '') +
    (puladas ? `<br><br>${puladas} linha(s) duplicada(s) não marcadas serão ignoradas.` : '') +
    `<br><br>A memória de aprendizado será atualizada com as suas escolhas.`,
    { rotuloOk: 'Gravar' });
  if (!ok) return;

  const t = toast.info('Gravando…', 60000);
  try {
    const res = await imp.gravarLote(gravaveis, {
      conta: S.conta, competencia: S.competencia,
      arquivo_nome: S.arquivo_nome, arquivo_hash: S.arquivo_hash,
      memoria: S.memoria, categorias: S.cats,
      usuario: auth.sessao() ? { id: auth.sessao().usuario_id } : null,
      resumoParse: S.resumo
    });
    t.remove();
    estado.invalidar('lancamentos');

    // tira da fila o que foi gravado
    const gravados = new Set(gravaveis.map(l => l.uid));
    S.fila = S.fila.filter(l => !gravados.has(l.uid));

    // o que o operador acabou de ensinar já vale para o resto da fila
    const aprendidas = await reaplicarMemoria();
    if (aprendidas) toast.info(`${aprendidas} linha(s) da fila ganharam sugestão com o que você acabou de classificar.`);

    await mostrarResumo(res, puladas);
  } catch (e) {
    t.remove();
    toast.erro('Falha ao gravar: ' + e.message);
    console.error(e);
  }
}

/**
 * Recarrega a memória e reaplica as sugestões às linhas que continuam
 * pendentes — o que o operador ensinou numa confirmação vale para o resto
 * do mesmo arquivo, sem precisar reimportar.
 * @returns {number} quantas linhas ganharam sugestão
 */
async function reaplicarMemoria() {
  const pendentes = S.fila.filter(l => !l.sugestao && ehALancar(l));
  if (!pendentes.length) return 0;

  S.memoria = await carregarMemoria();
  let n = 0;
  for (const l of pendentes) {
    const sug = S.memoria.sugerir({ ...l, conta_id: S.conta.id });
    if (!sug) continue;
    l.sugestao = sug;
    l.categoria_id = sug.categoria_id;
    l.selecionada = !l.duplicado;
    n++;
  }
  if (n) {
    S.resumo = {
      ...S.resumo,
      comSugestao: S.resumo.comSugestao + n,
      altaConfianca: S.fila.filter(l => l.sugestao && l.sugestao.nivel === 'ALTA').length,
      semSugestao: S.fila.filter(l => !l.sugestao).length,
      naFila: S.fila.length
    };
  }
  return n;
}

async function mostrarResumo(res, puladas) {
  S.etapa = 3;
  S.painel.textContent = '';
  S.painel.append(passos());

  S.painel.append(card({ titulo: 'Importação concluída', sub: `${S.arquivo_nome} · ${competenciaLonga(S.competencia)}` },
    el('div', { class: 'stat-row' },
      stat('Lidas', inteiro(S.resumo.lidas)),
      stat('Gravadas', inteiro(res.gravadas)),
      stat('Duplicadas ignoradas', inteiro(res.duplicadas + puladas)),
      stat('Duplicadas aceitas', inteiro(res.duplicadasAceitas || 0)),
      stat('A classificar', inteiro(res.aClassificar)),
      stat('Excluídas', inteiro(res.excluidas)),
      stat('Regras atualizadas', inteiro(res.regrasAtualizadas))
    ),
    res.erros && res.erros.length
      ? el('div', { class: 'alerta', style: 'margin-top:16px' }, `${res.erros.length} linha(s) falharam: ${res.erros[0]}`)
      : null,
    el('div', { class: 'form-actions', style: 'margin-top:20px' },
      el('button', { class: 'btn btn-primary', onclick: () => S.ctx.irPara('#/dre?mes=' + S.competencia) }, icone('dre', 16), 'Ver a DRE do mês'),
      res.aClassificar
        ? el('button', { class: 'btn', onclick: () => S.ctx.irPara('#/lancamentos?status=A_CLASSIFICAR') }, `Classificar ${res.aClassificar} pendente(s)`)
        : null,
      S.fila.length
        ? el('button', { class: 'btn', onclick: () => { S.etapa = 2; pintar(); } }, `Voltar à fila (${S.fila.length} restantes)`)
        : null,
      el('button', { class: 'btn btn-ghost', onclick: () => { S.wb = null; S.arquivo_nome = null; voltar(); } }, 'Importar outro arquivo')
    )
  ));

  toast.ok(`${res.gravadas} lançamento(s) gravado(s).`);
}

export default { titulo, render };
