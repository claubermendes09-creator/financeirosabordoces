/* ============================================================
   importadores/index.js — orquestração da importação

   Fluxo (seção 6.2 do briefing):
     1. escolher conta + competência + arquivo
     2. conferir arquivo_hash (mesmo arquivo já importado?)
     3. parsing → fila de classificação
     4. aplicar a memória de aprendizado (sugestões)
     5. exibir a fila — NADA é gravado sem confirmação explícita
     6. gravar lançamentos + reforçar as regras
   ============================================================ */

import db from '../db.js';
import { hashDedup, sha256Bytes, competenciaDe, uuid, normalizar } from '../util.js';
import { reforcar, opsDaMemoria, nucleoDescricao } from '../aprendizado.js';
import bb from './bb.js';
import stone from './stone.js';
import caixa from './caixa.js';
import bradesco from './bradesco.js';

export const PARSERS = { BB: bb, STONE: stone, CAIXA: caixa, BRADESCO: bradesco };

export const OPCOES_PADRAO = {
  somenteDespesas: true,
  receitasCartao: 'agrupar',
  gerarTarifas: true,
  agruparTarifas: true,
  agruparPixCredito: false,
  agruparRecebimentos: true,
  incluirNaoOperacionais: false,
  somenteDaCompetencia: true
};

/* ------------------------------------------------------------
   1-2. Leitura do arquivo
   ------------------------------------------------------------ */

export async function lerArquivo(file) {
  const buf = await file.arrayBuffer();
  const arquivo_hash = await sha256Bytes(buf);
  const XLSX = globalThis.XLSX;
  if (!XLSX) throw new Error('SheetJS não carregou. Confira o arquivo vendor/xlsx.full.min.js.');
  const wb = XLSX.read(buf, { type: 'array', raw: true, cellDates: false, codepage: 65001 });
  return { wb, arquivo_hash, arquivo_nome: file.name, tamanho: file.size };
}

export async function importacaoAnterior(arquivo_hash) {
  const iguais = await db.porIndice('importacao', 'arquivo_hash', arquivo_hash);
  return iguais.find(i => i.status !== 'CANCELADA') || null;
}

/**
 * Descobre a competência do arquivo pela data da maioria das linhas.
 * Evita o erro silencioso de importar um extrato de julho com o mês
 * corrente selecionado e ver a fila chegar vazia.
 *
 * @returns {null|{competencia, linhas, total, distribuicao}}
 */
export function detectarCompetencia(wb, conta, opcoes = {}) {
  const parser = PARSERS[conta.layout];
  if (!parser) return null;

  const bruto = parser.parse(wb, { ...OPCOES_PADRAO, ...opcoes });
  const contagem = new Map();
  for (const l of bruto.linhas) {
    const c = competenciaDe(l.data);
    if (c) contagem.set(c, (contagem.get(c) || 0) + 1);
  }
  if (!contagem.size) return null;

  const distribuicao = [...contagem.entries()]
    .map(([competencia, linhas]) => ({ competencia, linhas }))
    .sort((a, b) => b.linhas - a.linhas || b.competencia.localeCompare(a.competencia));

  return {
    competencia: distribuicao[0].competencia,
    linhas: distribuicao[0].linhas,
    total: bruto.linhas.length,
    distribuicao
  };
}

/* ------------------------------------------------------------
   3-4. Fila de classificação
   ------------------------------------------------------------ */

/**
 * @returns {{ fila, resumo, avisos }}
 */
export async function montarFila({ wb, arquivo_nome, conta, competencia, memoria, categorias, opcoes }) {
  const cfg = { ...OPCOES_PADRAO, ...opcoes };
  const parser = PARSERS[conta.layout];
  if (!parser) throw new Error(`Não há importador para o layout "${conta.layout}".`);

  const bruto = parser.parse(wb, cfg);
  const avisos = [...bruto.avisos];

  const catPorNome = new Map(categorias.map(c => [normalizar(c.nome), c]));
  const catALancar = categorias.find(c => c.nome === 'A CLASSIFICAR');

  // uma leitura só serve a dois propósitos: marcar duplicados e montar
  // o histórico de como cada favorecido já foi classificado antes
  const jaGravados = await db.listar('lancamento');
  const historico = montarHistorico(jaGravados, categorias);

  /* Duplicidade por hash, mas sem descartar nada: a linha entra na fila
     marcada, desmarcada, e o operador decide se grava mesmo assim (um
     pagamento igual no mesmo dia acontece). Aceita, ela recebe o hash com
     sufixo "#n" — o mesmo arquivo reimportado continua sendo pego. */
  const gravadosPorBase = new Map();      // hash base -> [lançamentos]
  for (const l of jaGravados) {
    const base = String(l.hash_dedup || '').split('#')[0];
    if (!gravadosPorBase.has(base)) gravadosPorBase.set(base, []);
    gravadosPorBase.get(base).push(l);
  }

  const fila = [];
  const vistosNoLote = new Map();         // hash base -> quantas vezes já apareceu no arquivo
  let foraDaCompetencia = 0;

  const mesesNoLote = new Set();

  for (const l of bruto.linhas) {
    if (cfg.somenteDaCompetencia && competenciaDe(l.data) !== competencia) {
      foraDaCompetencia++;
      continue;
    }

    // Extrato de vários meses (o Bradesco entrega 8 de uma vez): com o filtro
    // desligado, cada lançamento fica na competência da PRÓPRIA data — jogar
    // tudo no mês escolhido colocaria despesa de janeiro dentro de abril.
    const compLinha = cfg.somenteDaCompetencia ? competencia : (competenciaDe(l.data) || competencia);
    mesesNoLote.add(compLinha);

    const hash = await hashDedup(conta.id, l.data, l.valor, l.descricao, l.documento);
    const gravados = gravadosPorBase.get(hash) || [];
    const k = vistosNoLote.get(hash) || 0;
    vistosNoLote.set(hash, k + 1);

    const duplicado = gravados.length > 0 || k > 0;
    let duplicadoDe = null;
    if (gravados.length) {
      const g = gravados[0];
      duplicadoDe = { tipo: 'gravado', data: g.data, arquivo: g.arquivo_origem, categoria_id: g.categoria_id, status: g.status, id: g.id };
    } else if (k > 0) {
      duplicadoDe = { tipo: 'arquivo', ocorrencia: k + 1 };
    }
    // hash que será gravado se o operador aceitar a duplicada
    const hashGravacao = (gravados.length + k) ? `${hash}#${gravados.length + k + 1}` : hash;

    // sugestão: primeiro a regra imposta pelo importador, depois a memória
    let sugestao = null;
    if (l.categoria_forcada) {
      const cat = catPorNome.get(normalizar(l.categoria_forcada));
      if (cat) sugestao = { regra: null, categoria_id: cat.id, tipo_match: 'importador', confianca: 1, nivel: 'ALTA' };
    }
    if (!sugestao) sugestao = memoria.sugerir({ ...l, conta_id: conta.id });

    fila.push({
      ...l,
      uid: uuid(),
      conta_id: conta.id,
      competencia: compLinha,
      hash_dedup: hashGravacao,
      duplicado,
      duplicadoDe,
      sugestao,
      categoria_id: sugestao ? sugestao.categoria_id : (catALancar ? catALancar.id : null),
      // já vêm marcadas só as linhas que a memória soube classificar;
      // as que caem em A CLASSIFICAR exigem marcação explícita do operador
      selecionada: !duplicado && !!sugestao,
      confirmada: false,
      historico: historico.get(chaveDeCoerencia(l)) || null
    });
  }

  const conflitos = detectarConflitos(fila, categorias);
  if (conflitos.grupos.length) {
    avisos.push(
      `${conflitos.linhas} linha(s) contradizem outras do mesmo favorecido neste arquivo ` +
      `(${conflitos.grupos.length} caso(s)). Elas estão marcadas como "Conflito" e não vêm pré-selecionadas.`);
  }

  if (foraDaCompetencia) {
    avisos.push(`${foraDaCompetencia} linhas fora de ${competencia} foram deixadas de fora.`);
  }

  if (mesesNoLote.size > 1) {
    avisos.push(`O arquivo cobre ${mesesNoLote.size} competências (${[...mesesNoLote].sort().join(', ')}) — cada lançamento fica no mês da própria data.`);
  }

  if (bruto.recebimentosIgnorados) {
    avisos.push(`${bruto.recebimentosIgnorados} entradas foram ignoradas — a opção "trazer somente despesas" está ligada.`);
  }

  const resumo = {
    lidas: bruto.totalLidas,
    descartadas: bruto.descartadas,
    recebimentosIgnorados: bruto.recebimentosIgnorados || 0,
    foraDaCompetencia,
    naFila: fila.length,
    duplicadas: fila.filter(l => l.duplicado).length,
    comSugestao: fila.filter(l => l.sugestao).length,
    altaConfianca: fila.filter(l => l.sugestao && l.sugestao.nivel === 'ALTA').length,
    semSugestao: fila.filter(l => !l.sugestao).length,
    conflitos: conflitos.linhas,
    competencias: [...mesesNoLote].sort()
  };

  return { fila, resumo, avisos, conflitos };
}

/* ------------------------------------------------------------
   Histórico: como este favorecido já foi classificado antes
   ------------------------------------------------------------ */

/**
 * Percorre os lançamentos já gravados e resume, por favorecido, em que
 * categorias eles caíram. É o que permite mostrar na fila "antes:
 * 7x ENERGIA ELÉTRICA" — a informação que faz o operador confiar (ou
 * desconfiar) da sugestão sem precisar sair da tela.
 *
 * @returns Map<chave, {total, itens: [{categoria_id, nome, n}]}>
 */
export function montarHistorico(lancamentos, categorias) {
  const nomePorId = new Map((categorias || []).map(c => [c.id, c.nome]));
  const catALancar = (categorias || []).find(c => c.nome === 'A CLASSIFICAR');
  const idALancar = catALancar ? catALancar.id : null;

  const cru = new Map();
  for (const l of lancamentos) {
    if (!l.categoria_id || l.categoria_id === idALancar) continue;
    const chave = chaveDeCoerencia(l);
    if (!chave) continue;
    if (!cru.has(chave)) cru.set(chave, new Map());
    const m = cru.get(chave);
    m.set(l.categoria_id, (m.get(l.categoria_id) || 0) + 1);
  }

  const out = new Map();
  for (const [chave, m] of cru) {
    const itens = [...m.entries()]
      .map(([categoria_id, n]) => ({ categoria_id, nome: nomePorId.get(categoria_id) || '—', n }))
      .sort((a, b) => b.n - a.n);
    out.set(chave, { total: itens.reduce((s, x) => s + x.n, 0), itens });
  }
  return out;
}

/* ------------------------------------------------------------
   Coerência dentro do lote
   ------------------------------------------------------------ */

/** Chave pela qual duas linhas são "o mesmo fornecedor". */
function chaveDeCoerencia(l) {
  const fav = normalizar(l.favorecido);
  if (fav && fav.length >= 4) return fav;
  const nucleo = nucleoDescricao(l.descricao);
  return nucleo && nucleo.length >= 8 ? nucleo : null;
}

/**
 * Procura linhas do mesmo favorecido que receberam categorias diferentes
 * dentro do próprio arquivo. É o que pega o caso real da ENEL: sete linhas
 * classificadas como energia e três com "pro labore" digitado por engano na
 * coluna Classificação do extrato.
 *
 * Nada é corrigido automaticamente — a minoria é desmarcada e sinalizada,
 * e a tela oferece "alinhar com a maioria" em um clique.
 */
export function detectarConflitos(fila, categorias) {
  const nomePorId = new Map((categorias || []).map(c => [c.id, c.nome]));
  const catALancar = (categorias || []).find(c => c.nome === 'A CLASSIFICAR');
  const idALancar = catALancar ? catALancar.id : null;
  const grupos = new Map();

  for (const l of fila) {
    if (l.sintetica || l.categoria_forcada || !l.categoria_id) continue;
    // 'A CLASSIFICAR' é ausência de decisão, não uma opinião divergente:
    // incluí-la faria a única linha classificada do grupo virar "minoria".
    if (l.categoria_id === idALancar) continue;
    const chave = chaveDeCoerencia(l);
    if (!chave) continue;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(l);
  }

  const achados = [];
  let linhasMarcadas = 0;

  for (const [chave, linhas] of grupos) {
    if (linhas.length < 3) continue;          // 2 linhas nunca formam maioria
    const porCategoria = new Map();
    for (const l of linhas) {
      if (!porCategoria.has(l.categoria_id)) porCategoria.set(l.categoria_id, []);
      porCategoria.get(l.categoria_id).push(l);
    }
    if (porCategoria.size < 2) continue;

    const distribuicao = [...porCategoria.entries()]
      .map(([categoria_id, ls]) => ({
        categoria_id,
        nome: nomePorId.get(categoria_id) || '—',
        linhas: ls.length,
        valor: ls.reduce((a, b) => a + b.valor, 0)
      }))
      .sort((a, b) => b.linhas - a.linhas || b.valor - a.valor);

    const maioria = distribuicao[0];
    // Sem maioria folgada não há contradição a apontar — só duas práticas
    // possíveis para o mesmo favorecido (salário e diária, por exemplo).
    if (maioria.linhas < 2 || maioria.linhas === distribuicao[1].linhas) continue;
    const grupo = { chave, rotulo: linhas[0].favorecido || chave, distribuicao, maioria, total: linhas.length };
    achados.push(grupo);

    for (const l of linhas) {
      const minoria = l.categoria_id !== maioria.categoria_id;
      l.conflito = { ...grupo, minoria };
      if (!minoria) continue;
      linhasMarcadas++;
      l.selecionada = false;
      if (l.sugestao) {
        l.sugestao = { ...l.sugestao, nivel: 'BAIXA', confianca: Math.min(l.sugestao.confianca, 0.5) };
      }
    }
  }

  return { grupos: achados, linhas: linhasMarcadas };
}

/* ------------------------------------------------------------
   5-6. Gravação do lote
   ------------------------------------------------------------ */

/**
 * Grava as linhas confirmadas, cria o registro de `importacao` e
 * atualiza a memória de aprendizado numa única passada.
 *
 * @param {Array} linhas    linhas da fila que o humano confirmou
 * @param {object} ctx      { conta, competencia, arquivo_nome, arquivo_hash, memoria, categorias, usuario, resumoParse }
 */
export async function gravarLote(linhas, ctx) {
  const { conta, competencia, arquivo_nome, arquivo_hash, memoria, categorias, usuario } = ctx;
  const catPorId = new Map(categorias.map(c => [c.id, c]));
  const catALancar = categorias.find(c => c.nome === 'A CLASSIFICAR');
  const catExcluir = categorias.find(c => c.nome === 'EXCLUIR');

  const lote_id = uuid();
  const pendentes = new Map();
  const ops = [];

  let aClassificar = 0, excluidas = 0, duplicadasAceitas = 0;

  for (const l of linhas) {
    const catId = l.categoria_id || (catALancar && catALancar.id);
    const cat = catPorId.get(catId);
    const ehALancar = catALancar && catId === catALancar.id;
    const ehExcluir = catExcluir && catId === catExcluir.id;

    if (ehALancar) aClassificar++;
    if (ehExcluir) excluidas++;
    if (l.duplicado) duplicadasAceitas++;

    ops.push({
      acao: 'inserir',
      dados: {
        empresa_id: db.EMPRESA_LOCAL,
        data: l.data,
        competencia: l.competencia || competencia,
        descricao: l.descricao,
        favorecido: l.favorecido || null,
        documento: l.documento || null,
        // guardar o que veio na coluna Classificação do extrato é o que
        // permite, numa correção feita meses depois, penalizar exatamente
        // a regra que errou — e não só criar uma nova por favorecido
        classificacao: l.classificacao || null,
        valor: l.valor,
        sentido: l.sentido,
        categoria_id: catId,
        conta_id: conta.id,
        origem: 'IMPORTACAO',
        status: ehALancar ? 'A_CLASSIFICAR' : (ehExcluir ? 'EXCLUIDO' : 'CLASSIFICADO'),
        arquivo_origem: arquivo_nome,
        lote_id,
        hash_dedup: l.hash_dedup,
        recorrente: false,
        observacao: l.duplicado
          ? [l.observacao, 'DUPLICADA_ACEITA: gravada pelo operador mesmo sendo idêntica a ' +
              (l.duplicadoDe && l.duplicadoDe.tipo === 'arquivo' ? 'outra linha do mesmo arquivo' : 'um lançamento já gravado')].filter(Boolean).join(' — ')
          : (l.observacao || (l.sintetica ? `Gerado na importação a partir de ${l.qtd_origem} linha(s) do arquivo.` : null)),
        criado_por: usuario ? usuario.id : null
      }
    });

    // Só aprende quando houve uma decisão de classificação de verdade.
    // Linhas com categoria imposta pelo importador não ensinam nada — a escolha
    // não foi humana. Os agrupamentos sem categoria imposta, sim: eles carregam
    // o tipo do lançamento como chave, e o operador decide uma vez por tipo.
    if (!ehALancar && cat && !l.categoria_forcada && !l.rateio) {
      reforcar(l, catId, memoria, pendentes);
    }
  }

  const res = await db.emLote('lancamento', ops);

  const opsRegras = opsDaMemoria(pendentes);
  if (opsRegras.length) await db.emLote('regra', opsRegras);

  const importacao = await db.inserir('importacao', {
    empresa_id: db.EMPRESA_LOCAL,
    conta_id: conta.id,
    competencia,
    arquivo_nome,
    arquivo_hash,
    linhas_lidas: ctx.resumoParse ? ctx.resumoParse.lidas : linhas.length,
    linhas_gravadas: res.inseridos,
    linhas_duplicadas: res.duplicados,
    linhas_a_classificar: aClassificar,
    status: aClassificar ? 'EM_REVISAO' : 'CONCLUIDA',
    importado_por: usuario ? usuario.id : null,
    id: lote_id
  });

  await db.auditar('importacao', lote_id, 'INSERT', null,
    { arquivo_nome, competencia, gravadas: res.inseridos }, usuario ? usuario.id : null);

  return {
    lote_id,
    importacao,
    gravadas: res.inseridos,
    duplicadas: res.duplicados,
    aClassificar,
    excluidas,
    duplicadasAceitas,
    regrasAtualizadas: opsRegras.length,
    erros: res.erros
  };
}

/* ------------------------------------------------------------
   Desfazer lote (24h)
   ------------------------------------------------------------ */

export const JANELA_DESFAZER_MS = 24 * 60 * 60 * 1000;

export function podeDesfazer(importacao) {
  if (!importacao || importacao.status === 'CANCELADA') return false;
  return (Date.now() - new Date(importacao.criado_em).getTime()) < JANELA_DESFAZER_MS;
}

export async function desfazerLote(lote_id, usuario) {
  const alvos = await db.porIndice('lancamento', 'lote_id', lote_id);
  await db.emLote('lancamento', alvos.map(l => ({ acao: 'remover', id: l.id })));
  const imp = await db.obter('importacao', lote_id);
  if (imp) await db.atualizar('importacao', { ...imp, status: 'CANCELADA' });
  await db.auditar('importacao', lote_id, 'DELETE', { lancamentos: alvos.length }, null, usuario ? usuario.id : null);
  return alvos.length;
}

export default {
  PARSERS, OPCOES_PADRAO, lerArquivo, importacaoAnterior, detectarCompetencia,
  montarFila, gravarLote, desfazerLote, podeDesfazer, JANELA_DESFAZER_MS, detectarConflitos, montarHistorico
};
