-- ============================================================
-- Migrações para projetos que já rodaram o schema.sql antes.
-- Rode no SQL Editor do Supabase, na ordem. Cada bloco é idempotente.
-- ============================================================

-- 2026-09-15 · foto da empresa (Usuários → Empresa → Trocar foto)
alter table empresa add column if not exists logo text;

-- 2026-09-15 · limpeza de contas criadas por testes automatizados que,
-- por engano, apontaram para este projeto. Só roda se existir a@b.com.
delete from empresa where id in (select empresa_id from perfil_usuario where email = 'a@b.com');
delete from auth.users where email = 'a@b.com';

-- 2026-09-15 · v_dre respeita o sentido: estorno em despesa e devolução em
-- receita abatem em vez de somar (mesma regra do js/dre.js)
create or replace view v_dre as
select l.empresa_id, l.competencia, c.grupo, c.tipo, c.nome as categoria, c.ordem,
       sum(case when (c.tipo = 'RECEITA' and l.sentido = 'DEBITO')
                  or (c.tipo <> 'RECEITA' and l.sentido = 'CREDITO')
                then -l.valor else l.valor end) as valor
from lancamento l
join categoria c on c.id = l.categoria_id
where l.status in ('CLASSIFICADO','CONFERIDO')
  and c.tipo <> 'CONTROLE'
group by 1,2,3,4,5,6;
alter view v_dre set (security_invoker = on);
