-- ============================================================
--  DRE Sabor — schema Postgres / Supabase
--  Etapa 2. Rodar no SQL Editor do Supabase, de uma vez.
--
--  Observação de ordem: no briefing a tabela `lancamento` referencia
--  `importacao`, que é declarada depois. Aqui `importacao` vem antes,
--  para o FK resolver sem precisar de ALTER posterior.
-- ============================================================

create extension if not exists "pgcrypto";
create extension if not exists "unaccent";

-- ===== Usuários e organização =====
create table empresa (
  id            uuid primary key default gen_random_uuid(),
  nome          text not null,
  cnpj          text,
  logo          text,                     -- data URL da foto, já reduzida pelo app
  criado_em     timestamptz not null default now()
);

create table perfil_usuario (
  id            uuid primary key references auth.users(id) on delete cascade,
  empresa_id    uuid not null references empresa(id) on delete cascade,
  nome          text not null,
  email         text,                   -- espelho de auth.users, que o app não consegue ler
  papel         text not null check (papel in ('admin','operador','leitor')),
  tema          text not null default 'dark' check (tema in ('dark','light')),
  ativo         boolean not null default true,
  criado_em     timestamptz not null default now()
);

create index idx_perfil_empresa on perfil_usuario (empresa_id);

-- ===== Plano de contas =====
create table categoria (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid not null references empresa(id) on delete cascade,
  nome          text not null,
  tipo          text not null check (tipo in
                  ('RECEITA','DEDUCAO','CUSTO_VARIAVEL','DESPESA_FIXA',
                   'DESPESA_FINANCEIRA','CONTROLE')),
  grupo         text not null,          -- bloco pai na DRE
  ordem         int  not null,          -- posição na DRE
  ativa         boolean not null default true,
  unique (empresa_id, nome)
);

-- ===== Contas bancárias / origens =====
create table conta (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid not null references empresa(id) on delete cascade,
  nome          text not null,          -- 'Banco do Brasil', 'Stone Sabor', ...
  tipo          text not null check (tipo in ('BANCO','ADQUIRENTE','CAIXA')),
  documento     text,                   -- CNPJ da conta
  layout        text not null check (layout in ('BB','BRADESCO','STONE','CAIXA')),
  ativa         boolean not null default true,
  unique (empresa_id, nome)
);

-- ===== Controle de importações =====
create table importacao (
  id             uuid primary key default gen_random_uuid(),
  empresa_id     uuid not null references empresa(id) on delete cascade,
  conta_id       uuid not null references conta(id),
  competencia    char(7) not null,
  arquivo_nome   text not null,
  arquivo_hash   text not null,         -- SHA-256 do conteúdo, evita reimportar o mesmo arquivo
  linhas_lidas   int not null default 0,
  linhas_gravadas int not null default 0,
  linhas_duplicadas int not null default 0,
  linhas_a_classificar int not null default 0,
  status         text not null default 'EM_REVISAO'
                 check (status in ('EM_REVISAO','CONCLUIDA','CANCELADA')),
  importado_por  uuid references perfil_usuario(id),
  criado_em      timestamptz not null default now()
);

create index idx_imp_hash on importacao (empresa_id, arquivo_hash);

-- ===== Lançamentos (tabela central) =====
create table lancamento (
  id             uuid primary key default gen_random_uuid(),
  empresa_id     uuid not null references empresa(id) on delete cascade,
  data           date not null,
  competencia    char(7) not null,      -- 'AAAA-MM'
  descricao      text not null,
  favorecido     text,
  documento      text,                  -- CPF/CNPJ ou nº do documento
  classificacao  text,                  -- texto original da coluna De/Para do extrato
  valor          numeric(14,2) not null check (valor >= 0),
  sentido        text not null check (sentido in ('DEBITO','CREDITO')),
  categoria_id   uuid not null references categoria(id),
  conta_id       uuid not null references conta(id),
  origem         text not null check (origem in ('MANUAL','IMPORTACAO','RECORRENCIA')),
  status         text not null default 'CLASSIFICADO'
                 check (status in ('A_CLASSIFICAR','CLASSIFICADO','EXCLUIDO','CONFERIDO')),
  arquivo_origem text,
  lote_id        uuid references importacao(id) on delete set null,
  hash_dedup     text not null,
  recorrente     boolean not null default false,
  observacao     text,
  criado_por     uuid references perfil_usuario(id),
  criado_em      timestamptz not null default now(),
  atualizado_em  timestamptz not null default now(),
  unique (empresa_id, hash_dedup)
);

create index idx_lanc_comp     on lancamento (empresa_id, competencia);
create index idx_lanc_cat      on lancamento (empresa_id, categoria_id, competencia);
create index idx_lanc_conta    on lancamento (empresa_id, conta_id, competencia);
create index idx_lanc_status   on lancamento (empresa_id, status);
create index idx_lanc_lote     on lancamento (lote_id);
create index idx_lanc_busca    on lancamento using gin (to_tsvector('portuguese', descricao));

-- ===== Memória de aprendizado =====
create table regra (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid not null references empresa(id) on delete cascade,
  padrao        text not null,          -- como o usuário digitou
  padrao_norm   text not null,          -- normalizado (sem acento, minúsculo)
  tipo_match    text not null check (tipo_match in
                  ('classificacao_exata','documento_cnpj','favorecido','contem_descricao')),
  categoria_id  uuid not null references categoria(id),
  conta_id      uuid references conta(id),   -- null = vale para todas
  acertos       int not null default 0,
  erros         int not null default 0,
  confianca     numeric(4,3) not null default 0.5,
  origem_regra  text not null default 'APRENDIDA' check (origem_regra in ('SEED','APRENDIDA','MANUAL')),
  criado_em     timestamptz not null default now(),
  ultimo_uso    timestamptz,
  unique (empresa_id, padrao_norm, tipo_match, conta_id)
);

create index idx_regra_lookup on regra (empresa_id, tipo_match, padrao_norm);

-- ===== Fechamento mensal =====
create table competencia_fechada (
  empresa_id    uuid not null references empresa(id) on delete cascade,
  competencia   char(7) not null,
  fechada_em    timestamptz not null default now(),
  fechada_por   uuid references perfil_usuario(id),
  primary key (empresa_id, competencia)
);

-- ===== Auditoria =====
create table auditoria (
  id            bigserial primary key,
  empresa_id    uuid not null,
  usuario_id    uuid,
  entidade      text not null,          -- 'lancamento', 'categoria', 'regra', ...
  entidade_id   uuid,
  acao          text not null check (acao in ('INSERT','UPDATE','DELETE')),
  antes         jsonb,
  depois        jsonb,
  criado_em     timestamptz not null default now()
);
create index idx_aud on auditoria (empresa_id, entidade, criado_em desc);


-- ============================================================
--  View de consolidação da DRE
--  Os totalizadores (RECEITA LÍQUIDA, LUCRO BRUTO, etc.) são
--  calculados no frontend a partir desta view.
-- ============================================================

create view v_dre as
select l.empresa_id, l.competencia, c.grupo, c.tipo, c.nome as categoria, c.ordem,
       -- estorno (crédito) em despesa abate; devolução (débito) em receita abate
       sum(case when (c.tipo = 'RECEITA' and l.sentido = 'DEBITO')
                  or (c.tipo <> 'RECEITA' and l.sentido = 'CREDITO')
                then -l.valor else l.valor end) as valor
from lancamento l
join categoria c on c.id = l.categoria_id
where l.status in ('CLASSIFICADO','CONFERIDO')
  and c.tipo <> 'CONTROLE'
group by 1,2,3,4,5,6;


-- ============================================================
--  Funções de apoio
-- ============================================================

-- empresa do usuário logado
create or replace function empresa_do_usuario()
returns uuid language sql stable security definer set search_path = public as $$
  select empresa_id from perfil_usuario where id = auth.uid()
$$;

create or replace function papel_do_usuario()
returns text language sql stable security definer set search_path = public as $$
  select papel from perfil_usuario where id = auth.uid() and ativo
$$;

-- atualizado_em automático
create or replace function tg_atualizado_em()
returns trigger language plpgsql as $$
begin
  new.atualizado_em := now();
  return new;
end $$;

create trigger lancamento_atualizado_em
  before update on lancamento
  for each row execute function tg_atualizado_em();

-- normalização igual à do frontend (minúscula, sem acento, sem pontuação)
create or replace function normalizar(txt text)
returns text language sql immutable as $$
  select trim(regexp_replace(
           regexp_replace(lower(unaccent(coalesce(txt,''))), '[^a-z0-9\s/]', ' ', 'g'),
           '\s+', ' ', 'g'))
$$;

-- competência fechada bloqueia insert/update/delete
create or replace function tg_bloqueia_competencia_fechada()
returns trigger language plpgsql as $$
declare
  alvo char(7);
  emp  uuid;
begin
  alvo := coalesce(new.competencia, old.competencia);
  emp  := coalesce(new.empresa_id, old.empresa_id);
  if exists (select 1 from competencia_fechada f
             where f.empresa_id = emp and f.competencia = alvo) then
    raise exception 'A competência % está fechada e não aceita alterações.', alvo
      using errcode = 'check_violation';
  end if;
  -- em UPDATE, também impede mover um lançamento PARA um mês fechado
  if tg_op = 'UPDATE' and old.competencia is distinct from new.competencia then
    if exists (select 1 from competencia_fechada f
               where f.empresa_id = new.empresa_id and f.competencia = old.competencia) then
      raise exception 'A competência % está fechada.', old.competencia
        using errcode = 'check_violation';
    end if;
  end if;
  return coalesce(new, old);
end $$;

create trigger lancamento_competencia_fechada
  before insert or update or delete on lancamento
  for each row execute function tg_bloqueia_competencia_fechada();

-- auditoria automática dos lançamentos
create or replace function tg_auditar_lancamento()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into auditoria (empresa_id, usuario_id, entidade, entidade_id, acao, antes, depois)
  values (coalesce(new.empresa_id, old.empresa_id), auth.uid(), 'lancamento',
          coalesce(new.id, old.id), tg_op,
          case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end);
  return coalesce(new, old);
end $$;

create trigger lancamento_auditoria
  after insert or update or delete on lancamento
  for each row execute function tg_auditar_lancamento();


-- ============================================================
--  RLS — o usuário só enxerga a própria empresa.
--  Escrita exige papel admin/operador; exclusão exige admin.
-- ============================================================

alter table empresa              enable row level security;
alter table perfil_usuario       enable row level security;
alter table categoria            enable row level security;
alter table conta                enable row level security;
alter table lancamento           enable row level security;
alter table regra                enable row level security;
alter table importacao           enable row level security;
alter table competencia_fechada  enable row level security;
alter table auditoria            enable row level security;

-- empresa
create policy empresa_ver on empresa
  for select using (id = empresa_do_usuario());
create policy empresa_editar on empresa
  for update using (id = empresa_do_usuario() and papel_do_usuario() = 'admin');

-- perfil_usuario
create policy perfil_ver on perfil_usuario
  for select using (empresa_id = empresa_do_usuario());
create policy perfil_criar on perfil_usuario
  for insert with check (empresa_id = empresa_do_usuario() and papel_do_usuario() = 'admin');
create policy perfil_editar on perfil_usuario
  for update using (empresa_id = empresa_do_usuario()
                    and (papel_do_usuario() = 'admin' or id = auth.uid()));
create policy perfil_apagar on perfil_usuario
  for delete using (empresa_id = empresa_do_usuario() and papel_do_usuario() = 'admin');

-- tabelas com o mesmo padrão: ver / escrever / apagar
do $$
declare t text;
begin
  foreach t in array array['categoria','conta','lancamento','regra','importacao','competencia_fechada']
  loop
    execute format($f$
      create policy %1$s_ver on %1$s
        for select using (empresa_id = empresa_do_usuario());
      create policy %1$s_criar on %1$s
        for insert with check (empresa_id = empresa_do_usuario()
                               and papel_do_usuario() in ('admin','operador'));
      create policy %1$s_editar on %1$s
        for update using (empresa_id = empresa_do_usuario()
                          and papel_do_usuario() in ('admin','operador'));
      create policy %1$s_apagar on %1$s
        for delete using (empresa_id = empresa_do_usuario()
                          and papel_do_usuario() = 'admin');
    $f$, t);
  end loop;
end $$;

-- categorias e fechamento só admin escreve
drop policy categoria_criar  on categoria;
drop policy categoria_editar on categoria;
create policy categoria_criar on categoria
  for insert with check (empresa_id = empresa_do_usuario() and papel_do_usuario() = 'admin');
create policy categoria_editar on categoria
  for update using (empresa_id = empresa_do_usuario() and papel_do_usuario() = 'admin');

drop policy competencia_fechada_criar on competencia_fechada;
create policy competencia_fechada_criar on competencia_fechada
  for insert with check (empresa_id = empresa_do_usuario() and papel_do_usuario() = 'admin');

-- auditoria: leitura só de admin; escrita pelos triggers e pelo app
create policy auditoria_ver on auditoria
  for select using (empresa_id = empresa_do_usuario() and papel_do_usuario() = 'admin');
create policy auditoria_criar on auditoria
  for insert with check (empresa_id = empresa_do_usuario()
                         and papel_do_usuario() in ('admin','operador'));

-- a view herda o RLS das tabelas de origem
alter view v_dre set (security_invoker = on);


-- ============================================================
--  Bootstrap da primeira empresa
--  A RLS exige um admin para inserir em perfil_usuario — e no primeiro
--  acesso não existe admin nenhum. Esta função, security definer, cria a
--  empresa e o perfil admin para o usuário autenticado que ainda não tem
--  perfil. Quem já tem perfil recebe erro: não dá para "bootstrapar" de novo.
-- ============================================================

create or replace function bootstrap_empresa(p_nome_empresa text, p_nome_usuario text, p_email text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_emp uuid;
begin
  if v_uid is null then
    raise exception 'Não autenticado.';
  end if;
  if exists (select 1 from perfil_usuario where id = v_uid) then
    raise exception 'Este usuário já pertence a uma empresa.';
  end if;

  insert into empresa (nome) values (coalesce(p_nome_empresa, 'Minha empresa'))
    returning id into v_emp;

  insert into perfil_usuario (id, empresa_id, nome, email, papel, tema, ativo)
    values (v_uid, v_emp, coalesce(p_nome_usuario, split_part(p_email, '@', 1)), p_email, 'admin', 'dark', true);

  return v_emp;
end $$;

-- só usuários logados chamam; a função decide o resto
revoke all on function bootstrap_empresa(text, text, text) from public;
grant execute on function bootstrap_empresa(text, text, text) to authenticated;


-- ============================================================
--  Semente mínima
--  As categorias, contas e regras completas estão em
--  dados-exemplo.json — carregue-as pelo app (tela Backup) ou
--  gere os INSERTs a partir do mesmo arquivo.
-- ============================================================

-- insert into empresa (id, nome, cnpj)
-- values ('00000000-0000-4000-8000-000000000001', 'Sabor Doces & Salgados', '01.639.337/0001-06');
