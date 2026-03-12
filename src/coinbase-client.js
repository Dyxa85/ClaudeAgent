/**
 * CoinbaseClient — Einziger Client für Paper und Live Trading
 *
 * Marktdaten (Ticker, Candles, Orderbook, Fees) → immer echte Coinbase API
 * Order-Ausführung:
 *   paper mode → simuliert mit echtem Spread + echten Fees aus dem Orderbook
 *   live mode  → echter signed API-Call
 *
 * Kein Mock, kein Fallback, keine Zufallsdaten.
 * Wenn die API nicht erreichbar ist, wirft der Client einen Fehler —
 * der Agent pausiert den Zyklus und versucht es beim nächsten Intervall.
 */

'use strict';

const BASE_URL = 'https://api.coinbase.com/api/v3';

class CoinbaseClient {
  constructor(config = {}) {
    this.apiKey    = config.apiKey    || process.env.COINBASE_API_KEY    || null;
    this.apiSecret = config.apiSecret || process.env.COINBASE_API_SECRET || null;
    this.isPaper   = config.isPaper   ?? (process.env.TRADING_MODE !== 'live');

    // Rate-limit: max 10 req/s auf Public, 30 req/s auf Private
    this._queue       = [];
    this._processing  = false;
    this._lastRequest = 0;
    this._minInterval = 120; // ms zwischen Requests (konservativ)

    if (this.isPaper) {
      console.log('📄 Coinbase Client: PAPER MODE — echte Marktdaten, simulierte Orders');
    } else {
      if (!this.apiKey || !this.apiSecret) {
        throw new Error('COINBASE_API_KEY und COINBASE_API_SECRET müssen für Live-Trading gesetzt sein');
      }
      console.log('🔴 Coinbase Client: LIVE MODE — echte Orders werden platziert!');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MARKTDATEN — immer öffentliche API, kein Auth nötig
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Aktueller Ticker mit Bid/Ask Spread
   * GET /brokerage/products/{product_id}
   */
  async getTicker(productId) {
    const data = await this._get(`/brokerage/products/${productId}`);
    const price = parseFloat(data.price);
    const bid   = parseFloat(data.best_bid);
    const ask   = parseFloat(data.best_ask);
    if (!price || price <= 0) throw new Error(`Ungültiger Preis für ${productId}: ${data.price}`);
    return {
      symbol:           productId,
      price,
      bid,
      ask,
      spread:           ask - bid,
      spread_pct:       parseFloat(((ask - bid) / price * 100).toFixed(4)),
      volume_24h:       parseFloat(data.volume_24_h),
      price_change_24h: parseFloat(data.price_percentage_change_24h),
      timestamp:        new Date().toISOString(),
    };
  }

  /**
   * OHLCV Candles für technische Analyse
   * GET /brokerage/products/{product_id}/candles
   */
  async getCandles(productId, granularity = 'ONE_HOUR', limit = 100) {
    const seconds = {
      ONE_MINUTE: 60, FIVE_MINUTE: 300, FIFTEEN_MINUTE: 900,
      ONE_HOUR: 3600, FOUR_HOUR: 14400, ONE_DAY: 86400,
    }[granularity];
    if (!seconds) throw new Error(`Ungültige Granularität: ${granularity}`);

    const end   = Math.floor(Date.now() / 1000);
    const start = end - seconds * limit;

    const data = await this._get(
      `/brokerage/products/${productId}/candles?start=${start}&end=${end}&granularity=${granularity}`
    );

    const candles = (data.candles || []).map(c => ({
      timestamp: parseInt(c.start),
      open:      parseFloat(c.open),
      high:      parseFloat(c.high),
      low:       parseFloat(c.low),
      close:     parseFloat(c.close),
      volume:    parseFloat(c.volume),
    })).reverse(); // älteste zuerst

    if (candles.length === 0) throw new Error(`Keine Candle-Daten für ${productId}`);
    return candles;
  }

  /**
   * Orderbook — Level 2 (beste Bids/Asks)
   * GET /brokerage/products/{product_id}/book
   *
   * Wichtig für Paper-Mode: wir simulieren Slippage anhand echter Orderbuch-Tiefe
   */
  async getOrderBook(productId, limit = 10) {
    const data = await this._get(`/brokerage/products/${productId}/book?limit=${limit}`);
    return {
      bids: (data.bids || []).map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) })),
      asks: (data.asks || []).map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) })),
    };
  }

  /**
   * Produkt-Infos (min. Ordergröße, Tick-Size etc.)
   * GET /brokerage/products/{product_id}
   */
  async getProductInfo(productId) {
    const data = await this._get(`/brokerage/products/${productId}`);
    return {
      symbol:          data.product_id,
      base_currency:   data.base_currency_id,
      quote_currency:  data.quote_currency_id,
      base_min_size:   parseFloat(data.base_min_size  || 0.000001),
      base_max_size:   parseFloat(data.base_max_size  || 999999),
      quote_min_size:  parseFloat(data.quote_min_size || 1),
      base_increment:  parseFloat(data.base_increment || 0.000001),
      price_increment: parseFloat(data.price_increment || 0.01),
      trading_disabled: data.trading_disabled || false,
      status:          data.status,
    };
  }

  /**
   * Fee-Tier des Accounts
   * GET /brokerage/transaction_summary  (benötigt Auth für echtes Tier)
   *
   * Ohne API-Key: Coinbase Tier-1 (0.60% Taker) — konservativster Wert
   * Mit API-Key:  echtes Tier aus dem Account
   *
   * Coinbase Advanced Trade Fee-Tiers (2024):
   *   Tier 1: $0–$10k/30d       → Taker 0.60%, Maker 0.40%
   *   Tier 2: $10k–$50k/30d     → Taker 0.40%, Maker 0.20%
   *   Tier 3: $50k–$100k/30d    → Taker 0.25%, Maker 0.15%
   *   Tier 4: $100k–$1M/30d     → Taker 0.20%, Maker 0.10%
   *   Tier 5: $1M+/30d          → Taker 0.10%, Maker 0.05%
   */
  async getFeeRate() {
    if (this.apiKey && this.apiSecret) {
      try {
        const data = await this._signedGet('/brokerage/transaction_summary');
        const tier = data.fee_tier || {};
        return {
          taker:    parseFloat(tier.taker_fee_rate || 0.006),
          maker:    parseFloat(tier.maker_fee_rate || 0.004),
          tier:     tier.pricing_tier       || 'tier_1',
          usd_from: tier.usd_from           || '0',
          usd_to:   tier.usd_to             || '10000',
          source:   'coinbase_api_authenticated',
        };
      } catch (err) {
        console.warn(`⚠️  Fee-Tier konnte nicht geladen werden: ${err.message}`);
      }
    }

    // Kein API-Key → Tier 1 (realistisch für neue Accounts)
    return {
      taker:  0.006,
      maker:  0.004,
      tier:   'tier_1',
      usd_from: '0',
      usd_to:   '10000',
      source: 'coinbase_published_schedule',
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ORDER-AUSFÜHRUNG
  // Paper Mode: simuliert mit echtem Spread + Slippage aus dem Orderbook
  // Live Mode:  echter signed API-Call
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Market Order ausführen
   * @param {string} productId  z.B. 'BTC-USD'
   * @param {string} side       'BUY' | 'SELL'
   * @param {number} quoteSize  Betrag in USD (z.B. 500)
   * @param {number} feeRate    Taker-Fee (z.B. 0.006)
   * @returns {OrderResult}
   */
  async executeMarketOrder({ productId, side, quoteSize, feeRate = 0.006 }) {
    if (this.isPaper) {
      return await this._simulatePaperOrder({ productId, side, quoteSize, feeRate });
    } else {
      return await this._executeLiveOrder({ productId, side, quoteSize });
    }
  }

  /**
   * PAPER ORDER: simuliert mit echtem Orderbook
   *
   * Wie eine echte Market Order ausgeführt wird:
   * - BUY:  wir kaufen zum ASK-Preis (höher als Mitte) + Slippage für große Orders
   * - SELL: wir verkaufen zum BID-Preis (niedriger als Mitte) + Slippage
   * - Fee:  wird auf den Bruttobetrag berechnet, vom Nettobetrag abgezogen
   */
  async _simulatePaperOrder({ productId, side, quoteSize, feeRate }) {
    // Echtes Orderbook holen für realistische Preis-Simulation
    const [ticker, orderbook] = await Promise.all([
      this.getTicker(productId),
      this.getOrderBook(productId, 5),
    ]);

    const isBuy    = side.toUpperCase() === 'BUY';
    const levels   = isBuy ? orderbook.asks : orderbook.bids;

    // Slippage: simuliere wie weit wir ins Buch gehen müssen
    let fillPrice     = isBuy ? ticker.ask : ticker.bid;
    let remainingUSD  = quoteSize;
    let totalBaseFill = 0;
    let totalUSDSpent = 0;

    for (const level of levels) {
      if (remainingUSD <= 0) break;
      const levelUSD  = level.price * level.size;
      const usedUSD   = Math.min(remainingUSD, levelUSD);
      const baseFill  = usedUSD / level.price;
      totalBaseFill  += baseFill;
      totalUSDSpent  += usedUSD;
      remainingUSD   -= usedUSD;
      fillPrice       = level.price; // schlechtester Fill-Preis
    }

    // Falls Orderbook nicht tief genug: letzten Preis + 0.1% Slippage
    if (remainingUSD > 0) {
      const slippagePrice = fillPrice * (isBuy ? 1.001 : 0.999);
      totalBaseFill      += remainingUSD / slippagePrice;
      totalUSDSpent      += remainingUSD;
      fillPrice           = slippagePrice;
    }

    const avgFillPrice = totalUSDSpent / totalBaseFill;
    const fee          = quoteSize * feeRate;
    const netBase      = isBuy  ? (quoteSize - fee) / avgFillPrice : totalBaseFill;
    const netUSD       = !isBuy ? (quoteSize - fee)                : quoteSize;

    return {
      order_id:          `paper_${Date.now()}`,
      product_id:        productId,
      side:              side.toUpperCase(),
      status:            'FILLED',
      is_paper:          true,
      quote_size:        quoteSize.toFixed(2),
      avg_fill_price:    parseFloat(avgFillPrice.toFixed(2)),
      filled_base:       parseFloat((isBuy ? netBase : totalBaseFill).toFixed(8)),
      filled_quote:      parseFloat(netUSD.toFixed(2)),
      fee:               parseFloat(fee.toFixed(6)),
      fee_rate:          feeRate,
      slippage_pct:      parseFloat(
        (Math.abs(avgFillPrice - (isBuy ? ticker.ask : ticker.bid)) / ticker.price * 100).toFixed(4)
      ),
      created_at:        new Date().toISOString(),
    };
  }

  /**
   * LIVE ORDER: echter signed API-Call + Polling bis Fill oder Fehler
   * POST /brokerage/orders → poll GET /brokerage/orders/historical/{id}
   */
  async _executeLiveOrder({ productId, side, quoteSize }) {
    const order = {
      client_order_id: `agent_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      product_id:      productId,
      side:            side.toUpperCase(),
      order_configuration: {
        market_market_ioc: {
          quote_size: quoteSize.toFixed(2),
        },
      },
    };

    const data = await this._signedPost('/brokerage/orders', order);

    if (!data.success) {
      throw new Error(`Live order failed: ${JSON.stringify(data.error_response)}`);
    }

    const r = data.success_response;
    // Warten bis Order tatsächlich gefüllt ist (max. 30s)
    return await this._pollOrderStatus(r.order_id, 30000, quoteSize);
  }

  /**
   * Pollt Order-Status bis FILLED, CANCELLED, FAILED oder Timeout (30s).
   * Gibt dasselbe Format zurück wie _simulatePaperOrder, damit der Agent
   * in Paper und Live identisch arbeitet.
   */
  async _pollOrderStatus(orderId, maxWaitMs = 30000, quoteSize = 0) {
    const start        = Date.now();
    const pollInterval = 2000;

    while (Date.now() - start < maxWaitMs) {
      await new Promise(r => setTimeout(r, pollInterval));

      try {
        const data  = await this._signedGet(`/brokerage/orders/historical/${orderId}`);
        const order = data.order;
        if (!order) continue;

        if (order.status === 'FILLED') {
          const filledBase  = parseFloat(order.filled_size  || 0);
          const filledQuote = parseFloat(order.filled_value || 0);
          const avgFill     = filledBase > 0 ? filledQuote / filledBase : 0;
          const fee         = parseFloat(order.total_fees   || 0);

          return {
            order_id:       orderId,
            product_id:     order.product_id,
            side:           order.side,
            status:         'FILLED',
            is_paper:       false,
            quote_size:     quoteSize,
            avg_fill_price: parseFloat(avgFill.toFixed(2)),
            filled_base:    parseFloat(filledBase.toFixed(8)),
            filled_quote:   parseFloat(filledQuote.toFixed(2)),
            fee:            parseFloat(fee.toFixed(6)),
            fee_rate:       filledQuote > 0 ? fee / filledQuote : 0,
            slippage_pct:   0,
            created_at:     order.created_time,
          };
        }

        if (['CANCELLED', 'FAILED', 'EXPIRED'].includes(order.status)) {
          throw new Error(`Order ${orderId} fehlgeschlagen mit Status: ${order.status}`);
        }
      } catch (err) {
        if (err.message.includes('fehlgeschlagen mit Status')) throw err;
        // Netzwerkfehler → nächster Versuch
      }
    }

    throw new Error(`Order ${orderId} Polling Timeout nach ${maxWaitMs}ms — Order-Status manuell prüfen`);
  }

  /**
   * Order-Status abfragen (Live Mode)
   */
  async getOrder(orderId) {
    return await this._signedGet(`/brokerage/orders/historical/${orderId}`);
  }

  /**
   * Account-Balances (Live Mode)
   */
  async getAccounts() {
    return (await this._signedGet('/brokerage/accounts')).accounts || [];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HTTP-LAYER — mit Rate-Limiting
  // ═══════════════════════════════════════════════════════════════════════════

  async _get(path) {
    return this._request(path, 'GET', null, false);
  }

  async _signedGet(path) {
    return this._request(path, 'GET', null, true);
  }

  async _signedPost(path, body) {
    return this._request(path, 'POST', body, true);
  }

  async _request(path, method, body, signed) {
    // Rate-Limiting: min. 120ms zwischen Requests
    const now  = Date.now();
    const wait = this._minInterval - (now - this._lastRequest);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this._lastRequest = Date.now();

    const url     = `${BASE_URL}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent':   'TradingAgent/1.0',
    };

    if (signed) {
      if (!this.apiKey || !this.apiSecret) {
        throw new Error('API-Key fehlt für authenticated request');
      }
      const jwt = await this._generateJWT(method, path);
      headers['Authorization'] = `Bearer ${jwt}`;
    }

    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Coinbase API ${res.status} auf ${method} ${path}: ${text.slice(0, 200)}`);
    }

    return res.json();
  }

  /**
   * JWT für Coinbase Advanced Trade API
   * Coinbase nutzt ES256 (ECDSA P-256)
   */
  async _generateJWT(method, path) {
    const { createSign, createPrivateKey } = await import('crypto');

    const keyId    = this.apiKey;
    const secret   = this.apiSecret;
    const now      = Math.floor(Date.now() / 1000);
    const uri      = `${method.toUpperCase()} api.coinbase.com${path.split('?')[0]}`;

    const header  = Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId, nonce: now.toString() })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: keyId, iss: 'cdp', nbf: now, exp: now + 120, uri })).toString('base64url');
    const sigInput = `${header}.${payload}`;

    // PEM-Format sicherstellen
    const pemKey = secret.includes('-----BEGIN')
      ? secret
      : `-----BEGIN EC PRIVATE KEY-----\n${secret}\n-----END EC PRIVATE KEY-----`;

    const sign = createSign('SHA256');
    sign.update(sigInput);
    const derSig   = sign.sign(createPrivateKey(pemKey));
    const r        = derSig.slice(4, 4 + derSig[3]);
    const sOffset  = 4 + derSig[3] + 2;
    const s        = derSig.slice(sOffset, sOffset + derSig[sOffset - 1]);
    const pad      = v => v.length < 32 ? Buffer.concat([Buffer.alloc(32 - v.length), v]) : v.slice(-32);
    const signature = Buffer.concat([pad(r), pad(s)]).toString('base64url');

    return `${sigInput}.${signature}`;
  }
}

module.exports = { CoinbaseClient };
