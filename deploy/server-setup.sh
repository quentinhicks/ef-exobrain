#!/usr/bin/env bash
# One-shot setup for a fresh Ubuntu VM (Oracle Always Free or anything else).
# Run as the default user (ubuntu) AFTER: tailscale is up, and the repo's
# deploy key (with write access, for the daily backup push) is in ~/.ssh.
#
#   bash server-setup.sh git@github.com:<you>/ef-exobrain.git
set -euo pipefail

REPO_URL="${1:?usage: server-setup.sh <git ssh url>}"
APP_DIR="$HOME/productivity-app"

sudo apt-get update
sudo apt-get install -y python3-venv python3-pip git iptables-persistent

# The app computes the day server-side: the VM's timezone must be YOUR
# timezone or every event shifts (Oracle images default to UTC).
sudo timedatectl set-timezone "${QPA_TZ:-America/Los_Angeles}"

# Oracle's Ubuntu images ship iptables rules that reject most inbound traffic;
# the tailnet interface must be allowed or the phone can't reach Flask.
if ! sudo iptables -C INPUT -i tailscale0 -j ACCEPT 2>/dev/null; then
  sudo iptables -I INPUT -i tailscale0 -j ACCEPT
  sudo netfilter-persistent save
fi

if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$REPO_URL" "$APP_DIR"
fi

python3 -m venv "$HOME/venvs/qpa"
"$HOME/venvs/qpa/bin/pip" install --upgrade pip
# Server needs no pywebview — app.py's import is optional and PT_HEADLESS
# never touches it.
"$HOME/venvs/qpa/bin/pip" install flask gspread google-auth

# Git identity for the daily backup commits.
git -C "$APP_DIR" config user.name "qpa-server"
git -C "$APP_DIR" config user.email "qpa-server@localhost"

sudo cp "$APP_DIR/deploy/productivity.service" /etc/systemd/system/
sudo sed -i "s|__HOME__|$HOME|g" /etc/systemd/system/productivity.service

# Auto-update: a timer pulls main every 5 min and restarts only when CODE
# changed. The one sudo right it needs is that restart — spelled out here
# rather than given as blanket NOPASSWD.
sudo cp "$APP_DIR/deploy/productivity-update.service" \
        "$APP_DIR/deploy/productivity-update.timer" /etc/systemd/system/
sudo sed -i "s|__HOME__|$HOME|g" /etc/systemd/system/productivity-update.service
echo "$(id -un) ALL=(root) NOPASSWD: /usr/bin/systemctl restart productivity" \
  | sudo tee /etc/sudoers.d/qpa-update > /dev/null
sudo chmod 0440 /etc/sudoers.d/qpa-update
sudo visudo -cf /etc/sudoers.d/qpa-update

sudo systemctl daemon-reload
sudo systemctl enable --now productivity
sudo systemctl enable --now productivity-update.timer

echo
echo "Done. Check:  systemctl status productivity"
echo "Auto-update:  systemctl list-timers productivity-update.timer"
echo "Then copy tracker.db + config.json into $APP_DIR and:"
echo "  sudo systemctl restart productivity"
echo "Phone URL:  http://\$(tailscale ip -4):5000  (or the MagicDNS name)"
