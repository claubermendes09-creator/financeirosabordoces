/* ============================================================
   config.js — ligação com o Supabase (Etapa 2)

   1. Copie este arquivo para  config.js  (mesma pasta).
   2. Preencha com os valores de  Settings → API  do seu projeto.
   3. Recarregue o app. Existindo config.js, a nuvem liga sozinha.

   config.js está no .gitignore: nunca sobe para o Git.
   A anon key é pública por desenho — quem protege os dados é a RLS
   do sql/schema.sql, não a chave.
   ============================================================ */

export const SUPABASE_URL = 'https://SEU-PROJETO.supabase.co';
export const SUPABASE_ANON_KEY = 'sua-anon-key';
