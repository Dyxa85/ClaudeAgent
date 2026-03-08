/**
 * Coinbase MCP Integration
 * Connects to Coinbase Advanced Trade API via MCP Server
 */

class CoinbaseMCPClient {
  constructor(config = {}) {
    this.apiKey = config.apiKey || process.env.COINBASE_API_KEY;
    this.apiSecret = config.apiSecret || process.env.COINBASE_API_SECRET;
    this.sandboxMode = config.sandboxMode || true;
    
    // MCP Server endpoint (Coinbase Advanced Trade MCP)
    this.mcpUrl = this.sandboxMode 
      ? 'https://api-public.sandbox.exchange.coinbase.com'
      : 'https://api.exchange.coinbase.com';
      
    this.baseUrl = 'https://api.coinbase.com/api/v3';
  }

  /**
   * Get product ticker / current price
   */
  async getProductTicker(productId) {
    const response = await this.request(`/brokerage/products/${productId}`);
    return {
      symbol: productId,
      price: parseFloat(response.price),
      bid: parseFloat(response.best_bid),
      ask: parseFloat(response.best_ask),
      volume_24h: parseFloat(response.volume_24_h),
      price_change_24h: parseFloat(response.price_percentage_change_24h)
    };
  }

  /**
   * Get candles / OHLCV data for technical analysis
   */
  async getCandles(productId, granularity = 'ONE_HOUR', limit = 100) {
    const end = Math.floor(Date.now() / 1000);
    const granularitySeconds = {
      'ONE_MINUTE': 60,
      'FIVE_MINUTE': 300,
      'FIFTEEN_MINUTE': 900,
      'ONE_HOUR': 3600,
      'FOUR_HOUR': 14400,
      'ONE_DAY': 86400
    }[granularity] || 3600;
    
    const start = end - (granularitySeconds * limit);
    
    const response = await this.request(
      `/brokerage/products/${productId}/candles?start=${start}&end=${end}&granularity=${granularity}`
    );
    
    return (response.candles || []).map(c => ({
      timestamp: parseInt(c.start),
      open: parseFloat(c.open),
      high: parseFloat(c.high),
      low: parseFloat(c.low),
      close: parseFloat(c.close),
      volume: parseFloat(c.volume)
    })).reverse();
  }

  /**
   * Get order book
   */
  async getOrderBook(productId, limit = 10) {
    const response = await this.request(
      `/brokerage/products/${productId}/book?limit=${limit}`
    );
    return {
      bids: response.bids || [],
      asks: response.asks || []
    };
  }

  /**
   * Get account balances (LIVE mode only)
   */
  async getAccounts() {
    const response = await this.signedRequest('/brokerage/accounts');
    return response.accounts || [];
  }

  /**
   * Place market order (LIVE mode only)
   */
  async placeMarketOrder({ productId, side, quoteSize }) {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error('API credentials required for live trading');
    }

    const order = {
      client_order_id: `trading-agent-${Date.now()}`,
      product_id: productId,
      side: side.toUpperCase(), // BUY or SELL
      order_configuration: {
        market_market_ioc: {
          quote_size: quoteSize.toString()
        }
      }
    };

    return await this.signedRequest('/brokerage/orders', 'POST', order);
  }

  /**
   * Place limit order (LIVE mode only)
   */
  async placeLimitOrder({ productId, side, baseSize, limitPrice, postOnly = false }) {
    const order = {
      client_order_id: `trading-agent-${Date.now()}`,
      product_id: productId,
      side: side.toUpperCase(),
      order_configuration: {
        limit_limit_gtc: {
          base_size: baseSize.toString(),
          limit_price: limitPrice.toString(),
          post_only: postOnly
        }
      }
    };

    return await this.signedRequest('/brokerage/orders', 'POST', order);
  }

  /**
   * Get order details
   */
  async getOrder(orderId) {
    return await this.signedRequest(`/brokerage/orders/historical/${orderId}`);
  }

  /**
   * Cancel order
   */
  async cancelOrder(orderId) {
    return await this.signedRequest('/brokerage/orders/batch_cancel', 'POST', {
      order_ids: [orderId]
    });
  }

  /**
   * Get available products/trading pairs
   */
  async getProducts() {
    const response = await this.request('/brokerage/products?product_type=SPOT');
    return response.products || [];
  }

  // Internal HTTP methods
  async request(path, method = 'GET', body = null) {
    const url = `${this.baseUrl}${path}`;
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'TradingAgent/1.0'
      }
    };

    if (body) options.body = JSON.stringify(body);

    const res = await fetch(url, options);
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Coinbase API error ${res.status}: ${err}`);
    }
    return res.json();
  }

  async signedRequest(path, method = 'GET', body = null) {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error('COINBASE_API_KEY and COINBASE_API_SECRET must be set in .env');
    }

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const bodyStr = body ? JSON.stringify(body) : '';
    
    // JWT-based auth for Coinbase Advanced Trade API
    const jwt = await this.generateJWT(method, path, timestamp);

    const url = `${this.baseUrl}${path}`;
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${jwt}`,
        'CB-ACCESS-TIMESTAMP': timestamp,
        'User-Agent': 'TradingAgent/1.0'
      }
    };

    if (body) options.body = bodyStr;

    const res = await fetch(url, options);
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Coinbase signed request error ${res.status}: ${err}`);
    }
    return res.json();
  }

  async generateJWT(method, path, timestamp) {
    // Coinbase Advanced Trade uses EC private key JWT
    // In production, use the official coinbase-advanced-py or coinbase SDK
    // This is a placeholder - actual implementation requires proper JWT signing
    const { createSign } = await import('crypto');
    const message = `${timestamp}${method.toUpperCase()}${path}`;
    // Full implementation: sign with ES256 using your API secret key
    return Buffer.from(`${this.apiKey}:${message}`).toString('base64');
  }
}

/**
 * Mock/Simulator for Paper Trading - uses real price data
 */
class CoinbasePaperClient extends CoinbaseMCPClient {
  constructor(config = {}) {
    super({ ...config, sandboxMode: true });
    this.orders = [];
  }

  // Paper trading: use real prices but don't actually place orders
  async placeMarketOrder({ productId, side, quoteSize }) {
    const ticker = await this.getProductTicker(productId);
    const orderId = `paper_${Date.now()}`;
    
    const order = {
      order_id: orderId,
      product_id: productId,
      side,
      quote_size: quoteSize,
      filled_size: (parseFloat(quoteSize) / ticker.price).toFixed(8),
      average_filled_price: ticker.price,
      status: 'FILLED',
      created_time: new Date().toISOString(),
      is_paper: true
    };

    this.orders.push(order);
    return { success_response: order };
  }

  async getAccounts() {
    // Returns simulated accounts
    return [
      { currency: 'USD', available_balance: { value: '10000', currency: 'USD' } }
    ];
  }
}

module.exports = { CoinbaseMCPClient, CoinbasePaperClient };
