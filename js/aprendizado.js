/* ============================================================
   aprendizado.js — memória de classificação (o "De/Para" vivo)

   Prioridade de casamento (seção 6.2 do briefing):
     1. classificacao_exata   (coluna preenchida pelo operador no extrato)
     2. documento_cnpj        (CPF/CNPJ do favorecido)
     3. favorecido            (nome exato do favorecido)
     4. contem_descricao      (trecho contido na descrição)

   Nada é gravado sem validação humana — este módulo só SUGERE.
   O reforço/penalização das regras acontece no ato da confirmação.
   ============================================================ */

import db from './db.js';
import { normalizar, soDigitos, uuid } from './util.js';

export const TIPOS_MATCH = ['classificacao_exata', 'documento_cnpj', 'favorecido', 'contem_descricao'];

/** Peso da evidência: uma classificação escrita à mão vale mais que um "contém". */
const PESO = {
  classificacao_exata: 1.00,
  documento_cnpj:      0.98,
  favorecido:          0.92,
  contem_descricao:    0.85
};

export const LIMIAR_ALTA  = 0.9;
export const LIMIAR_MEDIA = 0.6;
export const USOS_MIN_ALTA = 3;   // regras aprendidas só viram "Alta" após 3 usos

/* ------------------------------------------------------------
   Índice em memória
   ------------------------------------------------------------ */

export class Memoria {
  constructor(regras, categorias = []) {
    this.regras = regras;
    this.porTipo = new Map(TIPOS_MATCH.map(t => [t, new Map()]));
    this.contem = [];
    for (const r of regras) this._indexar(r);
    // "contém" testa do padrão mais longo para o mais curto (mais específico primeiro)
    this.contem.sort((a, b) => b.padrao_norm.length - a.padrao_norm.length);

    // O operador às vezes escreve na coluna Classificação o nome exato de uma
    // categoria ("EXAMES", "USO E CONSUMO"). Sem isto a linha ia para
    // A CLASSIFICAR só porque ninguém tinha criado a regra ainda.
    this.categoriaPorNome = new Map();
    for (const c of categorias) {
      if (c.ativa === false || c.tipo === 'CONTROLE') continue;
      this.categoriaPorNome.set(normalizar(c.nome), c);
    }
  }

  _indexar(r) {
    if (r.tipo_match === 'contem_descricao') { this.contem.push(r); return; }
    const m = this.porTipo.get(r.tipo_match);
    if (!m) return;
    const chave = r.padrao_norm;
    if (!m.has(chave)) m.set(chave, []);
    m.get(chave).push(r);
  }

  /** Regras candidatas respeitando o escopo de conta (null = todas). */
  _filtrarConta(lista, contaId) {
    if (!lista || !lista.length) return null;
    const especifica = lista.find(r => r.conta_id === contaId);
    return especifica || lista.find(r => !r.conta_id) || null;
  }

  /**
   * @param {object} linha { classificacao, documento, favorecido, descricao, conta_id }
   * @returns {null|{regra, categoria_id, tipo_match, confianca, nivel}}
   */
  /**
   * Reúne TODAS as evidências que casam com a linha, não só a de maior
   * prioridade. Quando duas apontam para categorias diferentes, a sugestão
   * sai marcada como conflito, com a confiança rebaixada — a linha deixa de
   * ser pré-marcada e vai para a mão do operador.
   */
  sugerir(linha) {
    const contaId = linha.conta_id || null;
    const candidatos = [];

    const exatos = [
      ['classificacao_exata', normalizar(linha.classificacao)],
      ['documento_cnpj',      soDigitos(linha.documento)],
      ['favorecido',          normalizar(linha.favorecido)]
    ];

    for (const [tipo, chave] of exatos) {
      if (!chave) continue;
      const r = this._filtrarConta(this.porTipo.get(tipo).get(chave), contaId);
      if (r) candidatos.push(this._candidato(r, tipo));
    }

    // Nenhuma regra para o texto da Classificação, mas ele é o nome de uma
    // categoria: vale como evidência forte, e vira regra de verdade quando o
    // operador confirmar.
    if (!candidatos.some(c => c.tipo_match === 'classificacao_exata')) {
      const cat = this.categoriaPorNome.get(normalizar(linha.classificacao));
      if (cat) {
        candidatos.unshift({
          regra: null, tipo_match: 'nome_categoria', categoria_id: cat.id,
          confianca: 0.9, forca: 0.9
        });
      }
    }

    const desc = nucleoDescricao([linha.descricao, linha.favorecido].filter(Boolean).join(' '));
    if (desc) {
      for (const r of this.contem) {
        if (r.conta_id && r.conta_id !== contaId) continue;
        if (r.padrao_norm.length < 4) continue;   // evita casar com fragmentos curtos demais
        if (desc.includes(r.padrao_norm)) { candidatos.push(this._candidato(r, 'contem_descricao')); break; }
      }
    }

    if (!candidatos.length) return null;

    const categorias = new Set(candidatos.map(c => c.categoria_id));
    const vencedor = candidatos[0];   // a de maior prioridade continua mandando

    if (categorias.size === 1) {
      return {
        regra: vencedor.regra,
        categoria_id: vencedor.categoria_id,
        tipo_match: vencedor.tipo_match,
        confianca: vencedor.confianca,
        nivel: vencedor.regra ? nivelDe(vencedor.regra, vencedor.confianca) : 'ALTA',
        candidatos,
        conflito: null
      };
    }

    // Evidências divergentes: quem tem mais lastro entra como alternativa.
    const alternativa = candidatos
      .filter(c => c.categoria_id !== vencedor.categoria_id)
      .sort((a, b) => b.forca - a.forca)[0];

    const confianca = round2ish(Math.min(vencedor.confianca, 0.55));

    return {
      regra: vencedor.regra,
      categoria_id: vencedor.categoria_id,
      tipo_match: vencedor.tipo_match,
      confianca,
      nivel: 'BAIXA',
      candidatos,
      conflito: {
        motivo: 'evidencias',
        alternativa_id: alternativa.categoria_id,
        alternativa_match: alternativa.tipo_match,
        alternativa_forca: alternativa.forca,
        vencedor_forca: vencedor.forca,
        // a alternativa é mais forte que a evidência de maior prioridade?
        prefereAlternativa: alternativa.forca > vencedor.forca
      }
    };
  }

  _candidato(regra, tipo) {
    const confianca = round2ish(regra.confianca * (PESO[tipo] || 1));
    return {
      regra, tipo_match: tipo, categoria_id: regra.categoria_id, confianca,
      forca: forcaDaRegra(regra, tipo)
    };
  }
}

/**
 * Lastro de uma regra: peso do tipo × confiança × histórico de acertos.
 * Serve para decidir qual evidência é mais confiável quando duas brigam.
 */
export function forcaDaRegra(regra, tipo) {
  const acertos = regra.acertos || 0;
  const erros = regra.erros || 0;
  const historico = 1 + Math.log1p(acertos) - Math.log1p(erros) * 0.6;
  return round2ish((PESO[tipo] || 1) * (regra.confianca || 0) * Math.max(historico, 0.1));
}

function round2ish(n) { return Math.round(n * 1000) / 1000; }

/**
 * Núcleo estável de uma descrição: tira data, hora e números soltos, que
 * mudam a cada lançamento e impediriam qualquer reaproveitamento.
 * 'Pix - Enviado — 30/07 15:20 ENEL DISTRIBUICAO CEARA'
 *   -> 'pix enviado enel distribuicao ceara'
 */
export function nucleoDescricao(txt) {
  return normalizar(txt)
    .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, ' ')   // 30/07 · 30/07/2026
    .replace(/\b\d{1,2}[:h]\d{2}\b/g, ' ')                 // 15:20
    .replace(/\d{5,}/g, ' ')                              // ids longos grudados no texto
    .replace(/\b\d+\b/g, ' ')                              // números soltos
    .replace(/\s+/g, ' ')
    .trim();
}

export function nivelDe(regra, confiancaEfetiva) {
  const c = confiancaEfetiva == null ? regra.confianca : confiancaEfetiva;
  const usos = (regra.acertos || 0) + (regra.erros || 0);
  const aprendida = (regra.origem_regra || 'APRENDIDA') === 'APRENDIDA';
  if (c >= LIMIAR_ALTA && (!aprendida || usos >= USOS_MIN_ALTA)) return 'ALTA';
  if (c >= LIMIAR_MEDIA) return 'MEDIA';
  return 'BAIXA';
}

export const ROTULO_NIVEL = { ALTA: 'Alta', MEDIA: 'Média', BAIXA: 'Baixa' };
export const CLASSE_NIVEL = { ALTA: 'conf-alta', MEDIA: 'conf-media', BAIXA: 'conf-baixa' };

/* ------------------------------------------------------------
   Carregamento
   ------------------------------------------------------------ */

export async function carregarMemoria() {
  const [regras, categorias] = await Promise.all([db.listar('regra'), db.listar('categoria')]);
  return new Memoria(regras, categorias);
}

/* ------------------------------------------------------------
   Reforço — chamado no momento em que o humano confirma
   ------------------------------------------------------------ */

/**
 * Chave que identifica linhas "iguais" dentro de uma mesma fila: mesma
 * Classificação escrita no extrato e mesmo favorecido. É o que permite
 * classificar uma e resolver as outras — 440 das 2.576 linhas dos extratos
 * reais são repetições assim.
 * @returns {string|null}
 */
export function chaveDeAgrupamento(linha) {
  const cls = normalizar(linha.classificacao);
  const fav = normalizar(linha.favorecido);
  const doc = soDigitos(linha.documento);

  if (cls && fav) return 'cf:' + cls + '|' + fav;
  if (cls) return 'c:' + cls;
  if (doc && doc.length >= 11) return 'd:' + doc;
  if (fav && fav.length >= 4) return 'f:' + fav;

  const nucleo = nucleoDescricao(linha.descricao);
  return nucleo && nucleo.length >= 8 ? 'n:' + nucleo : null;
}

/**
 * TODAS as evidências que a linha oferece — não só a de maior prioridade.
 * Aprender as quatro de uma vez é o que permite, mais tarde, perceber que
 * a coluna Classificação contradiz o histórico do próprio favorecido.
 * @returns {Array<{tipo_match, padrao, padrao_norm}>}
 */
export function chavesDeAprendizado(linha) {
  const chaves = [];

  if (linha.classificacao && normalizar(linha.classificacao)) {
    chaves.push({
      tipo_match: 'classificacao_exata',
      padrao: String(linha.classificacao).trim(),
      padrao_norm: normalizar(linha.classificacao)
    });
  }

  const doc = soDigitos(linha.documento);
  if (doc && doc.length >= 11) {
    chaves.push({ tipo_match: 'documento_cnpj', padrao: String(linha.documento).trim(), padrao_norm: doc });
  }

  const fav = normalizar(linha.favorecido);
  if (fav && fav.length >= 4) {
    chaves.push({ tipo_match: 'favorecido', padrao: String(linha.favorecido).trim(), padrao_norm: fav });
  }

  const nucleo = nucleoDescricao(linha.descricao);
  if (nucleo && nucleo.length >= 8 && nucleo !== fav) {
    chaves.push({ tipo_match: 'contem_descricao', padrao: nucleo, padrao_norm: nucleo });
  }

  return chaves;
}

/** Compatibilidade: a chave de maior prioridade. */
export function chaveDeAprendizado(linha) {
  return chavesDeAprendizado(linha)[0] || null;
}

/**
 * Aplica o aprendizado de UMA confirmação. Não escreve no banco: acumula
 * as regras alteradas em `pendentes` (Map id -> regra), de forma que um lote
 * com 300 linhas gere apenas uma escrita por regra. Use `opsDaMemoria()`
 * no fim para transformar o acumulador em operações de `db.emLote`.
 *
 * @param {object} linha               linha da fila (pode trazer .sugestao)
 * @param {string} categoriaEscolhida  categoria confirmada pelo humano
 * @param {Memoria} memoria
 * @param {Map} pendentes              acumulador entre linhas do mesmo lote
 */
export function reforcar(linha, categoriaEscolhida, memoria, pendentes) {
  const agora = new Date().toISOString();
  const sug = linha.sugestao;

  const recalc = r => {
    const usos = r.acertos + r.erros;
    r.confianca = usos ? round2ish(r.acertos / usos) : r.confianca;
  };

  // 1) As regras que geraram a sugestão: acerto ou erro.
  //    Com a detecção de conflito, uma linha pode ter casado por mais de uma
  //    evidência — todas são pontuadas, não só a vencedora.
  const usadas = sug ? [sug.regra, ...(sug.candidatos || []).map(c => c.regra)].filter(Boolean) : [];
  // comparação por id: `pendentes` guarda cópias, então identidade de objeto
  // não serve — era por isso que a mesma regra levava dois acertos por linha
  const idsUsados = new Set(usadas.map(r => r.id));
  const penalizadas = new Set();

  const porId = new Map(usadas.map(r => [r.id, r]));
  for (const regra of porId.values()) {
    const alvo = pegar(pendentes, regra);
    alvo.ultimo_uso = agora;
    if (alvo.categoria_id === categoriaEscolhida) {
      alvo.acertos++;
      if (alvo.origem_regra !== 'APRENDIDA') alvo.confianca = Math.max(alvo.confianca, 0.95);
      else recalc(alvo);
    } else {
      alvo.erros++;
      recalc(alvo);
      penalizadas.add(alvo.id);
    }
  }

  // 2) Cria/reforça TODAS as evidências que a linha oferece.
  //    É isso que faz o app aprender que "ENEL DISTRIBUICAO CEARA" é energia,
  //    mesmo quando a coluna Classificação do extrato veio errada.
  for (const chave of chavesDeAprendizado(linha)) {
    const existente = acharRegra(memoria, pendentes, chave, linha.conta_id);

    if (existente) {
      const alvo = pegar(pendentes, existente);
      alvo.ultimo_uso = agora;

      if (alvo.categoria_id === categoriaEscolhida) {
        // já pontuada no passo 1? não conta duas vezes
        if (!idsUsados.has(alvo.id)) { alvo.acertos++; recalc(alvo); }
        continue;
      }

      if (!penalizadas.has(alvo.id) && !idsUsados.has(alvo.id)) {
        alvo.erros++;
        penalizadas.add(alvo.id);
      }

      // Só reaponta quando a evidência acumulada apoia a troca. Uma linha
      // isolada não derruba uma regra com histórico — ela vira erro e
      // aparece como conflito na próxima importação.
      if (deveReapontar(alvo)) {
        alvo.categoria_id = categoriaEscolhida;
        alvo.acertos = 1;
        alvo.erros = 0;
        alvo.origem_regra = 'APRENDIDA';
        alvo.confianca = 1;
      } else {
        recalc(alvo);
      }
      continue;
    }

    const nova = {
      id: uuid(), empresa_id: db.EMPRESA_LOCAL,
      padrao: chave.padrao, padrao_norm: chave.padrao_norm,
      tipo_match: chave.tipo_match,
      categoria_id: categoriaEscolhida,
      conta_id: null,
      acertos: 1, erros: 0, confianca: 1,
      origem_regra: 'APRENDIDA',
      criado_em: agora, ultimo_uso: agora,
      _novo: true
    };
    pendentes.set(nova.id, nova);
    memoria.regras.push(nova);
    memoria._indexar(nova);
  }
}

/**
 * Uma regra só muda de destino quando erra mais do que acerta. Assim uma
 * classificação equivocada isolada não sequestra um padrão consolidado.
 */
function deveReapontar(regra) {
  const acertos = regra.acertos || 0;
  const erros = regra.erros || 0;
  if (regra.origem_regra === 'SEED' && acertos > 0) return false;
  return erros > acertos;
}

function pegar(pendentes, regra) {
  if (!pendentes.has(regra.id)) pendentes.set(regra.id, { ...regra });
  return pendentes.get(regra.id);
}

function acharRegra(memoria, pendentes, chave, contaId) {
  for (const r of pendentes.values()) {
    if (r.tipo_match === chave.tipo_match && r.padrao_norm === chave.padrao_norm &&
        (r.conta_id === (contaId || null) || !r.conta_id)) return r;
  }
  return memoria.regras.find(r =>
    r.tipo_match === chave.tipo_match && r.padrao_norm === chave.padrao_norm &&
    (r.conta_id === (contaId || null) || !r.conta_id)) || null;
}

/**
 * Consolida o acumulador em operações de escrita: uma por regra tocada.
 */
export function opsDaMemoria(pendentes) {
  const ops = [];
  for (const r of pendentes.values()) {
    const { _novo, ...dados } = r;
    ops.push({ acao: _novo ? 'inserir' : 'atualizar', dados });
  }
  return ops;
}

/* ------------------------------------------------------------
   Porta única de aprendizado
   ------------------------------------------------------------ */

/**
 * Ensina a memória a partir de decisões humanas já tomadas e grava as regras.
 * É por aqui que passam TODAS as correções do app — a fila de importação, a
 * troca de categoria na tela de Lançamentos, a recategorização em lote e o
 * lançamento manual. Antes, só a importação ensinava; corrigir depois
 * arrumava a DRE e deixava o app repetir o mesmo erro no mês seguinte.
 *
 * Quando a linha não traz `sugestao`, ela é calculada na hora: assim a regra
 * que levou ao engano leva o erro, em vez de só nascer uma regra nova.
 *
 * @param {Array<{linha, categoria_id}>} decisoes
 * @returns {Promise<{regras:number, ignoradas:number}>}
 */
export async function ensinar(decisoes) {
  if (!decisoes || !decisoes.length) return { regras: 0, ignoradas: 0 };

  const categorias = await db.listar('categoria');
  const catALancar = categorias.find(c => c.nome === 'A CLASSIFICAR');
  const idALancar = catALancar ? catALancar.id : null;

  const memoria = await carregarMemoria();
  const pendentes = new Map();
  let ignoradas = 0;

  for (const { linha, categoria_id } of decisoes) {
    // 'A CLASSIFICAR' não é decisão, é a ausência dela
    if (!categoria_id || categoria_id === idALancar) { ignoradas++; continue; }
    // receita mensal e agrupamentos do importador não ensinam: a descrição é
    // sintética e viraria uma regra nova a cada mês
    if (linha.observacao === 'RECEITA_MENSAL' || linha.categoria_forcada) { ignoradas++; continue; }
    if (!chavesDeAprendizado(linha).length) { ignoradas++; continue; }

    const alvo = 'sugestao' in linha
      ? linha
      : { ...linha, sugestao: memoria.sugerir(linha) };

    reforcar(alvo, categoria_id, memoria, pendentes);
  }

  const ops = opsDaMemoria(pendentes);
  if (ops.length) await db.emLote('regra', ops);
  return { regras: ops.length, ignoradas };
}

/**
 * Refaz a memória a partir dos lançamentos já classificados.
 *
 * Todo lançamento com categoria é uma decisão humana que já foi tomada — mas
 * a regra correspondente pode não existir: a base pode ter vindo de um backup,
 * de outro navegador (o IndexedDB é isolado por origem, então trocar de porta
 * começa do zero) ou de uma versão do app que aprendia menos chaves por linha.
 * Sem isso, um extrato novo cai inteiro em A CLASSIFICAR mesmo tendo os mesmos
 * fornecedores dos meses anteriores.
 *
 * @param {object} opcoes  { competencias: [..] } para limitar o período
 * @returns {Promise<{lidos, ensinados, ignorados, regras, regrasAntes, regrasDepois}>}
 */
export async function reconstruirMemoria(opcoes = {}) {
  const [lancamentos, categorias] = await Promise.all([
    db.listar('lancamento'), db.listar('categoria')
  ]);
  const catPorId = new Map(categorias.map(c => [c.id, c]));
  const regrasAntes = (await db.listar('regra')).length;

  const decisoes = [];
  let ignorados = 0;

  for (const l of lancamentos) {
    if (opcoes.competencias && !opcoes.competencias.includes(l.competencia)) continue;

    const cat = catPorId.get(l.categoria_id);
    // EXCLUIR ensina (é decisão real); só A CLASSIFICAR fica de fora
    if (!cat || cat.nome === 'A CLASSIFICAR') { ignorados++; continue; }
    if (l.status === 'A_CLASSIFICAR') { ignorados++; continue; }
    if (l.observacao === 'RECEITA_MENSAL') { ignorados++; continue; }

    // `sugestao: null` explícito: aqui só se ensina. Recalcular a sugestão
    // faria a reconstrução penalizar regras a partir de dados que ela mesma
    // acabou de criar.
    decisoes.push({
      linha: {
        descricao: l.descricao, favorecido: l.favorecido,
        documento: l.documento, classificacao: l.classificacao,
        conta_id: l.conta_id, sugestao: null
      },
      categoria_id: l.categoria_id
    });
  }

  const res = await ensinar(decisoes);
  const regrasDepois = (await db.listar('regra')).length;

  return {
    lidos: lancamentos.length,
    ensinados: decisoes.length - res.ignoradas,
    ignorados: ignorados + res.ignoradas,
    regras: res.regras,
    regrasAntes,
    regrasDepois
  };
}

/* ------------------------------------------------------------
   Importação / exportação da memória
   ------------------------------------------------------------ */

export async function exportarMemoria() {
  const [regras, categorias] = await Promise.all([db.listar('regra'), db.listar('categoria')]);
  const nomePorId = new Map(categorias.map(c => [c.id, c.nome]));
  return {
    _meta: { app: 'dre-sabor', conteudo: 'memoria-de-aprendizado', exportado_em: new Date().toISOString() },
    regra: regras.map(r => ({ ...r, categoria_nome: nomePorId.get(r.categoria_id) || null }))
  };
}

/**
 * Importa regras resolvendo a categoria por nome (mais robusto entre bases).
 * @returns {{importadas, ignoradas}}
 */
export async function importarMemoria(json) {
  const lista = Array.isArray(json) ? json : (json.regra || []);
  const categorias = await db.listar('categoria');
  const idPorNome = new Map(categorias.map(c => [normalizar(c.nome), c.id]));
  const idsValidos = new Set(categorias.map(c => c.id));
  const atuais = await db.listar('regra');
  const chaveAtual = new Map(atuais.map(r => [`${r.tipo_match}|${r.padrao_norm}|${r.conta_id || ''}`, r]));

  const ops = [];
  let ignoradas = 0;
  for (const r of lista) {
    let catId = idsValidos.has(r.categoria_id) ? r.categoria_id
      : idPorNome.get(normalizar(r.categoria_nome || ''));
    if (!catId) { ignoradas++; continue; }
    const padraoNorm = r.padrao_norm || normalizar(r.padrao);
    const k = `${r.tipo_match}|${padraoNorm}|${r.conta_id || ''}`;
    const jaTem = chaveAtual.get(k);
    const dados = {
      id: jaTem ? jaTem.id : (r.id || uuid()),
      empresa_id: db.EMPRESA_LOCAL,
      padrao: r.padrao, padrao_norm: padraoNorm,
      tipo_match: r.tipo_match, categoria_id: catId, conta_id: r.conta_id || null,
      acertos: r.acertos || 0, erros: r.erros || 0,
      confianca: r.confianca == null ? 0.8 : r.confianca,
      origem_regra: r.origem_regra || 'MANUAL',
      criado_em: r.criado_em || new Date().toISOString(),
      ultimo_uso: r.ultimo_uso || null
    };
    ops.push({ acao: jaTem ? 'atualizar' : 'inserir', dados });
  }
  const res = await db.emLote('regra', ops);
  return { importadas: res.inseridos + res.atualizados, ignoradas };
}
