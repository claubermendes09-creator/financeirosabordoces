#!/usr/bin/env bash
# Gera o config.js no build do Netlify a partir das variáveis de ambiente.
set -e
if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_ANON_KEY" ]; then
  echo "=================================================================="
  echo " ERRO: SUPABASE_URL e/ou SUPABASE_ANON_KEY não estão definidas."
  echo " Netlify → Site configuration → Environment variables → Add a variable"
  echo " (chave exatamente com esse nome, valor sem aspas, todos os escopos)"
  echo "=================================================================="
  echo " Variáveis SUPABASE_* visíveis no build:"
  env | grep -i '^SUPABASE' | sed 's/=.*/=(definida)/' || echo "   nenhuma"
  exit 1
fi
printf "export const SUPABASE_URL = '%s';\nexport const SUPABASE_ANON_KEY = '%s';\n" "$SUPABASE_URL" "$SUPABASE_ANON_KEY" > config.js
echo "config.js gerado para ${SUPABASE_URL}"
