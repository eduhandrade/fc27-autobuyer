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
   - **Tipo do alvo (obrigatório):** *Jogador* ou *Consumível: estilo de química*. O tipo vem da busca capturada quando dá para reconhecer; se não der, você escolhe. O script nunca assume "jogador".
     - **Consumível:** só escolhe o estilo (ex.: Shadow). Compra apenas a carta de consumível; jogadores são sempre ignorados.
     - **Jogador:** jogador (busca por nome), posição ou grupo de posição (Defensores, Meio-campistas, Atacantes), química aplicada no jogador, time, liga e país (busca por nome), nível, **PlayStyle: Qualquer / Tem PlayStyle+** (igual ao filtro do Web App; o script aprende esse filtro na primeira vez que você fizer uma busca no Web App com "PlayStyle: PlayStyle+") e nota mínima/máxima. Ex.: CB + Shadow = zagueiro com Shadow. Os nomes vêm do próprio Web App (traduções e lista de jogadores); se não estiverem disponíveis, faça a busca pelo nome no mercado do Web App que o alvo vem preenchido.
   - **Quantidade por alvo:** "Quantas cartas comprar" (vazio = sem limite). Ao atingir, o alvo é desligado e marcado como Concluído; quando todos os alvos com quantidade terminam, o bot para. Só compras de verdade contam (compra perdida não conta); a contagem fica salva e pode ser zerada no cartão.
   - **Conferência antes de comprar:** o bot confere o tipo do item e cada filtro (posição, química, time, liga, país, nota e PlayStyle+; quando o filtro da EA já foi aprendido, a própria busca traz só jogadores com PlayStyle+). Se não conseguir confirmar algum, **não compra** e registra no Log o motivo ("Pulei ...: não é consumível").
   - **Modo simulação (ligado por padrão):** o bot procura mas não compra; o Log mostra "SIMULAÇÃO: compraria ...". Confira e desligue em Config.
   - Alvos criados antes da versão 0.6 ficam desligados até você revisar e salvar em ✎ Filtros.
2. Revise a aba **Config**: plataforma (PlayStation/Xbox ou PC), margem do FUTBIN: esperas, pausas e limites.
3. Toque em **Iniciar**. Acompanhe pelas abas **Log** e **Compras**.

Cartas compradas sem preço de revenda ficam em **Não atribuídos**.

## Busca por nota ("over") e preço mínimo da busca
O mercado da EA não filtra por nota: o bot busca com os filtros da EA e só compra se a carta tiver a **Nota mínima** do alvo.
Como cada busca traz só ~20 anúncios, use **Buscar a partir de** para deixar de fora as cartas baratas.
Ex.: qualquer ouro 85+ por até 2.400 → Jogador vazio, Nível **Ouro**, Nota mínima **85**, Compra até **2400**, Buscar a partir de **1800**.

## Sniper de técnicos
No **Novo alvo**, escolha **👔 Técnico**. Filtros iguais aos da aba *Managers* do Web App: nível (bronze/prata/ouro), país e liga.
Para um técnico específico: no Web App vá em **Transferências → Managers**, digite o nome, faça a busca e toque em **Usar última busca** (ou crie o alvo logo depois da busca).
O bot só compra cartas de técnico: jogadores e consumíveis que aparecerem são ignorados, e liga e país são conferidos antes de comprar.

## Consumível: liga de técnico
No Web App: **Transferências → Consumables → Manager Leagues**, escolha a liga e abra o ⚡ — o Novo alvo vem como **🏆 Liga de técnico** com a liga preenchida (ou escolha à mão no Novo alvo).
O bot só compra o consumível de liga de técnico: ignora jogadores, técnicos e estilos de química, e confere a liga de cada carta (se não der para confirmar, não compra).

## SBC pela solução do FUTBIN (aba 🧩 SBC)
O script também funciona no **futbin.com** (no Safari, com o mesmo Userscripts). Ele não busca nada no FUTBIN sozinho: só lê a página que você abriu.
1. No FUTBIN, abra o SBC e a **solução mais barata**. Toque no selo verde até aparecerem os **preços** (o script usa o preço de console, a primeira linha).
2. Toque no botão verde **🧩 Enviar ao bot** (canto inferior esquerdo). Ele mostra os jogadores lidos e copia um código.
3. No Web App da EA: ⚡ → aba **🧩 SBC** → **📋 Colar solução do FUTBIN** (se o Safari não deixar colar sozinho, toque e segure no campo → Colar → **Importar código colado**).
4. Confira a lista: desmarque quem não quer comprar e ajuste **Pagar até**. Opcional: **🏠 Conferir no clube** (marca quem você já tem), **💲 Preço atual dos marcados** e **Usar o preço atual como "pagar até"**.
5. **🎯 Criar alvos no sniper**: um alvo por jogador, 1 carta, **só aquela versão e aquela nota**, sem revenda (a carta fica em Não atribuídos). Se quiser, seus outros alvos ficam pausados até você tocar em **Reativar meus alvos pausados**.
6. Toque em **Iniciar**. Cada alvo do SBC se desliga sozinho quando a carta é comprada.

Para o script funcionar no FUTBIN, o Userscripts precisa ter permissão em futbin.com (Ajustes → Safari → Extensões → Userscripts → Outros sites: Permitir).

## Lucro, lances e venda (abas 💰 Lucro, 🔨 Lances e 🏷️ Vender)
- **Lucro:** cada compra do bot entra no registro com o preço pago. Compras antigas entram pelo "Item bought for" quando a carta está na lista de transferências ou em Não atribuídos (botão *Atualizar*, ou automaticamente sempre que você abre a lista de transferências no Web App). Quando a carta aparece como vendida, o lucro é calculado: venda − 5% da EA − preço pago. Cartas vendidas e já removidas com "Limpar vendidos" antes do registro não dá para recuperar. O registro fica salvo no navegador e vai acumulando (limpar a lista de transferências não apaga nada). Dá para filtrar por período (hoje, 7 dias, 30 dias, este mês, mês passado, tudo ou datas escolhidas) e ver o lucro por dia; a data da venda é quando o script viu a carta como vendida.
- **Lances em massa:** escolha um alvo (ou a última busca do mercado), o lance máximo por carta, quantos lances e em quanto tempo os leilões devem terminar. O bot busca os leilões que terminam primeiro, dá o menor lance aceito e confere tipo/filtros da carta antes. *Conferir lances* move as cartas ganhas para a lista de transferências e registra o custo.
- **Venda em massa:** carrega as cartas não anunciadas/expiradas (e, se quiser, Não atribuídos), agrupa as iguais ("Você tem 3"), sugere o preço pelo menor "compre já" atual do mercado: o botão **💲 Buscar preço atual de todas** consulta todas as cartas carregadas (até 20 por toque; toque de novo para parar) e **💲 Preço atual** consulta só uma. O preço vai sendo preenchido aos poucos sem apagar a quantidade ou um preço que você já digitou, respeita a faixa de preço da EA e mostra quanto você recebe e o lucro por carta. Você escolhe quantas e por quanto; o bot anuncia uma a uma.
- Se o Web App não deixar o script ler as listas diretamente, ele usa os dados que o próprio Web App carregou: abra **Transferências → Lista de transferências** (ou Não atribuídos/Observação), espere carregar e volte ao painel. Para anunciar, a carta precisa ter aparecido na tela do Web App ao menos uma vez.
- O modo simulação vale para os três módulos.

## Preço nas cartas (botão 💲)
- Os botões ⚡ e 💲 podem ser arrastados: toque, segure e arraste para onde não atrapalhe. A posição fica salva; para voltar ao lugar padrão use **Config → Voltar os botões ⚡ 💲 para o lugar padrão**.
- Acima do botão ⚡ fica o botão azul **💲**. Toque nele com cartas na tela (resultados do mercado, lista de transferências, clube): o script consulta, carta a carta, o **menor "compre já" anunciado agora no mercado da EA** e vai colocando a etiqueta **Agora 2.500** em cada carta conforme encontra. "Agora: sem anúncio" quer dizer que não há nenhuma anunciada.
- Cada toque consulta até 20 cartas, com 0,8–1,6 s entre elas. Cada carta usa de 1 a 3 buscas no mercado, que **contam no limite de buscas da EA** — use com moderação. O botão mostra o progresso (ex.: 3/12); toque de novo para parar.
- O preço fica guardado por 10 minutos (cartas já consultadas não são buscadas de novo). Não funciona enquanto o sniper ou outro módulo estiver rodando.
- A média de mercado da EA foi removida: ela costuma ficar longe do preço real.
- Em **Config → Preço mostrado nas cartas** dá para escolher **FUTBIN**. O FUTBIN protege o site contra acesso automatizado e costuma recusar as consultas (erro 403); o script não tenta contornar essa proteção. Quando o FUTBIN bloqueia, as consultas ficam pausadas por 30 minutos.

## Preços do FUTBIN (quando disponível)
- **Em cada carta na tela** (resultados do mercado, lista de transferências, clube, elenco) aparece uma etiqueta **FUTBIN 17K**. Ela fica **verde** quando a carta está anunciada abaixo do preço do FUTBIN.
- As cartas visíveis são consultadas juntas numa única requisição, e o preço fica guardado por 5 minutos. Se o FUTBIN não aceitar a consulta em lote, o script consulta carta a carta, em fila.
- Dá para desligar as etiquetas em **Config → Mostrar preço do FUTBIN em cima de cada carta**.
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

## Servidor na nuvem (opcional)
Para deixar rodando sem o iPhone ligado: veja [servidor/README.md](servidor/README.md) (Oracle Cloud grátis, configurado só pelo iPhone).
