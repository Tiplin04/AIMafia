"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GeminiApi = void 0;
class GeminiApi {
  constructor({
    apiKey = process.env.GEMINI_API_KEY,
    systemInstruction = null,
    initialHistory = [],
    maxHistory = 50,
    tools = [],
    models = ["gemini-2.0-flash-exp"],
    log = false,
  }) {
    if (!apiKey) {
      throw new Error("API key is required");
    }

    if (!models || models.length === 0) {
      throw new Error("At least one model is required");
    }

    this.apiKey = apiKey;
    this.models = models;
    this.tools = tools;
    this.maxHistory = maxHistory;
    this.log = log;
    this.history = initialHistory || [];
  }

  async sendMessage(message, retries = 3, delay = 2000) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        // Добавляем задержку между попытками
        if (attempt > 0) {
          console.log(`[API] Повторная попытка ${attempt + 1}/${retries} через ${delay}ms`);
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 2; // Увеличиваем задержку с каждой попыткой
        }

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${this.models[0]}:generateContent?key=${this.apiKey}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contents: [{
              parts: [{
                text: message
              }]
            }]
          })
        });

        if (response.status === 429) {
          console.log(`[API] Rate limit exceeded (429), attempt ${attempt + 1}/${retries}`);
          if (attempt === retries - 1) {
            throw new Error(`HTTP error! status: ${response.status} - Rate limit exceeded`);
          }
          continue; // Повторяем попытку
        }

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        
        if (data.candidates && data.candidates[0] && data.candidates[0].content) {
          const text = data.candidates[0].content.parts[0].text;
          return {
            text: text,
            content: data.candidates[0].content,
            usage: data.usageMetadata || null,
            finishReason: data.candidates[0].finishReason || null,
            raw: data
          };
        } else {
          throw new Error('Invalid response format from Gemini API');
        }
      } catch (error) {
        console.error(`[API] Error calling Gemini API (attempt ${attempt + 1}/${retries}):`, error);
        if (attempt === retries - 1) {
          throw error;
        }
      }
    }
  }

  static createMessage(role, text) {
    return {
      role: role,
      parts: [{ text: text }]
    };
  }

  static createFunctionResponse(name, response) {
    return {
      role: "function",
      parts: [{
        functionResponse: {
          name: name,
          response: response
        }
      }]
    };
  }
}

module.exports = GeminiApi;
