# FC27 Autobuyer

Userscript que automatiza compras no Mercado de Transferências do **Web App do EA SPORTS FC 27 Ultimate Team**. Ele roda dentro do próprio Web App, usando a sessão que você já abriu. O script nunca vê sua senha.

> ⚠️ **Aviso:** automatizar o mercado viola os Termos de Serviço da EA. Usar este script pode levar a captcha, bloqueio temporário do mercado ou **banimento permanente da conta**. Use por sua conta e risco.

## Instalação

São dois arquivos. Instale os dois do mesmo jeito:
- `fc27-autobuyer.user.js`: o bot e o painel.
- `fc27-futbin-bridge.user.js`: a "ponte" que busca os preços no FUTBIN. É opcional; sem ela, o bot funciona, mas sem preços do FUTBIN.

A ponte existe porque o navegador não deixa a página da EA ler dados do futbin.com. A ponte roda com a permissão de rede do gerenciador de scripts e só acessa endereços do futbin.com.

### iPhone (Safari)
1. Instale o app gratuito **Userscripts** (App Store, desenvolvedor Justin Wasack).
2. Abra o app e escolha uma pasta para os scripts (ex.: *No meu iPhone → Userscripts*).
3. Em **Ajustes → Safari → Extensões → Userscripts**, ative a extensão e permita em **www.ea.com**.
4. No GitHub, abra cada arquivo, toque em **… → Download** e mova-o, pelo app Arquivos, para a pasta do Userscripts. Os nomes devem terminar em `.user.js`.
5. Abra o Web App no Safari e faça login. O botão verde **⚡** aparece no canto da tela.

### PC (Chrome)
1. Instale a extensão **Tampermonkey**.
2. Em Tampermonkey → *Criar novo script*, cole o conteúdo de `fc27-autobuyer.user.js` e salve. Repita com `fc27-futbin-bridge.user.js`.
3. Abra o Web App e faça login. O botão **⚡** aparece no canto.

## Como usar
1. **Crie um alvo:** no Web App, vá em *Transferências → Pesquisar no mercado*, escolha o jogador e os filtros e toque em *Pesquisar*. O script captura essa busca. Abra o painel ⚡ e informe:
   - **Preço máximo de compra**: o bot só compra por esse valor ou menos.
   - **Preço de revenda** (opcional): se preenchido, a carta é listada automaticamente por esse preço (duração de 1h).
   - Com a ponte instalada, o painel mostra o **preço do FUTBIN** da carta e já preenche uma sugestão: compra até o FUTBIN menos a margem (padrão 15%) e revenda pelo preço do FUTBIN.
2. Revise a aba **Config**: plataforma (PlayStation/Xbox ou PC), margem do FUTBIN: esperas, pausas e limites.
3. Toque em **Iniciar**. Acompanhe pelas abas **Log** e **Compras**.

Cartas compradas sem preço de revenda ficam em **Não atribuídos**.

## Preços do FUTBIN
- O FUTBIN mostra o **menor preço de "comprar agora"** atual de cada carta, não uma média. É esse valor que aparece no painel.
- Cada alvo mostra o preço, há quanto tempo foi consultado, e os botões **↻** (atualizar) e **Usar sugestão**. Os preços são atualizados ao abrir o painel, se tiverem mais de 15 minutos.
- Alvos criados por ID são identificados na primeira busca do bot.
- Se aparecer "FUTBIN bloqueou", abra futbin.com uma vez no mesmo navegador e tente de novo.

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
