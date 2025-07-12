// Types and interfaces
interface MessagePart {
  text?: string;
  functionCall?: FunctionCall;
  functionResponse?: FunctionResponse;
}

interface Message {
  role: "user" | "model" | "function";
  parts: MessagePart[];
}

interface FunctionCall {
  name: string;
  args: Record<string, any>;
}

interface FunctionResponse {
  name: string;
  response: any;
}

interface SystemInstruction {
  parts: { text: string }[];
}

interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, any>;
    required: string[];
  };
}

interface Tool {
  function_declarations: FunctionDeclaration[];
}

interface UsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

interface ApiCandidate {
  content: Message;
  finishReason?: string;
}

interface ApiResponse {
  candidates: ApiCandidate[];
  usageMetadata?: UsageMetadata;
}

interface ProcessedResponse {
  content: Message;
  functionCall: FunctionCall | null;
  text: string | null;
  usage: UsageMetadata | null;
  finishReason: string | null;
  raw: ApiResponse;
  usedModel?: string; // Добавляем информацию о том, какая модель была использована
}

interface StreamChunk {
  text: string;
}

interface GeminiApiConfig {
  apiKey?: string;
  systemInstruction?: string | null;
  initialHistory?: Message[];
  maxHistory?: number;
  tools?: Tool[];
  models?: string[]; // Изменено с model на models (массив)
  log?: boolean; // Новый параметр для логирования
}

interface ModelError {
  model: string;
  error: Error;
}

class GeminiApi {
  private apiKey: string;
  private models: string[]; // Изменено на массив моделей
  private tools: Tool[];
  private maxHistory: number;
  private systemInstruction: SystemInstruction | null = null;
  private initialHistory: Message[];
  private history: Message[];
  private modelErrors: ModelError[] = []; // Для отслеживания ошибок по моделям
  private log: boolean; // Новое поле для логирования

  constructor({
    apiKey = process.env.GEMINI_API_KEY!,
    systemInstruction = null,
    initialHistory = [],
    maxHistory = 50,
    tools = [],
    models = ["gemini-2.5-flash-preview-05-20", "gemini-2.0-flash"], // Массив моделей по умолчанию
    log = false, // По умолчанию логирование выключено
  }: GeminiApiConfig) {
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

    // Устанавливаем системную инструкцию
    this.setSystemInstruction(systemInstruction);

    // Валидируем и сохраняем начальную историю
    this.initialHistory = this.validateHistory(initialHistory);
    this.history = [...this.initialHistory];
  }

  // Метод для логирования сообщений
  private logMessage(message: Message): void {
    if (!this.log) return;

    const timestamp = new Date().toISOString();
    const divider = "=".repeat(80);

    console.log(`\n${divider}`);
    console.log(`[${timestamp}] Message from: ${message.role.toUpperCase()}`);
    console.log(divider);

    message.parts.forEach((part, index) => {
      if (part.text) {
        console.log(`Text: ${part.text}`);
      }

      if (part.functionCall) {
        console.log(`Function Call: ${part.functionCall.name}`);
        console.log(`Arguments: ${JSON.stringify(part.functionCall.args, null, 2)}`);
      }

      if (part.functionResponse) {
        console.log(`Function Response: ${part.functionResponse.name}`);
        console.log(`Response: ${JSON.stringify(part.functionResponse.response, null, 2)}`);
      }
    });

    console.log(divider);
  }

  // Валидация формата истории
  private validateHistory(history: Message[]): Message[] {
    return history.map((msg, index) => {
      // Проверяем наличие обязательных полей
      if (!msg.role || !msg.parts || !Array.isArray(msg.parts)) {
        throw new Error(
          `Invalid message format at index ${index}. Expected {role, parts: [{text}]}`
        );
      }

      // Проверяем корректность роли
      if (!["user", "model", "function"].includes(msg.role)) {
        throw new Error(
          `Invalid role "${msg.role}" at index ${index}. Allowed: user, model, function`
        );
      }

      return msg;
    });
  }

  // Управление историей с сохранением initialHistory
  private manageHistory(): void {
    const currentCount = this.history.length;

    // Проверяем, нужно ли удалять сообщения
    if (currentCount <= this.maxHistory) {
      return; // История в пределах лимита
    }

    // Функция для проверки, является ли сообщение function call
    const isFunctionCall = (msg: Message): boolean => {
      return msg.role === "model" && msg.parts.some((part) => part.functionCall !== undefined);
    };

    // Функция для поиска связанной группы сообщений
    const findMessageGroup = (startIndex: number): number => {
      // Если это user сообщение, проверяем следующие сообщения
      if (this.history[startIndex].role === "user") {
        let endIndex = startIndex;

        // Проверяем следующее сообщение
        if (endIndex + 1 < this.history.length) {
          const nextMsg = this.history[endIndex + 1];

          // Если следующее - function call от модели
          if (isFunctionCall(nextMsg)) {
            endIndex = endIndex + 1;

            // Проверяем, есть ли после него function response
            if (
              endIndex + 1 < this.history.length &&
              this.history[endIndex + 1].role === "function"
            ) {
              endIndex = endIndex + 1;

              // И возможно, еще один ответ модели после function response
              if (
                endIndex + 1 < this.history.length &&
                this.history[endIndex + 1].role === "model"
              ) {
                endIndex = endIndex + 1;
              }
            }
          }
        }

        return endIndex;
      }

      // Для других типов сообщений возвращаем тот же индекс
      return startIndex;
    };

    // Находим, сколько сообщений нужно сохранить
    let messagesToKeep = this.maxHistory;
    let keepFromIndex = this.history.length - messagesToKeep;

    // Проверяем, не попадаем ли мы в середину группы сообщений
    if (keepFromIndex > 0) {
      // Ищем начало группы сообщений
      for (let i = keepFromIndex; i >= 0; i--) {
        if (this.history[i].role === "user") {
          // Нашли user сообщение, проверяем его группу
          const groupEnd = findMessageGroup(i);

          // Если группа заканчивается после keepFromIndex,
          // нужно сохранить всю группу
          if (groupEnd >= keepFromIndex) {
            keepFromIndex = i;
            messagesToKeep = this.history.length - i;
          }
          break;
        }
      }
    }

    // Дополнительная проверка: убедимся, что не оставляем "осиротевшие" сообщения
    // Проверяем, что первое сохраняемое сообщение - это user или начало валидной последовательности
    while (keepFromIndex > 0) {
      const firstKeptMsg = this.history[keepFromIndex];

      // Если первое сохраняемое сообщение - это function call или function response,
      // нужно включить предыдущие связанные сообщения
      if (firstKeptMsg.role === "function" || isFunctionCall(firstKeptMsg)) {
        // Ищем предыдущее user сообщение
        for (let i = keepFromIndex - 1; i >= 0; i--) {
          if (this.history[i].role === "user") {
            keepFromIndex = i;
            messagesToKeep = this.history.length - i;
            break;
          }
        }
        break;
      } else {
        // Все в порядке, можно обрезать
        break;
      }
    }

    // Обрезаем историю, сохраняя полные группы сообщений
    if (keepFromIndex > 0) {
      this.history = this.history.slice(keepFromIndex);

      if (this.log) {
        console.log(
          `[HISTORY] Trimmed history. Kept ${this.history.length} messages starting from index ${keepFromIndex}`
        );
      }
    }
  }

  // Добавление сообщения в историю
  private addToHistory(message: Message): void {
    this.history.push(message);
    this.logMessage(message); // Логируем сообщение при добавлении
    this.manageHistory();
  }

  // Создание запроса к API с поддержкой fallback
  private async makeApiRequestWithFallback(
    endpoint: string = "generateContent"
  ): Promise<{ response: ApiResponse; usedModel: string }> {
    this.modelErrors = []; // Очищаем предыдущие ошибки

    for (let i = 0; i < this.models.length; i++) {
      const model = this.models[i];

      try {
        if (this.log) {
          console.log(`\n[API] Attempting to use model: ${model}`);
        }
        const response = await this.makeApiRequestForModel(model, endpoint);
        return { response, usedModel: model };
      } catch (error) {
        console.error(`Error with model ${model}:`, error);
        this.modelErrors.push({ model, error: error as Error });

        // Если это последняя модель, выбрасываем ошибку
        if (i === this.models.length - 1) {
          throw new Error(
            `All models failed. Errors:\n${this.modelErrors
              .map((e) => `${e.model}: ${e.error.message}`)
              .join("\n")}`
          );
        }

        // Иначе пробуем следующую модель
        if (this.log) {
          console.log(`[API] Falling back to next model...`);
        }
      }
    }

    throw new Error("Unexpected error: no models available");
  }

  // Создание запроса к API для конкретной модели
  private async makeApiRequestForModel(
    model: string,
    endpoint: string = "generateContent"
  ): Promise<ApiResponse> {
    console.log(model);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${endpoint}?key=${this.apiKey}`;

    const payload: any = {
      contents: this.history,
    };

    // Добавляем tools, если они есть
    if (this.tools && this.tools.length > 0) {
      payload.tools = this.tools;
    }

    // Добавляем системную инструкцию, если она есть
    if (this.systemInstruction) {
      payload.system_instruction = this.systemInstruction;
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        console.dir(this.history, { depth: null }); // Логируем историю перед ошибкой
        const error = await response.text();
        throw new Error(`HTTP error! Status: ${response.status}, Message: ${error}`);
      }

      return await response.json();
    } catch (error) {
      console.error(`Error calling Gemini API with model ${model}:`, error);
      throw error;
    }
  }

  // Обработка ответа от API
  private processApiResponse(data: ApiResponse, usedModel?: string): ProcessedResponse {
    if (!data.candidates || data.candidates.length === 0) {
      throw new Error("No response from Gemini API");
    }

    const candidate = data.candidates[0];

    if (!candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) {
      throw new Error("Invalid response structure from Gemini API");
    }

    const modelResponse = candidate.content;
    const part = modelResponse.parts[0];

    // Добавляем ответ модели в историю
    this.addToHistory(modelResponse);

    // Возвращаем структурированный ответ
    return {
      content: modelResponse,
      functionCall: part.functionCall || null,
      text: part.text || null,
      usage: data.usageMetadata || null,
      finishReason: candidate.finishReason || null,
      raw: data,
      usedModel, // Добавляем информацию о использованной модели
    };
  }

  // Основной метод для отправки сообщений
  public async sendMessage(message: string): Promise<ProcessedResponse> {
    // Добавляем сообщение пользователя в историю
    const userMessage: Message = GeminiApi.createMessage("user", message);
    this.addToHistory(userMessage);

    try {
      const { response, usedModel } = await this.makeApiRequestWithFallback();
      return this.processApiResponse(response, usedModel);
    } catch (error) {
      // Удаляем добавленное сообщение из истории в случае ошибки
      this.history.pop();
      throw error;
    }
  }

  // Метод для обработки результатов вызова функции
  public async sendFunctionResult(
    functionName: string,
    functionResponse: any
  ): Promise<ProcessedResponse> {
    // Формируем ответ функции
    const functionResultMessage: Message = GeminiApi.createFunctionResponse(
      functionName,
      functionResponse
    );
    this.addToHistory(functionResultMessage);

    try {
      const { response, usedModel } = await this.makeApiRequestWithFallback();
      return this.processApiResponse(response, usedModel);
    } catch (error) {
      // Удаляем добавленное сообщение из истории в случае ошибки
      this.history.pop();
      throw error;
    }
  }

  // Стриминг ответа с поддержкой fallback
  public async *streamMessage(message: string): AsyncGenerator<StreamChunk, void, unknown> {
    // Добавляем сообщение пользователя в историю
    const userMessage: Message = {
      role: "user",
      parts: [{ text: message }],
    };
    this.addToHistory(userMessage);

    this.modelErrors = []; // Очищаем предыдущие ошибки

    for (let i = 0; i < this.models.length; i++) {
      const model = this.models[i];

      try {
        if (this.log) {
          console.log(`\n[STREAM] Attempting to stream with model: ${model}`);
        }
        yield* this.streamWithModel(model, userMessage);
        return; // Успешно завершили стриминг
      } catch (error) {
        console.error(`Error streaming with model ${model}:`, error);
        this.modelErrors.push({ model, error: error as Error });

        // Если это последняя модель, выбрасываем ошибку
        if (i === this.models.length - 1) {
          // Удаляем добавленное сообщение из истории
          this.history.pop();
          throw new Error(
            `All models failed during streaming. Errors:\n${this.modelErrors
              .map((e) => `${e.model}: ${e.error.message}`)
              .join("\n")}`
          );
        }

        // Иначе пробуем следующую модель
        if (this.log) {
          console.log(`[STREAM] Falling back to next model for streaming...`);
        }
      }
    }
  }

  // Стриминг для конкретной модели
  private async *streamWithModel(
    model: string,
    userMessage: Message
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;

    const payload: any = {
      contents: this.history,
    };

    if (this.tools && this.tools.length > 0) {
      payload.tools = this.tools;
    }

    if (this.systemInstruction) {
      payload.system_instruction = this.systemInstruction;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`HTTP error! Status: ${response.status}, Message: ${error}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalResponse: Message | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data);
            if (parsed.candidates && parsed.candidates[0]) {
              const candidate = parsed.candidates[0];
              if (candidate.content && candidate.content.parts) {
                finalResponse = candidate.content;
                const part = candidate.content.parts[0];
                if (part.text) {
                  yield { text: part.text };
                }
              }
            }
          } catch (e) {
            console.error("Error parsing SSE data:", e);
          }
        }
      }
    }

    // Добавляем финальный ответ в историю
    if (finalResponse) {
      this.addToHistory(finalResponse);
    } else {
      throw new Error("No final response received from streaming");
    }
  }

  // Получение текущей истории
  public getHistory(): Message[] {
    return [...this.history];
  }

  // Установка новой истории
  public setHistory(newHistory: Message[]): void {
    this.history = this.validateHistory(newHistory);
    this.manageHistory();
  }

  // Очистка истории (сохраняя initialHistory)
  public clearHistory(): void {
    this.history = [...this.initialHistory];
  }

  // Получение количества сообщений в истории
  public getHistoryCount(): number {
    return this.history.length;
  }

  // Получение системной инструкции
  public getSystemInstruction(): string | null {
    return this.systemInstruction ? this.systemInstruction.parts[0].text : null;
  }

  // Обновление системной инструкции
  public setSystemInstruction(instruction: string | null): void {
    if (instruction) {
      this.systemInstruction = {
        parts: [{ text: instruction }],
      };
    } else {
      this.systemInstruction = null;
    }
  }

  // Обновление tools
  public setTools(tools: Tool[]): void {
    this.tools = tools || [];
  }

  // Получение текущих моделей
  public getModels(): string[] {
    return [...this.models];
  }

  // Обновление моделей
  public setModels(models: string[]): void {
    if (!models || models.length === 0) {
      throw new Error("At least one model is required");
    }
    this.models = models;
  }

  // Получение ошибок последнего запроса
  public getLastErrors(): ModelError[] {
    return [...this.modelErrors];
  }

  // Получение состояния логирования
  public isLoggingEnabled(): boolean {
    return this.log;
  }

  // Установка состояния логирования
  public setLogging(enabled: boolean): void {
    this.log = enabled;
  }

  // Статические хелперы
  public static createMessage(role: "user" | "model" | "function", text: string): Message {
    return {
      role,
      parts: [{ text }],
    };
  }

  public static createFunctionResponse(name: string, response: any): Message {
    return {
      role: "function",
      parts: [
        {
          functionResponse: {
            name,
            response,
          },
        },
      ],
    };
  }
}

export {
  GeminiApi,
  type GeminiApiConfig,
  type Message,
  type Tool,
  type ProcessedResponse,
  type StreamChunk,
  type FunctionCall,
  type ModelError,
};
