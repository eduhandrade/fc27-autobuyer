# FC27 Autobuyer

Userscript que automatiza compras no Mercado de Transferências do **Web App do EA SPORTS FC 27 Ultimate Team**. Ele roda dentro do próprio Web App, usando a sessão que você já abriu. O script nunca vê sua senha.

> ⚠️ **Aviso:** automatizar o mercado viola os Termos de Serviço da EA. Usar este script pode levar a captcha, bloqueio temporário do mercado ou **banimento permanente da conta**. Use por sua conta e risco.

## Instalação

### iPhone (Safari)
1. Instale o app gratuito **Userscripts** (App Store, desenvolvedor Justin Wasack).
2. Abra o app e escolha uma pasta para os scripts (ex.: *No meu iPhone → Userscripts*).
3. Em **Ajustes → Safari → Extensões → Userscripts**, ative a extensão e permita em **www.ea.com**.
4. Copie o arquivo `fc27-autobuyer.user.js` para essa pasta pelo app Arquivos, ou crie um script novo no Userscripts e cole o conteúdo.
5. Abra o Web App no Safari e faça login. O botão verde **⚡** aparece no canto da tela.

### PC (Chrome)
1. Instale a extensão **Tampermonkey**.
2. Em Tampermonkey → *Criar novo script*, cole o conteúdo de `fc27-autobuyer.user.js` e salve.
3. Abra o Web App e faça login. O botão **⚡** aparece no canto.

## Como usar
1. **Crie um alvo:** no Web App, vá em *Transferências → Pesquisar no mercado*, escolha o jogador e os filtros e toque em *Pesquisar*. O script captura essa busca. Abra o painel ⚡ e informe:
   - **Preço máximo de compra**: o bot só compra por esse valor ou menos.
   - **Preço de revenda** (opcional): se preenchido, a carta é listada automaticamente por esse preço (duração de 1h).
2. Revise a aba **Config**: esperas, pausas e limites.
3. Toque em **Iniciar**. Acompanhe pelas abas **Log** e **Compras**.

Cartas compradas sem preço de revenda ficam em **Não atribuídos**.

## Proteções embutidas
- Espera aleatória entre buscas (padrão 4–8 s) e pausa a cada 25 buscas (padrão 3 min).
- Limites por sessão: número de buscas, número de compras e orçamento em moedas.
- Para sozinho quando a EA pede **captcha** (458), quando a sessão expira (401), quando a EA limita as buscas (426/429/512/521) ou depois de 3 erros seguidos.
- Varia o filtro de preço mínimo a cada busca para evitar resultados em cache.
- Mantém a tela do iPhone acesa enquanto roda (Wake Lock).

## Limitações
- No iPhone, o Safari pausa o bot quando você bloqueia a tela ou troca de app.
- O script usa objetos internos do Web App (`services.Item`, `UTSearchCriteriaDTO`). Se a EA mudar isso, use o botão **Diagnóstico do Web App** na aba Config para ver o que quebrou.

## Desenvolvimento
Tudo fica em um único arquivo, `fc27-autobuyer.user.js`, sem etapa de build. Testes (Node 18+):

```sh
npm test
```
