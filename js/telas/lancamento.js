/* ============================================================
   telas/lancamento.js — entrada manual

   Duas abas:
     • Lançamento avulso — uma despesa ou receita por vez
     • Receita do mês    — a receita inteira da competência de uma vez,
                           uma linha por forma de recebimento

   A segunda existe porque os extratos bancários entram como fonte só de
   despesa: sem ela, a DRE fecharia com receita zerada.
   ============================================================ */

import db from '../db.js';
import auth from '../auth.js';
import estado from '../estado.js';
import { calcular, STATUS_NA_DRE } from '../dre.js';
import { ensinar } from '../aprendizado.js';
import {
  el, hojeISO, competenciaDe, competenciaLonga, competenciaCurta, competenciaHoje,
  competenciaAnterior, hashDedup, parseValorBR, moeda, uuid, pct
} from '../util.js';
import { campo, marcarErro, selectCategorias, selectSimples, icone } from '../ui/componentes.js';
import modal from '../ui/modal.js';
import toast from '../ui/toast.js';

export const titulo = 'Lançamento manual';

/** Marca os lançamentos criados pela aba "Receita do mês", para poder reeditá-los. */
export const MARCA_RECEITA = 'RECEITA_MENSAL';

export async function render(ctx) {
  const [cats, contas] = await Promise.all([estado.categorias(), estado.contas()]);
  const aba = ctx.params.aba === 'receita' ? 'receita' : 'avulso';

  const raiz = document.createDocumentFragment();
  raiz.append(el('div', { class: 'page-head' },
    el('h1', { class: 'page-title', text: 'Lançamento manual' }),
    el('div', { class: 'page-desc', text: 'Registre uma despesa avulsa ou a receita fechada do mês.' }),
    el('div', { class: 'pills' },
      el('button', {
        class: 'pill', type: 'button', 'aria-pressed': String(aba === 'avulso'),
        onclick: () => ctx.irPara('#/lancamento')
      }, 'Lançamento avulso'),
      el('button', {
        class: 'pill', type: 'button', 'aria-pressed': String(aba === 'receita'),
        onclick: () => ctx.irPara('#/lancamento?aba=receita')
      }, 'Receita do mês'))
  ));

  if (!auth.pode('lancar')) {
    raiz.append(el('div', { class: 'card' },
      el('div', { class: 'vazio', text: 'Seu perfil (leitor) não permite lançar. Fale com um administrador.' })));
    return raiz;
  }

  raiz.append(aba === 'receita'
    ? await formReceita(ctx, cats, contas)
    : await formAvulso(ctx, cats, contas));

  return raiz;
}

/* ============================================================
   Aba 1 — lançamento avulso
   ============================================================ */

async function formAvulso(ctx, cats, contas) {
  const fData = campo('Data *', el('input', { class: 'input', type: 'date', value: hojeISO(), required: true }), { span: 'sp-3', id: 'l-data' });
  const fDescricao = campo('Descrição *', el('input', { class: 'input', type: 'text', placeholder: 'Ex.: Compra de gás — Ultragaz', required: true, autocomplete: 'off' }), { span: 'sp-6', id: 'l-desc' });
  const fValor = campo('Valor *', el('input', { class: 'input num', type: 'text', inputmode: 'decimal', placeholder: '0,00', required: true }), { span: 'sp-3', id: 'l-valor' });

  const fCategoria = campo('Categoria *', selectCategorias(cats, null, { required: true }), { span: 'sp-5', id: 'l-cat' });
  const fConta = campo('Conta *', selectSimples(contas.map(c => ({ valor: c.id, rotulo: c.nome })), contas[0] && contas[0].id), { span: 'sp-4', id: 'l-conta' });
  const fSentido = campo('Sentido', selectSimples([
    { valor: 'DEBITO', rotulo: 'Saída (débito)' },
    { valor: 'CREDITO', rotulo: 'Entrada (crédito)' }
  ], 'DEBITO'), { span: 'sp-3', id: 'l-sent' });

  const fFavorecido = campo('Favorecido', el('input', { class: 'input', type: 'text', placeholder: 'Nome do fornecedor ou beneficiário', autocomplete: 'off' }), { span: 'sp-6', id: 'l-fav' });
  const fDocumento = campo('Nº do documento / CPF / CNPJ', el('input', { class: 'input', type: 'text', autocomplete: 'off' }), { span: 'sp-6', id: 'l-doc' });

  const fObs = campo('Observação', el('textarea', { class: 'textarea', rows: 3, placeholder: 'Anotação livre (opcional)' }), { span: 'sp-12', id: 'l-obs' });

  const chkRepetir = el('input', { type: 'checkbox' });
  const chkRepetirLabel = el('label', { class: 'check' }, chkRepetir,
    el('span', {}, 'Repetir mensalmente'),
    el('span', { class: 'faint', text: '— cria o mesmo lançamento nos próximos meses' }));

  const mesesRepetir = selectSimples(
    [3, 6, 12].map(n => ({ valor: n, rotulo: `por ${n} meses` })), 6, { class: 'select select-sm', disabled: true });
  chkRepetir.addEventListener('change', () => { mesesRepetir.disabled = !chkRepetir.checked; });

  const avisoCompetencia = el('div', { class: 'hint' });

  const btnSalvarNovo = el('button', { class: 'btn btn-primary', type: 'submit' }, icone('check', 16), 'Salvar e novo');
  const btnSalvarSair = el('button', { class: 'btn', type: 'button' }, 'Salvar e ver lançamentos');

  const form = el('form', { class: 'form-grid', novalidate: true },
    fData, fDescricao, fValor,
    fCategoria, fConta, fSentido,
    fFavorecido, fDocumento,
    fObs,
    el('div', { class: 'sp-12', style: 'display:flex; gap:18px; flex-wrap:wrap; align-items:center' },
      chkRepetirLabel, mesesRepetir),
    el('div', { class: 'sp-12' }, avisoCompetencia),
    el('div', { class: 'sp-12 form-actions' }, btnSalvarNovo, btnSalvarSair)
  );

  const dataInput = fData.querySelector('input');
  async function conferirCompetencia() {
    const comp = competenciaDe(dataInput.value);
    const fechada = comp ? await estado.estaFechada(comp) : false;
    avisoCompetencia.textContent = comp
      ? (fechada
        ? `A competência ${competenciaLonga(comp)} está fechada — não é possível lançar.`
        : `Competência: ${competenciaLonga(comp)}`)
      : '';
    avisoCompetencia.style.color = fechada ? 'var(--neg)' : '';
    btnSalvarNovo.disabled = btnSalvarSair.disabled = fechada;
    return !fechada;
  }
  dataInput.addEventListener('change', conferirCompetencia);
  await conferirCompetencia();

  async function salvar(continuar) {
    for (const f of [fData, fDescricao, fValor, fCategoria, fConta]) marcarErro(f, '');

    const data = dataInput.value;
    const descricao = fDescricao.querySelector('input').value.trim();
    const { valor } = parseValorBR(fValor.querySelector('input').value);
    const categoria_id = fCategoria.querySelector('select').value;
    const conta_id = fConta.querySelector('select').value;
    const sentido = fSentido.querySelector('select').value;
    const favorecido = fFavorecido.querySelector('input').value.trim() || null;
    const documento = fDocumento.querySelector('input').value.trim() || null;
    const observacao = fObs.querySelector('textarea').value.trim() || null;

    let erro = false;
    if (!data) { marcarErro(fData, 'Informe a data.'); erro = true; }
    if (!descricao) { marcarErro(fDescricao, 'Informe a descrição.'); erro = true; }
    if (!(valor > 0)) { marcarErro(fValor, 'O valor precisa ser maior que zero.'); erro = true; }
    if (!categoria_id) { marcarErro(fCategoria, 'Escolha a categoria.'); erro = true; }
    if (!conta_id) { marcarErro(fConta, 'Escolha a conta.'); erro = true; }
    if (erro) { toast.erro('Confira os campos destacados.'); return; }
    if (!(await conferirCompetencia())) { toast.erro('Competência fechada.'); return; }

    const repetir = chkRepetir.checked ? Number(mesesRepetir.value) : 0;
    const sessao = auth.sessao();
    const catMap = await estado.catPorId();
    const cat = catMap.get(categoria_id);
    const status = cat && cat.nome === 'A CLASSIFICAR' ? 'A_CLASSIFICAR'
      : (cat && cat.nome === 'EXCLUIR' ? 'EXCLUIDO' : 'CLASSIFICADO');

    const base = {
      empresa_id: db.EMPRESA_LOCAL, descricao, favorecido, documento, valor,
      sentido, categoria_id, conta_id, status,
      origem: repetir ? 'RECORRENCIA' : 'MANUAL',
      arquivo_origem: null, lote_id: null,
      recorrente: repetir > 0, observacao,
      criado_por: sessao ? sessao.usuario_id : null
    };

    const ops = [];
    const datas = [data];
    for (let i = 1; i <= repetir; i++) datas.push(somarMeses(data, i));

    for (const d of datas) {
      const comp = competenciaDe(d);
      if (await estado.estaFechada(comp)) continue;
      ops.push({
        acao: 'inserir',
        dados: {
          ...base, id: uuid(), data: d, competencia: comp,
          hash_dedup: await hashDedup(conta_id, d, valor, descricao, documento)
        }
      });
    }

    const res = await db.emLote('lancamento', ops);
    if (!res.inseridos) {
      toast.erro(res.duplicados ? 'Já existe um lançamento idêntico (mesma conta, data, valor e descrição).' : 'Nada foi gravado.');
      return;
    }
    await db.auditar('lancamento', ops[0].dados.id, 'INSERT', null, ops[0].dados, sessao && sessao.usuario_id);

    // o lançamento manual também é uma decisão humana: a memória aprende com ela
    const aprendeu = await ensinar([{
      linha: { descricao, favorecido, documento, conta_id, observacao },
      categoria_id: categoria_id
    }]);

    estado.invalidar('lancamentos');

    const extra = res.duplicados ? ` (${res.duplicados} ignorado(s) por duplicidade)` : '';
    toast.ok(`${res.inseridos} lançamento(s) gravado(s) — ${moeda(valor)}${extra}.` +
      (aprendeu.regras ? ` Memória atualizada.` : ''));

    if (!continuar) { ctx.irPara('#/lancamentos?mes=' + competenciaDe(data)); return; }

    fDescricao.querySelector('input').value = '';
    fValor.querySelector('input').value = '';
    fFavorecido.querySelector('input').value = '';
    fDocumento.querySelector('input').value = '';
    fObs.querySelector('textarea').value = '';
    chkRepetir.checked = false; mesesRepetir.disabled = true;
    fDescricao.querySelector('input').focus();
  }

  form.addEventListener('submit', ev => { ev.preventDefault(); salvar(true); });
  btnSalvarSair.addEventListener('click', () => salvar(false));

  setTimeout(() => fDescricao.querySelector('input').focus(), 0);
  return el('div', { class: 'card' }, form);
}

/* ============================================================
   Aba 2 — receita do mês
   ============================================================ */

async function formReceita(ctx, cats, contas) {
  const receitas = cats.filter(c => c.tipo === 'RECEITA').sort((a, b) => a.ordem - b.ordem);
  const contaPadrao = contas.find(c => c.layout === 'CAIXA') || contas[0];

  const painel = el('div', {});
  let comp = ctx.params.mes || competenciaHoje();
  let contaId = contaPadrao ? contaPadrao.id : null;

  async function pintar() {
    painel.textContent = '';
    const fechada = await estado.estaFechada(comp);
    const existentes = await lancamentosDeReceita(comp, contaId);
    const porCategoria = new Map(existentes.map(l => [l.categoria_id, l]));
    const outras = await receitaDeOutrasOrigens(comp);

    /* ---- seletores ---- */
    const selComp = selectSimples(mesesDisponiveis().map(c => ({ valor: c, rotulo: competenciaLonga(c) })), comp);
    selComp.addEventListener('change', () => { comp = selComp.value; pintar(); });

    const selConta = selectSimples(contas.map(c => ({ valor: c.id, rotulo: c.nome })), contaId);
    selConta.addEventListener('change', () => { contaId = selConta.value; pintar(); });

    const fData = el('input', { class: 'input', type: 'date', value: ultimoDiaDoMes(comp) });

    /* ---- uma linha por forma de recebimento ---- */
    const campos = new Map();
    const totalEl = el('div', { class: 'kpi-value num', text: moeda(0) });

    const recalcular = () => {
      let soma = 0;
      for (const inp of campos.values()) soma += parseValorBR(inp.value).valor;
      totalEl.textContent = moeda(soma);
      return soma;
    };

    const linhas = el('div', { class: 'form-grid' });
    for (const c of receitas) {
      const atual = porCategoria.get(c.id);
      const inp = el('input', {
        class: 'input num', type: 'text', inputmode: 'decimal', placeholder: '0,00',
        value: atual ? String(atual.valor).replace('.', ',') : '',
        disabled: fechada
      });
      inp.addEventListener('input', recalcular);
      campos.set(c.id, inp);
      linhas.append(campo(c.nome, inp, { span: 'sp-4' }));
    }
    recalcular();

    /* ---- comparação com o mês anterior ---- */
    const anterior = competenciaAnterior(comp);
    const lancs = await estado.lancamentos();
    const dreAnt = calcular(lancs, cats, anterior);
    const receitaAnterior = dreAnt.totais.RECEITA_TOTAL;

    const btnSalvar = el('button', { class: 'btn btn-primary', disabled: fechada },
      icone('check', 16), existentes.length ? 'Atualizar receita do mês' : 'Lançar receita do mês');
    const btnVer = el('button', {
      class: 'btn btn-ghost', type: 'button',
      onclick: () => ctx.irPara('#/dre?mes=' + comp)
    }, 'Ver a DRE do mês');

    btnSalvar.addEventListener('click', async ev => {
      ev.preventDefault();
      await salvar(campos, comp, contaId, fData.value, existentes, receitas, pintar);
    });

    painel.append(el('div', { class: 'grid' },
      el('div', { class: 'card sp-8' },
        el('div', { class: 'form-grid' },
          campo('Competência *', selComp, { span: 'sp-4' }),
          campo('Conta de entrada *', selConta, { span: 'sp-5', hint: 'onde a receita foi recebida' }),
          campo('Data dos lançamentos', fData, { span: 'sp-3', hint: 'padrão: último dia do mês' })),
        el('div', { style: 'margin:18px 0 6px; font-size:13px; font-weight:600; color:var(--text-muted)' },
          'Receita por forma de recebimento'),
        linhas,
        fechada
          ? el('div', { class: 'alerta', style: 'margin-top:16px' }, icone('cadeado', 18),
            el('span', { text: `A competência ${competenciaLonga(comp)} está fechada. Reabra na tela de DRE para editar.` }))
          : null,
        el('div', { class: 'form-actions', style: 'margin-top:20px' }, btnSalvar, btnVer,
          existentes.length && !fechada
            ? el('button', {
              class: 'btn btn-danger', type: 'button',
              onclick: () => apagar(existentes, comp, pintar)
            }, icone('lixo', 16), 'Apagar a receita do mês')
            : null)
      ),

      el('div', { class: 'card sp-4' },
        el('div', { class: 'kpi' },
          el('div', { class: 'kpi-label', text: 'Receita total de ' + competenciaLonga(comp) }),
          totalEl,
          el('div', { class: 'kpi-foot' },
            receitaAnterior
              ? el('span', { text: `${competenciaCurta(anterior)}: ${moeda(receitaAnterior)}` })
              : el('span', { text: 'sem receita no mês anterior' }))),
        existentes.length
          ? el('div', { class: 'alerta ok', style: 'margin-top:18px' },
            icone('check', 18),
            el('span', { html: `Já existe receita lançada neste mês (<b>${existentes.length}</b> linha(s)). Os campos vieram preenchidos: salvar <b>substitui</b>, não soma.` }))
          : el('div', { class: 'alerta info', style: 'margin-top:18px' },
            icone('alerta', 18),
            el('span', { text: 'Deixe em branco as formas que não teve. Só os valores preenchidos viram lançamento.' })),
        outras.total > 0
          ? el('div', { class: 'alerta', style: 'margin-top:12px' },
            icone('alerta', 18),
            el('span', { html: `Este mês já tem <b>${moeda(outras.total)}</b> de receita vinda de outra origem ` +
              `(${outras.origens.join(', ')} — ${outras.linhas} linha(s)). O que você lançar aqui <b>soma</b> a isso na DRE.` }))
          : null,
        el('div', { class: 'faint', style: 'font-size:11.5px; margin-top:14px; line-height:1.6' },
          'Cada valor vira um lançamento de crédito na categoria correspondente. ' +
          'Voltando aqui depois, os campos aparecem preenchidos e você corrige o que precisar.')
      )
    ));
  }

  await pintar();
  return painel;
}

/* ---- gravação ---- */

async function salvar(campos, comp, contaId, data, existentes, receitas, redesenhar) {
  if (!contaId) { toast.erro('Escolha a conta de entrada.'); return; }
  if (await estado.estaFechada(comp)) { toast.erro('Competência fechada.'); return; }

  const dataISO = data && competenciaDe(data) === comp ? data : ultimoDiaDoMes(comp);
  const sessao = auth.sessao();
  const porCategoria = new Map(existentes.map(l => [l.categoria_id, l]));

  const ops = [];
  let total = 0, criados = 0, atualizados = 0, removidos = 0;

  for (const c of receitas) {
    const { valor } = parseValorBR(campos.get(c.id).value);
    const atual = porCategoria.get(c.id);

    if (!(valor > 0)) {
      // campo esvaziado: a linha que existia deixa de existir
      if (atual) { ops.push({ acao: 'remover', id: atual.id }); removidos++; }
      continue;
    }

    total += valor;
    const descricao = `Receita de ${competenciaLonga(comp)} — ${c.nome}`;
    const dados = {
      id: atual ? atual.id : uuid(),
      empresa_id: db.EMPRESA_LOCAL,
      data: dataISO, competencia: comp,
      descricao, favorecido: null, documento: null,
      valor, sentido: 'CREDITO',
      categoria_id: c.id, conta_id: contaId,
      origem: 'MANUAL', status: 'CLASSIFICADO',
      arquivo_origem: null, lote_id: null,
      hash_dedup: await hashDedup(contaId, dataISO, valor, descricao, null),
      recorrente: false,
      observacao: MARCA_RECEITA,
      criado_por: sessao ? sessao.usuario_id : null,
      criado_em: atual ? atual.criado_em : new Date().toISOString()
    };
    ops.push({ acao: atual ? 'atualizar' : 'inserir', dados });
    atual ? atualizados++ : criados++;
  }

  if (!ops.length) { toast.aviso('Nenhum valor preenchido.'); return; }

  const res = await db.emLote('lancamento', ops);
  await db.auditar('lancamento', null, existentes.length ? 'UPDATE' : 'INSERT',
    { competencia: comp, linhas: existentes.length },
    { competencia: comp, total, linhas: criados + atualizados },
    sessao && sessao.usuario_id);

  estado.invalidar('lancamentos');

  if (res.duplicados) {
    toast.aviso(`${res.duplicados} linha(s) não entraram: já existe lançamento idêntico na mesma conta e data.`);
  }
  toast.ok(`Receita de ${competenciaLonga(comp)}: ${moeda(total)} ` +
    `(${criados} criada(s), ${atualizados} atualizada(s)${removidos ? `, ${removidos} removida(s)` : ''}).`);

  await redesenhar();
}

async function apagar(existentes, comp, redesenhar) {
  const total = existentes.reduce((a, b) => a + b.valor, 0);
  const ok = await modal.confirmar('Apagar a receita do mês',
    `Remover as <b>${existentes.length}</b> linha(s) de receita de ${competenciaLonga(comp)}, somando <b>${moeda(total)}</b>?`,
    { rotuloOk: 'Apagar', perigo: true });
  if (!ok) return;
  await db.emLote('lancamento', existentes.map(l => ({ acao: 'remover', id: l.id })));
  estado.invalidar('lancamentos');
  toast.ok('Receita do mês removida.');
  await redesenhar();
}

/** Só os lançamentos criados por esta aba, para poder reeditá-los sem duplicar. */
async function lancamentosDeReceita(comp, contaId) {
  const lancs = await estado.lancamentos();
  const cats = await estado.catPorId();
  return lancs.filter(l =>
    l.competencia === comp &&
    l.observacao === MARCA_RECEITA &&
    (!contaId || l.conta_id === contaId) &&
    (cats.get(l.categoria_id) || {}).tipo === 'RECEITA');
}

/**
 * Receita do mês que NÃO veio desta aba: totais da planilha DRE, créditos
 * importados de extrato, lançamentos avulsos. Serve para avisar que a
 * receita digitada aqui vai somar, não substituir.
 */
async function receitaDeOutrasOrigens(comp) {
  const lancs = await estado.lancamentos();
  const cats = await estado.catPorId();
  const res = { total: 0, linhas: 0, origens: [] };
  const origens = new Set();
  for (const l of lancs) {
    if (l.competencia !== comp || l.observacao === MARCA_RECEITA) continue;
    if ((cats.get(l.categoria_id) || {}).tipo !== 'RECEITA') continue;
    if (!STATUS_NA_DRE.includes(l.status)) continue;
    res.total += l.valor; res.linhas++;
    origens.add(l.observacao === 'IMPORTADO_DA_PLANILHA' ? 'planilha DRE'
      : (l.origem === 'IMPORTADO' ? 'importação de extrato' : 'lançamento avulso'));
  }
  res.origens = [...origens];
  return res;
}

/* ---- utilidades ---- */

function ultimoDiaDoMes(comp) {
  const [a, m] = comp.split('-').map(Number);
  const d = new Date(Date.UTC(a, m, 0));
  return `${a}-${String(m).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function mesesDisponiveis() {
  const [a, m] = competenciaHoje().split('-').map(Number);
  const out = [];
  for (let i = -18; i <= 2; i++) {
    const d = new Date(Date.UTC(a, m - 1 + i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out.reverse();
}

function somarMeses(iso, n) {
  const [a, m, d] = iso.split('-').map(Number);
  const alvo = new Date(Date.UTC(a, m - 1 + n, 1));
  const ultimoDia = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  const dia = Math.min(d, ultimoDia);
  return `${alvo.getUTCFullYear()}-${String(alvo.getUTCMonth() + 1).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

void pct;

export default { titulo, render, MARCA_RECEITA };
