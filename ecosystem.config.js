/**
 * PM2 Ecosystem Config
 * Liest .env selbst ein und übergibt alle Variablen direkt an PM2.
 * Funktioniert mit jeder PM2-Version, unabhängig von env_file Support.
 */

const fs   = require('fs');
const path = require('path');

// .env manuell parsen — kein dotenv nötig
const ENV_PATH = path.join(__dirname, '.env');
const env = {};

if (fs.existsSync(ENV_PATH)) {
  fs.readFileSync(ENV_PATH, 'utf8')
    .split('\n')
    .forEach(line => {
      // Kommentare und leere Zeilen überspringen
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;

      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) return;

      const key   = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim()
        // Anführungszeichen entfernen falls vorhanden: KEY="value" → value
        .replace(/^["']|["']$/g, '');

      if (key) env[key] = value;
    });
} else {
  console.error('⚠️  WARNUNG: .env Datei nicht gefunden unter', ENV_PATH);
}

module.exports = {
  apps: [{
    name:               'trading-agent',
    script:             'index.js',
    cwd:                __dirname,
    instances:          1,
    autorestart:        true,
    watch:              false,
    max_memory_restart: '512M',
    restart_delay:      5000,
    max_restarts:       10,
    log_file:           '/var/log/trading-agent/combined.log',
    out_file:           '/var/log/trading-agent/out.log',
    error_file:         '/var/log/trading-agent/error.log',
    time:               true,

    // Alle .env Variablen direkt übergeben — kein env_file, kein dotenv nötig
    env: {
      NODE_ENV: 'production',
      ...env,
    },
  }],
};
