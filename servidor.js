/* ============================================================
   servidor.js — servidor estático para desenvolvimento

   Os módulos ES não carregam via file:// (política de origem do
   navegador), então o app precisa ser servido por HTTP.

   Uso:  node servidor.js  [porta]  [--local]

   --local  ignora o config.js e serve o app em modo local (IndexedDB),
            mesmo com as chaves do Supabase presentes. É o que os testes
            automatizados usam — eles nunca devem tocar o projeto real.
   ============================================================ */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = __dirname;
const PORTA = Number(process.argv.find(a => /^\d+$/.test(a))) || 8080;
const FORCAR_LOCAL = process.argv.includes('--local');

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
};

http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';

  const alvo = path.join(RAIZ, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!alvo.startsWith(RAIZ)) { res.writeHead(403).end('Proibido'); return; }

  fs.readFile(alvo, (erro, dados) => {
    // Sem config.js o app roda em modo local. Devolver um módulo vazio em
    // vez de 404 evita um erro vermelho no console a cada carregamento.
    if ((erro || FORCAR_LOCAL) && rel === '/config.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(["export const SUPABASE_URL = '';", "export const SUPABASE_ANON_KEY = '';", ''].join('\n'));
      return;
    }
    if (erro) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Não encontrado: ' + rel);
      return;
    }
    res.writeHead(200, {
      'content-type': TIPOS[path.extname(alvo).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache'
    });
    res.end(dados);
  });
}).listen(PORTA, () => {
  console.log(`DRE Sabor rodando em  http://localhost:${PORTA}` + (FORCAR_LOCAL ? '  (modo local forçado)' : ''));
  console.log('Ctrl+C para parar.');
});
