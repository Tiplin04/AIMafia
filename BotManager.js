// Загружаем переменные окружения
require('dotenv').config();

const GeminiApi = require('./GeminiApi');

// Класс для Cohere API
class CohereProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }
  
  async sendMessage(message) {
    const response = await fetch('https://api.cohere.ai/v1/generate', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'command',
        prompt: message,
        max_tokens: 150,
        temperature: 0.7,
        k: 0,
        stop_sequences: [],
        return_likelihoods: 'NONE'
      })
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();
    return {
      text: data.generations[0].text.trim(),
      usage: data.meta
    };
  }
}

class MultiAIProvider {
  constructor() {
    this.providers = [];
    this.currentProviderIndex = 0;
    this.initializeProviders();
  }

  initializeProviders() {
    // Получаем API ключи из переменных окружения
    const geminiKeys = [
      process.env.GEMINI_API_KEY_1,
      process.env.GEMINI_API_KEY_2,
      process.env.GEMINI_API_KEY_3
    ].filter(key => key && key !== 'your_gemini_key_1_here');

    const cohereKeys = [
      process.env.COHERE_API_KEY_1,
      process.env.COHERE_API_KEY_2,
      process.env.COHERE_API_KEY_3
    ].filter(key => key && key !== 'your_cohere_key_1_here');

    // Добавляем Gemini провайдеры
    geminiKeys.forEach((key, index) => {
      if (key) {
        this.providers.push({
          name: `gemini-${index + 1}`,
          api: new GeminiApi({
            apiKey: key,
            log: false
          }),
          enabled: true,
          errorCount: 0,
          maxErrors: 3
        });
      }
    });

    // Добавляем Cohere провайдеры
    cohereKeys.forEach((key, index) => {
      if (key) {
        this.providers.push({
          name: `cohere-${index + 1}`,
          api: new CohereProvider(key),
          enabled: true,
          errorCount: 0,
          maxErrors: 3
        });
      }
    });

    // Если нет ни одного провайдера, выводим предупреждение
    if (this.providers.length === 0) {
      console.warn('⚠️  Нет доступных AI провайдеров! Создайте файл .env с API ключами.');
      console.warn('📝 Скопируйте env.example в .env и заполните своими ключами.');
    } else {
      console.log(`✅ Инициализировано ${this.providers.length} AI провайдеров`);
    }
  }

  async sendMessage(message) {
    let lastError = null;
    
    // Пробуем всех доступных провайдеров
    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i];
      if (!provider.enabled) continue;
      
      try {
        console.log(`[AI] Используем провайдер: ${provider.name}`);
        const result = await provider.api.sendMessage(message);
        provider.errorCount = 0; // Сбрасываем счетчик ошибок при успехе
        return result;
      } catch (error) {
        console.error(`[AI] Ошибка провайдера ${provider.name}:`, error.message);
        lastError = error;
        provider.errorCount++;
        
        // Отключаем провайдер при слишком многих ошибках
        if (provider.errorCount >= provider.maxErrors) {
          console.log(`[AI] Отключаем провайдер ${provider.name} из-за ошибок`);
          provider.enabled = false;
        }
      }
    }
    
    // Если все провайдеры недоступны, возвращаем fallback
    console.log('[AI] Все провайдеры недоступны, используем fallback');
    throw lastError || new Error('No AI providers available');
  }

  // Метод для добавления нового провайдера
  addProvider(name, api, maxErrors = 3) {
    this.providers.push({
      name,
      api,
      enabled: true,
      errorCount: 0,
      maxErrors
    });
  }

  // Метод для включения/выключения провайдера
  setProviderStatus(name, enabled) {
    const provider = this.providers.find(p => p.name === name);
    if (provider) {
      provider.enabled = enabled;
      if (enabled) {
        provider.errorCount = 0; // Сбрасываем счетчик ошибок
      }
    }
  }

  // Метод для получения статистики провайдеров
  getProviderStats() {
    return this.providers.map(p => ({
      name: p.name,
      enabled: p.enabled,
      errorCount: p.errorCount,
      maxErrors: p.maxErrors
    }));
  }
}

class BotManager {
  constructor() {
    this.bots = new Map(); // Map для хранения ботов
    this.botNames = [
      'Олександр', 'Марія', 'Дмитро', 'Анна', 'Сергій', 'Олена', 
      'Михайло', 'Ольга', 'Андрій', 'Наталія', 'Ігор', 'Тетяна',
      'Володимир', 'Світлана', 'Павло', 'Юлія', 'Микола', 'Ірина'
    ];
    this.usedNames = new Set();
    this.aiProvider = new MultiAIProvider();
    
    // Система для оптимизации токенов - "скользящее окно"
    this.dayHistory = []; // История сообщений текущего дня
    this.currentDaySpeakerIndex = 0; // Индекс текущего выступающего в дне
    this.nightResults = null; // Результаты ночи для передачи ботам
  }

  // Сброс истории дня (вызывается при начале нового дня)
  resetDayHistory() {
    this.dayHistory = [];
    this.currentDaySpeakerIndex = 0;
  }

  // Добавление сообщения в историю дня
  addDayMessage(speakerName, message) {
    this.dayHistory.push({
      speaker: speakerName,
      message: message,
      timestamp: Date.now()
    });
  }

  // Установка результатов ночи
  setNightResults(results) {
    this.nightResults = results;
  }

  // Получение оптимизированной истории для бота (только релевантные сообщения)
  getOptimizedHistoryForBot(speakerIndex) {
    if (speakerIndex === 0) {
      // Первый выступающий видит только результаты ночи
      return [];
    } else {
      // Остальные видят результаты ночи + сообщения предыдущих выступающих
      return this.dayHistory.slice(0, speakerIndex);
    }
  }

  // Формирование базового промпта с результатами ночи
  getBasePromptWithNightResults(bot, players) {
    const alivePlayers = players.filter(p => p.alive);
    let prompt = `
Ти граєш у гру "Мафія". Твоя роль: ${this.getRoleText(bot.role)}.
Твоя особистість: ${bot.personality.description}.
Твоє ім'я: ${bot.name}.

Живі гравці: ${alivePlayers.map(p => p.name).join(', ')}
Твоя пам'ять: ${JSON.stringify(bot.memory)}`;

    // Добавляем результаты ночи, если есть
    if (this.nightResults) {
      prompt += `\n\nРезультати ночі:\n${this.nightResults}`;
      
      // Добавляем специальную информацию для детектива
      if (bot.role === 'detective' && bot.memory.detectiveResults.length > 0) {
        const lastCheck = bot.memory.detectiveResults[bot.memory.detectiveResults.length - 1];
        prompt += `\n\nТвоя остання перевірка: ${lastCheck.target} - ${lastCheck.role}`;
      }
    }

    return prompt;
  }

  // Создание нового бота
  createBot() {
    const availableNames = this.botNames.filter(name => !this.usedNames.has(name));
    if (availableNames.length === 0) {
      throw new Error('Недостаточно имен для ботов');
    }
    
    const randomName = availableNames[Math.floor(Math.random() * availableNames.length)];
    this.usedNames.add(randomName);
    
    const bot = {
      id: `bot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name: randomName,
      isBot: true,
      alive: true,
      role: null,
      memory: {
        detectiveResults: [], // Результаты проверок комиссара
        suspicions: [], // Подозрения
        gameHistory: [], // История игры
        mafiaPartner: null, // Партнер по мафии (если бот мафия)
        lastActions: [] // Последние действия
      },
      personality: this.generatePersonality()
    };
    
    this.bots.set(bot.id, bot);
    return bot;
  }

  // Генерация личности бота
  generatePersonality() {
    const personalities = [
      { type: 'aggressive', description: 'агрессивный и прямолинейный' },
      { type: 'cautious', description: 'осторожный и аналитичный' },
      { type: 'social', description: 'общительный и дружелюбный' },
      { type: 'mysterious', description: 'загадочный и молчаливый' },
      { type: 'logical', description: 'логичный и рациональный' }
    ];
    
    return personalities[Math.floor(Math.random() * personalities.length)];
  }

  // Удаление бота
  removeBot(botId) {
    const bot = this.bots.get(botId);
    if (bot) {
      this.usedNames.delete(bot.name);
      this.bots.delete(botId);
    }
  }

  // Очистка всех ботов
  clearBots() {
    this.bots.clear();
    this.usedNames.clear();
  }

  // Получение бота по ID
  getBot(botId) {
    return this.bots.get(botId);
  }

  // Получение всех ботов
  getAllBots() {
    return Array.from(this.bots.values());
  }

  // Получение живых ботов
  getAliveBots() {
    return Array.from(this.bots.values()).filter(bot => bot.alive);
  }

  // Получение ботов по роли
  getBotsByRole(role) {
    return Array.from(this.bots.values()).filter(bot => bot.role === role && bot.alive);
  }

  // Генерация приветствия для бота
  async generateBotGreeting(bot, players) {
    const prompt = `
Ти граєш у гру "Мафія". Твоя роль: ${this.getRoleText(bot.role)}.
Твоя особистість: ${bot.personality.description}.
Твоє ім'я: ${bot.name}.

Інші гравці: ${players.map(p => p.name).join(', ')}.

Згенеруй коротке привітання (1-2 речення) від свого імені. Будь природним, не розкривай свою роль, але покажи свій характер.
Відповідай тільки текстом привітання, без додаткових коментарів.
Відповідай українською мовою.`;

    try {
      const response = await this.aiProvider.sendMessage(prompt);
      return response.text || this.generateSmartFallback(bot, { players }, 'greeting');
    } catch (error) {
      console.error('Помилка генерації привітання:', error);
      return this.generateSmartFallback(bot, { players }, 'greeting');
    }
  }

  // Генерация ночного действия для бота (оптимизированная версия)
  async generateNightAction(bot, players, nightActions) {
    const alivePlayers = players.filter(p => p.alive && p.name !== bot.name);
    const targetOptions = alivePlayers.map(p => p.name).join(', ');
    
    // Получаем базовый промпт с результатами ночи (если есть)
    let prompt = this.getBasePromptWithNightResults(bot, players);
    
    // Добавляем информацию для ночных действий
    prompt += `
Живі гравці для вибору: ${targetOptions}
Відповідай українською мовою.
`;

    if (bot.role === 'mafia') {
      const mafiaPartners = this.getBotsByRole('mafia').filter(b => b.id !== bot.id);
      const mafiaNames = mafiaPartners.map(b => b.name).join(', ');
      
      prompt += `
Ти мафія. Твої партнери по мафії: ${mafiaNames || 'немає'}
Поточні голоси мафії: ${JSON.stringify(nightActions.mafia)}
Обери одного гравця для вбивства. Враховуй голоси партнерів і стратегію.
Відповідай тільки іменем обраного гравця, без додаткового тексту.
Відповідай українською мовою.`;
    } else if (bot.role === 'doctor') {
      prompt += `
Ти лікар. Обери одного гравця для лікування.
Аналізуй, хто може бути ціллю мафії цієї ночі.
Відповідай тільки іменем обраного гравця, без додаткового тексту.
Відповідай українською мовою.`;
    } else if (bot.role === 'detective') {
      prompt += `
Ти комісар. Обери одного гравця для перевірки ролі.
Використовуй свою пам'ять про попередні перевірки.
Відповідай тільки іменем обраного гравця, без додаткового тексту.
Відповідай українською мовою.`;
    }

    try {
      const response = await this.aiProvider.sendMessage(prompt);
      const target = response.text?.trim();
      
      // Проверяем, что выбранный игрок существует
      if (target && alivePlayers.some(p => p.name === target)) {
        return target;
      }
      
      // Если AI выбрал несуществующего игрока, используем умный fallback
      return this.generateSmartFallback(bot, { players }, 'night_action');
    } catch (error) {
      console.error('Помилка генерації нічної дії:', error);
      // Используем умный fallback в случае ошибки
      return this.generateSmartFallback(bot, { players }, 'night_action');
    }
  }

  // Генерация дневного высказывания для бота (оптимизированная версия)
  async generateDaySpeech(bot, players, speakerIndex = 0) {
    const alivePlayers = players.filter(p => p.alive);
    
    // Получаем базовый промпт с результатами ночи
    let prompt = this.getBasePromptWithNightResults(bot, players);
    
    // Добавляем оптимизированную историю дня (только релевантные сообщения)
    const dayHistory = this.getOptimizedHistoryForBot(speakerIndex);
    if (dayHistory.length > 0) {
      prompt += `\n\nПовідомлення цього дня:\n`;
      dayHistory.forEach((msg, index) => {
        prompt += `${index + 1}. ${msg.speaker}: ${msg.message}\n`;
      });
    }
    
    // Добавляем инструкции для речи
    prompt += `
Вислови свої підозри і думки про те, хто може бути мафією.
Будь природним, використовуй свою особистість.
Не розкривай свою роль, якщо ти комісар або лікар.
Відповідай коротко (2-3 речення).
Відповідай українською мовою.`;

    try {
      const response = await this.aiProvider.sendMessage(prompt);
      return response.text || this.generateSmartFallback(bot, { players }, 'speech');
    } catch (error) {
      console.error('Помилка генерації денної промови:', error);
      return this.generateSmartFallback(bot, { players }, 'speech');
    }
  }

  // Генерация дневного голоса для бота (оптимизированная версия)
  async generateDayVote(bot, players, dayVotes) {
    const alivePlayers = players.filter(p => p.alive && p.name !== bot.name);
    const targetOptions = alivePlayers.map(p => p.name).join(', ');
    
    // Получаем базовый промпт с результатами ночи
    let prompt = this.getBasePromptWithNightResults(bot, players);
    
    // Добавляем всю историю дня для голосования (бот должен видеть все выступления)
    if (this.dayHistory.length > 0) {
      prompt += `\n\nВсі повідомлення цього дня:\n`;
      this.dayHistory.forEach((msg, index) => {
        prompt += `${index + 1}. ${msg.speaker}: ${msg.message}\n`;
      });
    }
    
    // Добавляем информацию для голосования
    prompt += `
Живі гравці для голосування: ${targetOptions}
Поточні голоси: ${JSON.stringify(dayVotes)}
За кого ти голосуєш? Якщо немає достатніх підстав, можеш пропустити.
Відповідай тільки іменем гравця або словом "пропустити", без додаткового тексту.
Відповідай українською мовою.`;

    try {
      const response = await this.aiProvider.sendMessage(prompt);
      const vote = response.text?.trim().toLowerCase();
      
      if (vote === 'пропустити' || vote === 'пропустити') {
        return null;
      }
      
      // Проверяем, что выбранный игрок существует
      if (vote && alivePlayers.some(p => p.name.toLowerCase() === vote)) {
        const targetPlayer = alivePlayers.find(p => p.name.toLowerCase() === vote);
        return targetPlayer.name;
      }
      
      // Используем умный fallback если выбор некорректный
      return this.generateSmartFallback(bot, { players }, 'vote');
    } catch (error) {
      console.error('Помилка генерації денного голосу:', error);
      // Используем умный fallback в случае ошибки
      return this.generateSmartFallback(bot, { players }, 'vote');
    }
  }

  // Обновление памяти бота
  updateBotMemory(botId, event) {
    const bot = this.bots.get(botId);
    if (!bot) return;

    bot.memory.gameHistory.push({
      timestamp: Date.now(),
      event: event
    });

    // Ограничиваем историю последними 20 событиями
    if (bot.memory.gameHistory.length > 20) {
      bot.memory.gameHistory = bot.memory.gameHistory.slice(-20);
    }
  }

  // Добавление результата проверки комиссара
  addDetectiveResult(botId, targetName, targetRole) {
    const bot = this.bots.get(botId);
    if (!bot || bot.role !== 'detective') return;

    bot.memory.detectiveResults.push({
      target: targetName,
      role: targetRole,
      timestamp: Date.now()
    });
  }

  // Добавление подозрения
  addSuspicion(botId, targetName, reason) {
    const bot = this.bots.get(botId);
    if (!bot) return;

    bot.memory.suspicions.push({
      target: targetName,
      reason: reason,
      timestamp: Date.now()
    });
  }

  // Получение текста роли
  getRoleText(role) {
    switch (role) {
      case 'mafia': return 'мафия';
      case 'doctor': return 'доктор';
      case 'detective': return 'комиссар';
      case 'citizen': return 'мирный житель';
      default: return 'неизвестно';
    }
  }

  // Генерация случайного приветствия
  getRandomGreeting(botName) {
    const greetings = [
      `Привет всем! Я ${botName}, готов к игре!`,
      `Здравствуйте! Меня зовут ${botName}.`,
      `Привет! ${botName} на связи.`,
      `Добрый день! Я ${botName}.`,
      `Всем привет! ${botName} здесь.`
    ];
    return greetings[Math.floor(Math.random() * greetings.length)];
  }

  // Генерация случайной дневной речи
  getRandomDaySpeech(botName) {
    const speeches = [
      `Я ${botName}, и я думаю, что нужно быть осторожным в своих выводах.`,
      `${botName} здесь. Нужно внимательно анализировать поведение игроков.`,
      `Как ${botName}, я считаю, что важно слушать всех внимательно.`,
      `${botName} говорит: давайте разберемся в ситуации спокойно.`,
      `Я ${botName}. Пока что у меня нет четких подозрений.`
    ];
    return speeches[Math.floor(Math.random() * speeches.length)];
  }

  // Установка роли боту
  setBotRole(botId, role) {
    const bot = this.bots.get(botId);
    if (bot) {
      bot.role = role;
    }
  }

  // Убийство бота
  killBot(botId) {
    const bot = this.bots.get(botId);
    if (bot) {
      bot.alive = false;
    }
  }

  // Воскрешение бота (для доктора)
  reviveBot(botId) {
    const bot = this.bots.get(botId);
    if (bot) {
      bot.alive = true;
    }
  }

  // Генерация умного fallback ответа на основе контекста
  generateSmartFallback(bot, context, type) {
    const alivePlayers = context.players?.filter(p => p.alive && p.name !== bot.name) || [];
    const aliveNames = alivePlayers.map(p => p.name);
    
    switch (type) {
      case 'greeting':
        const greetings = [
          `Привіт! Я ${bot.name}, готовий до гри!`,
          `Всім привіт! ${bot.name} тут.`,
          `Доброго дня! Мене звати ${bot.name}.`,
          `Привіт, гравці! ${bot.name} на зв'язку.`,
          `Вітаю всіх! Я ${bot.name}.`
        ];
        return greetings[Math.floor(Math.random() * greetings.length)];
        
      case 'speech':
        const speeches = [
          `Я ${bot.name}. Потрібно бути уважним до поведінки гравців.`,
          `${bot.name} каже: давайте проаналізуємо ситуацію.`,
          `Як ${bot.name}, я думаю, що важливо слухати всіх.`,
          `${bot.name} тут. Поки що у мене немає чітких підозр.`,
          `Я ${bot.name}. Варто звернути увагу на деталі.`
        ];
        return speeches[Math.floor(Math.random() * speeches.length)];
        
      case 'vote':
        if (aliveNames.length > 0) {
          // Интеллектуальный выбор: избегаем голосовать за себя или за тех, кто уже получил много голосов
          const randomTarget = aliveNames[Math.floor(Math.random() * aliveNames.length)];
          return randomTarget;
        }
        return null;
        
      case 'night_action':
        if (aliveNames.length > 0) {
          return aliveNames[Math.floor(Math.random() * aliveNames.length)];
        }
        return null;
        
      default:
        return `Я ${bot.name}.`;
    }
  }

  // Получение статистики API провайдеров
  getAIProviderStats() {
    return this.aiProvider.getProviderStats();
  }

  // Сброс счетчиков ошибок для всех провайдеров
  resetAIProviderErrors() {
    this.aiProvider.providers.forEach(provider => {
      provider.errorCount = 0;
      provider.enabled = true;
    });
    console.log('[AI] Сброшены счетчики ошибок для всех провайдеров');
  }

  // Включение/выключение конкретного провайдера
  setAIProviderStatus(providerName, enabled) {
    this.aiProvider.setProviderStatus(providerName, enabled);
  }
}

module.exports = { BotManager }; 