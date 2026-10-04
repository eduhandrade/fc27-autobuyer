#!/bin/bash
# Prepara um servidor Ubuntu da Oracle Cloud (Always Free, ARM) com área de
# trabalho acessível pelo iPhone (app Windows App) através do Tailscale.
# Roda sozinho na primeira vez que o servidor liga (script de inicialização).
#
# Variáveis esperadas:
#   SENHA          senha para entrar na área de trabalho (só letras e números)
#   TAILSCALE_KEY  chave de autenticação do Tailscale (tskey-auth-...)
#
# Andamento: /var/log/fc27-instalar.log

set -euo pipefail
exec > >(tee -a /var/log/fc27-instalar.log) 2>&1
echo "== Início: $(date)"

USUARIO=ubuntu
NOME=fc27-servidor
export DEBIAN_FRONTEND=noninteractive
APT="apt-get -y -o DPkg::Lock::Timeout=900"

if [ -z "${SENHA:-}" ] || [ "$SENHA" = "COLOQUE-SUA-SENHA-AQUI" ]; then
  echo "ERRO: faltou trocar a SENHA no script de inicialização." >&2
  exit 1
fi
if [ -z "${TAILSCALE_KEY:-}" ] || [ "${TAILSCALE_KEY#tskey-}" = "$TAILSCALE_KEY" ]; then
  echo "ERRO: faltou colar a chave do Tailscale (começa com tskey-)." >&2
  exit 1
fi

hostnamectl set-hostname "$NOME"
timedatectl set-timezone America/Sao_Paulo || true

# Área de trabalho leve (XFCE) e servidor de acesso remoto (RDP).
$APT update
$APT install xfce4 xfce4-terminal dbus-x11 xrdp fonts-noto-color-emoji language-pack-pt

echo "$USUARIO:$SENHA" | chpasswd
echo xfce4-session > "/home/$USUARIO/.xsession"
chown "$USUARIO:$USUARIO" "/home/$USUARIO/.xsession"
adduser xrdp ssl-cert
systemctl enable xrdp
systemctl restart xrdp

# Navegador.
snap wait system seed.loaded || true
snap install firefox

# O Ubuntu da Oracle bloqueia conexões de fora, menos SSH. Libera só o que
# chega pelo Tailscale (rede privada sua); a internet aberta continua bloqueada.
if ! iptables -C INPUT -i tailscale0 -j ACCEPT 2>/dev/null; then
  iptables -I INPUT 1 -i tailscale0 -j ACCEPT
fi
if command -v netfilter-persistent >/dev/null; then
  netfilter-persistent save
fi

# Tailscale por último: quando o servidor aparecer no app, já está pronto.
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --authkey="$TAILSCALE_KEY" --hostname="$NOME"

echo "== Pronto: $(date)"
echo "Endereço no Tailscale: $(tailscale ip -4 || true)"
