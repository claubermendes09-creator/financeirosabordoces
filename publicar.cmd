@echo off
rem ============================================================
rem  publicar.cmd — sobe a pasta do projeto para o Netlify.
rem  1ª vez: abre o navegador para você autorizar (netlify login)
rem  e pergunta qual site — escolha "dresabor". Depois é só rodar.
rem ============================================================
cd /d "%~dp0"
where npx >nul 2>nul || (echo Node.js nao encontrado. Instale em https://nodejs.org & pause & exit /b 1)
npx --yes netlify-cli@17 deploy --prod --dir . --message "publicacao %date% %time%"
pause
