#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# Trading Agent — Vollautomatisches Setup Script für Hetzner VPS
# Verwendung: bash <(curl -fsSL https://raw.githubusercontent.com/DEIN_REPO/main/setup.sh)
# ═══════════════════════════════════════════════════════════════════════════════

set -e  # Exit on any error

# ─── Farben ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# ─── Banner ───────────────────────────────────────────────────────────────────
echo -e "${CYAN}"
cat << 'EOF'
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║     🤖 TRADING AI AGENT — SETUP                         ║
║     Hetzner VPS · Docker · Telegram · HTTPS             ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
EOF
echo -e "${NC}"

# ─── Variablen einsammeln ─────────────────────────────────────────────────────
echo -e "${BOLD}${YELLOW}📋 Konfiguration${NC}"
echo ""

read -p "$(echo -e ${BLUE})GitHub Repo URL (oder Enter für manuelles Upload): $(echo -e ${NC})" REPO_URL
read -p "$(echo -e ${BLUE})Domain (z.B. trading.example.de, oder Enter für IP-only): $(echo -e ${NC})" DOMAIN
read -p "$(echo -e ${BLUE})Telegram Bot Token (von @BotFather): $(echo -e ${NC})" TELEGRAM_TOKEN
read -p "$(echo -e ${BLUE})Telegram Chat ID: $(echo -e ${NC})" TELEGRAM_CHAT_ID
read -p "$(echo -e ${BLUE})Initiales Kapital in USD [10000]: $(echo -e ${NC})" INITIAL_BALANCE
INITIAL_BALANCE=${INITIAL_BALANCE:-10000}

echo ""
echo -e "${BOLD}${YELLOW}🔑 Coinbase API (Enter überspringen für Paper Trading)${NC}"
read -p "$(echo -e ${BLUE})Coinbase API Key Name (optional): $(echo -e ${NC})" COINBASE_API_KEY
read -p "$(echo -e ${BLUE})Coinbase API Secret (optional): $(echo -e ${NC})" COINBASE_API_SECRET

echo ""
echo -e "${GREEN}✅ Konfiguration gespeichert. Starte Installation...${NC}"
echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# SCHRITT 1: System vorbereiten
# ═══════════════════════════════════════════════════════════════════════════════
echo -e "${BOLD}${CYAN}[1/8] System aktualisieren...${NC}"
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq \
  curl wget git ufw fail2ban \
  nginx certbot python3-certbot-nginx \
  htop unzip jq \
  build-essential python3  # für better-sqlite3 native compilation

echo -e "${GREEN}  ✓ System aktualisiert${NC}"

# ═══════════════════════════════════════════════════════════════════════════════
# SCHRITT 2: Node.js 20 LTS installieren
# ═══════════════════════════════════════════════════════════════════════════════
echo -e "${BOLD}${CYAN}[2/8] Node.js 20 LTS installieren...${NC}"
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
apt-get install -y -qq nodejs
npm install -g pm2 > /dev/null 2>&1
echo -e "${GREEN}  ✓ Node.js $(node -v) + PM2 $(pm2 -v) installiert${NC}"

# ═══════════════════════════════════════════════════════════════════════════════
# SCHRITT 3: Firewall konfigurieren
# ═══════════════════════════════════════════════════════════════════════════════
echo -e "${BOLD}${CYAN}[3/8] Firewall (UFW) konfigurieren...${NC}"
ufw --force reset > /dev/null 2>&1
ufw default deny incoming > /dev/null 2>&1
ufw default allow outgoing > /dev/null 2>&1
ufw allow ssh > /dev/null 2>&1
ufw allow 80/tcp > /dev/null 2>&1   # HTTP (für certbot)
ufw allow 443/tcp > /dev/null 2>&1  # HTTPS Dashboard
ufw --force enable > /dev/null 2>&1
echo -e "${GREEN}  ✓ Firewall aktiv (SSH, HTTP, HTTPS erlaubt)${NC}"

# ═══════════════════════════════════════════════════════════════════════════════
# SCHRITT 4: Fail2Ban (Brute-Force Schutz)
# ═══════════════════════════════════════════════════════════════════════════════
echo -e "${BOLD}${CYAN}[4/8] Fail2Ban konfigurieren...${NC}"
cat > /etc/fail2ban/jail.local << 'FAIL2BAN'
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 5

[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
FAIL2BAN
systemctl enable fail2ban > /dev/null 2>&1
systemctl start fail2ban > /dev/null 2>&1
echo -e "${GREEN}  ✓ Fail2Ban aktiv${NC}"

# ═══════════════════════════════════════════════════════════════════════════════
# SCHRITT 5: Trading Agent installieren
# ═══════════════════════════════════════════════════════════════════════════════
echo -e "${BOLD}${CYAN}[5/8] Trading Agent installieren...${NC}"

mkdir -p /opt/trading-agent
cd /opt/trading-agent

if [ -n "$REPO_URL" ]; then
  git clone "$REPO_URL" . > /dev/null 2>&1
  echo -e "${GREEN}  ✓ Repository geklont${NC}"
else
  echo -e "${YELLOW}  ⚠ Kein Repo angegeben — bitte Dateien manuell nach /opt/trading-agent kopieren${NC}"
  echo -e "${YELLOW}    Befehl: scp -r ./trading-agent/* root@SERVER_IP:/opt/trading-agent/${NC}"
fi

# .env erstellen
cat > /opt/trading-agent/.env << ENV
# Trading Agent Configuration
# Generiert von setup.sh am $(date)

TRADING_MODE=paper
INITIAL_BALANCE=${INITIAL_BALANCE}
SYMBOLS=BTC-USD,ETH-USD,SOL-USD
MAX_POSITION_SIZE=0.15
RISK_PER_TRADE=0.02
IMPROVEMENT_CYCLE=10
DECISION_INTERVAL=60000
DASHBOARD_PORT=3000

TELEGRAM_BOT_TOKEN=${TELEGRAM_TOKEN}
TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID}
DAILY_REPORT_TIME=08:00

$([ -n "$COINBASE_API_KEY" ] && echo "COINBASE_API_KEY=${COINBASE_API_KEY}" || echo "# COINBASE_API_KEY=")
$([ -n "$COINBASE_API_SECRET" ] && echo "COINBASE_API_SECRET=${COINBASE_API_SECRET}" || echo "# COINBASE_API_SECRET=")
ENV

chmod 600 /opt/trading-agent/.env  # Nur root lesbar

# Dependencies installieren (wenn package.json vorhanden)
if [ -f "package.json" ]; then
  npm install --production > /dev/null 2>&1
  echo -e "${GREEN}  ✓ npm packages installiert${NC}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# SCHRITT 6: PM2 Prozessmanager konfigurieren
# ═══════════════════════════════════════════════════════════════════════════════
echo -e "${BOLD}${CYAN}[6/8] PM2 konfigurieren...${NC}"

cat > /opt/trading-agent/ecosystem.config.js << 'PM2CONFIG'
module.exports = {
  apps: [{
    name: 'trading-agent',
    script: 'index.js',
    cwd: '/opt/trading-agent',
    env_file: '/opt/trading-agent/.env',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    restart_delay: 5000,
    max_restarts: 10,
    log_file: '/var/log/trading-agent/combined.log',
    out_file: '/var/log/trading-agent/out.log',
    error_file: '/var/log/trading-agent/error.log',
    time: true,
  }]
};
PM2CONFIG

mkdir -p /var/log/trading-agent

# PM2 starten und für Autostart registrieren
if [ -f "/opt/trading-agent/index.js" ]; then
  cd /opt/trading-agent
  pm2 start ecosystem.config.js > /dev/null 2>&1
  pm2 save > /dev/null 2>&1
  pm2 startup systemd -u root --hp /root > /dev/null 2>&1 | bash > /dev/null 2>&1 || true
  echo -e "${GREEN}  ✓ Trading Agent läuft (PM2)${NC}"
else
  echo -e "${YELLOW}  ⚠ index.js nicht gefunden — PM2 nach dem Upload starten:${NC}"
  echo -e "${YELLOW}    cd /opt/trading-agent && pm2 start ecosystem.config.js${NC}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# SCHRITT 7: Nginx + HTTPS konfigurieren
# ═══════════════════════════════════════════════════════════════════════════════
echo -e "${BOLD}${CYAN}[7/8] Nginx + HTTPS konfigurieren...${NC}"

SERVER_IP=$(curl -s ifconfig.me)

if [ -n "$DOMAIN" ]; then
  # Mit Domain + Let's Encrypt SSL
  cat > /etc/nginx/sites-available/trading-agent << NGINX
server {
    listen 80;
    server_name ${DOMAIN};
    
    # Let's Encrypt challenge
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }
    
    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name ${DOMAIN};
    
    # SSL wird von certbot ergänzt
    
    # Security Headers
    add_header X-Frame-Options "SAMEORIGIN";
    add_header X-Content-Type-Options "nosniff";
    add_header X-XSS-Protection "1; mode=block";
    add_header Strict-Transport-Security "max-age=31536000" always;
    
    # Basic Auth (Passwortschutz für Dashboard)
    auth_basic "Trading Agent";
    auth_basic_user_file /etc/nginx/.htpasswd;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_cache_bypass \$http_upgrade;
    }
    
    # API ohne Cache
    location /api/ {
        proxy_pass http://localhost:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        add_header Cache-Control "no-cache, no-store";
    }
}
NGINX

  ln -sf /etc/nginx/sites-available/trading-agent /etc/nginx/sites-enabled/
  rm -f /etc/nginx/sites-enabled/default
  nginx -t > /dev/null 2>&1 && systemctl reload nginx > /dev/null 2>&1

  # Basic Auth Passwort generieren
  DASHBOARD_PASS=$(openssl rand -base64 12)
  echo "trader:$(openssl passwd -apr1 $DASHBOARD_PASS)" > /etc/nginx/.htpasswd
  chmod 600 /etc/nginx/.htpasswd

  # SSL Zertifikat anfordern
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
    --email "admin@${DOMAIN}" --redirect > /dev/null 2>&1 && \
    echo -e "${GREEN}  ✓ HTTPS Zertifikat installiert${NC}" || \
    echo -e "${YELLOW}  ⚠ SSL fehlgeschlagen — DNS Check: Domain muss auf ${SERVER_IP} zeigen${NC}"

else
  # Ohne Domain — nur HTTP mit IP
  cat > /etc/nginx/sites-available/trading-agent << NGINX
server {
    listen 80;
    server_name _;
    
    auth_basic "Trading Agent";
    auth_basic_user_file /etc/nginx/.htpasswd;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }
}
NGINX

  ln -sf /etc/nginx/sites-available/trading-agent /etc/nginx/sites-enabled/
  rm -f /etc/nginx/sites-enabled/default
  
  DASHBOARD_PASS=$(openssl rand -base64 12)
  echo "trader:$(openssl passwd -apr1 $DASHBOARD_PASS)" > /etc/nginx/.htpasswd
  chmod 600 /etc/nginx/.htpasswd
  
  nginx -t > /dev/null 2>&1 && systemctl reload nginx > /dev/null 2>&1
  echo -e "${GREEN}  ✓ Nginx konfiguriert (HTTP)${NC}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# SCHRITT 8: Log Rotation einrichten
# ═══════════════════════════════════════════════════════════════════════════════
echo -e "${BOLD}${CYAN}[8/8] Log Rotation konfigurieren...${NC}"

cat > /etc/logrotate.d/trading-agent << 'LOGROTATE'
/var/log/trading-agent/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    create 0640 root root
}
LOGROTATE

# PM2 log rotation
pm2 install pm2-logrotate > /dev/null 2>&1 || true
echo -e "${GREEN}  ✓ Log Rotation aktiv (14 Tage)${NC}"

# ═══════════════════════════════════════════════════════════════════════════════
# FERTIG — Zusammenfassung
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo -e "${GREEN}${BOLD}"
cat << 'EOF'
╔══════════════════════════════════════════════════════════╗
║         ✅ SETUP ERFOLGREICH ABGESCHLOSSEN!             ║
╚══════════════════════════════════════════════════════════╝
EOF
echo -e "${NC}"

if [ -n "$DOMAIN" ]; then
  DASHBOARD_URL="https://${DOMAIN}"
else
  DASHBOARD_URL="http://${SERVER_IP}"
fi

echo -e "${BOLD}📊 Dashboard:${NC}     ${CYAN}${DASHBOARD_URL}${NC}"
echo -e "${BOLD}👤 Login:${NC}         ${CYAN}trader / ${DASHBOARD_PASS}${NC}"
echo -e "${BOLD}📱 Telegram:${NC}      ${CYAN}Bot konfiguriert — schreibe /status${NC}"
echo -e "${BOLD}📁 Agent Pfad:${NC}    ${CYAN}/opt/trading-agent${NC}"
echo -e "${BOLD}📋 Logs:${NC}          ${CYAN}pm2 logs trading-agent${NC}"
echo ""
echo -e "${YELLOW}${BOLD}📱 iPhone Setup:${NC}"
echo -e "  1. Safari öffnen → ${DASHBOARD_URL}"
echo -e "  2. Teilen-Button → 'Zum Home-Bildschirm'"
echo -e "  3. Telegram öffnen → deinen Bot anschreiben"
echo -e "  4. Schreibe /hilfe für alle Befehle"
echo ""
echo -e "${YELLOW}${BOLD}🔧 Nützliche Befehle:${NC}"
echo -e "  ${CYAN}pm2 status${NC}                    # Agent Status"
echo -e "  ${CYAN}pm2 logs trading-agent${NC}        # Live Logs"
echo -e "  ${CYAN}pm2 restart trading-agent${NC}     # Neustart"
echo -e "  ${CYAN}nano /opt/trading-agent/.env${NC}  # Konfiguration"
echo ""
echo -e "${RED}${BOLD}⚠️  WICHTIG:${NC}"
echo -e "  Dashboard-Passwort notieren: ${BOLD}${DASHBOARD_PASS}${NC}"
echo -e "  Gespeichert in: /etc/nginx/.htpasswd"
echo ""
echo -e "${GREEN}Trading Agent läuft! 🚀${NC}"
