# Servidor grátis na nuvem (feito só pelo iPhone)

> **Onde paramos (05/10/2026):** conta do Tailscale criada; estava na página *Keys* para gerar a chave (Parte 1, passo 4).
> Próximo: gerar a chave, depois Parte 2 (texto de instalação) e Parte 3 (conta na Oracle). Depois de criar o servidor, falta instalar o bot no Firefox de lá.

Um computador da Oracle Cloud (grátis para sempre no plano "Always Free") com área de trabalho e Firefox.
Você acessa a tela dele pelo iPhone. O que roda lá continua rodando com o celular travado ou desligado.

Peças usadas (todas grátis):
- **Oracle Cloud**: o computador na nuvem.
- **Tailscale**: uma rede privada entre o seu iPhone e o servidor. O servidor não fica aberto para a internet.
- **Windows App** (da Microsoft, na App Store): mostra a tela do servidor no iPhone.

Tempo: uns 30 minutos seus + 15 minutos esperando o servidor se instalar sozinho.

> Dica para todo o passo a passo: os sites da Oracle e do Tailscale funcionam melhor no Safari em modo computador.
> Toque em **aA** (na barra de endereço) → **Solicitar Site de Computador**.

---

## Parte 1: Tailscale (5 min)

1. Abra no Safari: https://login.tailscale.com/start
2. Entre com sua conta Google ou Apple. Se perguntar sobre o uso, escolha **Personal use**. Pule as perguntas que puder.
3. Gere a chave que o servidor vai usar para entrar na sua rede. Abra: https://login.tailscale.com/admin/settings/keys
4. Toque em **Generate auth key…** → deixe tudo como está → **Generate key**.
5. Aparece uma chave que começa com `tskey-auth-`. Toque em **Copy**.
6. Abra o app **Notas**, crie uma nota e cole a chave. Ela só aparece uma vez.

## Parte 2: preparar o texto de instalação (3 min)

1. Copie o texto abaixo e cole numa nota nova do app **Notas**:

```
#!/bin/bash
export SENHA=COLOQUE-SUA-SENHA-AQUI
export TAILSCALE_KEY=COLE-A-CHAVE-DO-TAILSCALE-AQUI
curl -fsSL https://raw.githubusercontent.com/eduhandrade/fc27-autobuyer/main/servidor/instalar.sh | bash
```

2. Troque `COLOQUE-SUA-SENHA-AQUI` por uma senha **só com letras e números**, de 10 caracteres ou mais (ex.: `Fc27Servidor2026`). Não use espaço nem símbolos.
3. Troque `COLE-A-CHAVE-DO-TAILSCALE-AQUI` pela chave da Parte 1.
4. Confira com calma: não pode sobrar espaço antes ou depois do `=`, e o iPhone não pode ter corrigido nenhuma palavra.
5. Anote a senha em outro lugar. Ela será usada para entrar na tela do servidor.

## Parte 3: conta na Oracle Cloud (10 min)

1. Abra: https://signup.cloud.oracle.com
2. Preencha país (**Brazil**), nome e e-mail. Confirme o e-mail pelo link que a Oracle mandar.
3. Crie a senha da Oracle (é diferente da senha do servidor).
4. **Home Region:** escolha **Brazil East (Sao Paulo)**. Não dá para trocar depois.
5. Endereço e cartão de crédito: é só verificação. A Oracle pode reservar cerca de US$ 1 e devolver. No plano grátis nada é cobrado. Cartões de débito ou pré-pagos costumam ser recusados.
6. Termine o cadastro e espere o e-mail dizendo que a conta está pronta (alguns minutos).

## Parte 4: criar o servidor (10 min)

1. Entre em: https://cloud.oracle.com (Safari em modo computador).
2. Toque no menu **☰** (canto superior esquerdo) → **Compute** → **Instances**.
3. Toque em **Create instance** (Criar instância).
4. **Name:** `fc27-servidor`
5. **Image and shape** → **Edit**:
   - **Change image** → **Ubuntu** → escolha **Canonical Ubuntu 24.04** (a que **não** tem "Minimal" no nome) → **Select image**.
   - **Change shape** → **Ampere** → marque **VM.Standard.A1.Flex** → **Number of OCPUs: 2**, **Amount of memory (GB): 12** → **Select shape**.
   - Deve aparecer o selo **Always Free-eligible**. Se não aparecer, algo está diferente: não continue.
6. **Networking:** deixe como está (cria uma rede nova). Confira que **Assign a public IPv4 address** está ligado.
7. **Add SSH keys:** escolha **Generate a key pair for me** e toque em **Save private key** (vai para o app Arquivos; é uma cópia de segurança).
8. Role até o fim e toque em **Show advanced options** → aba **Management** → **Initialization script** → **Paste cloud-init script**.
9. Copie o texto da sua nota da Parte 2 inteiro e cole no campo.
10. Toque em **Create**.

**Se aparecer "Out of capacity" / "Out of host capacity":** falta vaga grátis naquele momento. Tente de novo mais tarde (de madrugada costuma funcionar), ou diminua para **1 OCPU e 6 GB**. Não é erro seu.

11. O servidor fica laranja (**Provisioning**) e depois verde (**Running**). A partir daí ele se instala sozinho por **10 a 20 minutos**.

## Parte 5: acessar pelo iPhone (5 min)

1. Instale o app **Tailscale** da App Store. Entre com a **mesma conta** da Parte 1 e permita a configuração de VPN.
2. Quando a instalação terminar, o **fc27-servidor** aparece na lista do app Tailscale. Se não apareceu, espere mais uns minutos.
3. Toque no **fc27-servidor** e copie o endereço que começa com **100.** (ex.: `100.101.102.103`).
4. Instale o **Windows App** (da Microsoft) na App Store.
5. Abra → **+** → **Adicionar PC**:
   - **Nome do PC:** cole o endereço `100.…`
   - **Conta de usuário** → **Adicionar conta**: usuário `ubuntu`, senha = a da Parte 2.
   - Salve.
6. Toque no PC. Se avisar sobre certificado, toque em **Aceitar** / **Conectar mesmo assim**.
7. Se aparecer uma tela de login do servidor, escolha **Xorg**, digite `ubuntu` e a senha, e toque em **OK**.
8. Pronto: aparece a área de trabalho do servidor. O Firefox fica em **Applications → Internet → Firefox**.

Para conectar outras vezes: o Tailscale precisa estar ligado no iPhone; aí é só abrir o Windows App e tocar no PC.
Ao sair, só feche o app: o servidor continua ligado.

---

## Problemas comuns

- **O servidor não aparece no Tailscale depois de 30 min:** provavelmente a chave ou a senha foi colada errada.
  Na Oracle, abra o servidor → **More actions** → **Terminate** (marque para apagar o disco) e repita a Parte 4 com o texto corrigido.
  A chave do Tailscale só pode ser usada uma vez: gere outra na Parte 1.
- **"Out of capacity":** veja a Parte 4.
- **Tela preta ao conectar:** desconecte, espere 1 minuto e conecte de novo.
- **A Oracle desligou o servidor por falta de uso:** em contas grátis, a Oracle pode recuperar servidores que ficam parados (quase sem uso) por 7 dias. Com o bot rodando isso não deve acontecer.
- **A conexão do Tailscale venceu (depois de uns meses):** em https://login.tailscale.com/admin/machines toque em **…** ao lado do fc27-servidor → **Disable key expiry**.
