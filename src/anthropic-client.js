/**
 * Anthropic Client - AI Brain of the Trading Agent
 */

class AnthropicClient {
  constructor(config = {}) {
    this.model     = config.model     || 'claude-sonnet-4-20250514';
    this.maxTokens = config.maxTokens || 1500;
    this.apiKey    = config.apiKey    || process.env.ANTHROPIC_API_KEY;
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

  async complete({ system, messages, responseFormat = 'text' }) {
    const systemPrompt = responseFormat === 'json'
      ? `${system}\n\nIMPORTANT: You MUST respond with valid JSON only. No markdown, no explanation, just the JSON object.`
      : system;

    const requestBody = {
      model:      this.model,
      max_tokens: this.maxTokens,
      system:     systemPrompt,
      messages:   messages,
    };

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${err}`);
    }

    const data = await response.json();
    const text = data.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
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
      system,
      messages: this.conversationHistory,
      responseFormat,
    });

    this.conversationHistory.push({ role: 'assistant', content: response });
    return response;
  }

  clearHistory() {
    this.conversationHistory = [];
  }
}

module.exports = { AnthropicClient };
