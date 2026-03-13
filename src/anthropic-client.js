/**
 * Anthropic Client - AI Brain of the Trading Agent
 *
 * Zwei-Tier-Modell-Strategie zur Kostensenkung:
 *   - DECISION_MODEL (Haiku): Routine-Handelsentscheidungen alle 5 Min → ~$0.50/Monat
 *   - IMPROVE_MODEL  (Sonnet): Strategie-Optimierung (selten) → ~$0.10–0.30/Monat
 */

// Modell-Konfiguration — über ENV überschreibbar
const DECISION_MODEL = process.env.AI_DECISION_MODEL || 'claude-haiku-4-5';
const IMPROVE_MODEL  = process.env.AI_IMPROVE_MODEL  || 'claude-sonnet-4-20250514';
const DECISION_TOKENS = parseInt(process.env.AI_DECISION_TOKENS || '600',  10);
const IMPROVE_TOKENS  = parseInt(process.env.AI_IMPROVE_TOKENS  || '1200', 10);

class AnthropicClient {
  constructor(config = {}) {
    this.apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;

    // Legacy-Kompatibilität: falls config.model explizit gesetzt
    this.model     = config.model     || DECISION_MODEL;
    this.maxTokens = config.maxTokens || DECISION_TOKENS;

    this.conversationHistory = [];
    this.maxHistoryLength    = 10;

    if (!this.apiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY fehlt!\n' +
        'Bitte in /opt/trading-agent/.env eintragen:\n' +
        '  ANTHROPIC_API_KEY=sk-ant-...\n' +
        'Key erstellen: https://console.anthropic.com/settings/keys'
      );
    }
  }

  /**
   * Routine-Entscheidung: schnell + günstig (Haiku)
   */
  async complete({ system, messages, responseFormat = 'text' }) {
    return this._call({
      model:     this.model,
      maxTokens: this.maxTokens,
      system,
      messages,
      responseFormat,
    });
  }

  /**
   * Strategie-Optimierung: mehr Denktiefe (Sonnet)
   */
  async completeStrategic({ system, messages, responseFormat = 'text' }) {
    return this._call({
      model:     IMPROVE_MODEL,
      maxTokens: IMPROVE_TOKENS,
      system,
      messages,
      responseFormat,
    });
  }

  async _call({ model, maxTokens, system, messages, responseFormat }) {
    const systemPrompt = responseFormat === 'json'
      ? `${system}\n\nIMPORTANT: You MUST respond with valid JSON only. No markdown, no explanation, just the JSON object.`
      : system;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system:     systemPrompt,
        messages,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${err}`);
    }

    const data = await response.json();
    const text = data.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    if (responseFormat === 'json') {
      return text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    }
    return text;
  }

  async completeWithHistory({ system, userMessage, responseFormat = 'text' }) {
    this.conversationHistory.push({ role: 'user', content: userMessage });
    if (this.conversationHistory.length > this.maxHistoryLength * 2) {
      this.conversationHistory = this.conversationHistory.slice(-this.maxHistoryLength * 2);
    }
    const response = await this.complete({
      system, messages: this.conversationHistory, responseFormat,
    });
    this.conversationHistory.push({ role: 'assistant', content: response });
    return response;
  }

  clearHistory() { this.conversationHistory = []; }
}

module.exports = { AnthropicClient, DECISION_MODEL, IMPROVE_MODEL };
