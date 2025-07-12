const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
require('dotenv').config();
const path = require('path');
const { BotManager } = require('./BotManager');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let players = [];
let gameState = {
  phase: 'waiting', // waiting, night, day, finished
  players: [],
  round: 0,
  log: [],
  currentSpeaker: null,
  speakTimer: null,
};

let nightActions = {
  mafia: [], // [{from, target}]
  doctor: null, // {from, target}
  detective: null, // {from, target}
};



let dayVotes = {};
let dayTimeout = null;
let dayQueue = [];
let currentSpeakerIndex = 0;
let dayVoteResults = {};
let daySpeakTimeout = null;
let mafiaCount = 2; // Количество мафий по умолчанию
let botManager = new BotManager();
let botCount = 0; // Количество ботов для добавления
let botActions = new Map(); // Хранение действий ботов

// Логирование статистики API провайдеров каждые 5 минут
setInterval(() => {
  const stats = botManager.getAIProviderStats();
  console.log('[AI STATS] Статистика провайдеров:', stats);
}, 5 * 60 * 1000); // 5 минут

function resetNightActions() {
  nightActions = { mafia: [], doctor: null, detective: null };
}

function allNightActionsDone() {
  const allPlayers = [...players, ...botManager.getAllBots()];
  const mafiaCount = allPlayers.filter(p => p.role === 'mafia' && p.alive).length;
  const mafiaVotes = nightActions.mafia.length;
  const doctorDone = allPlayers.some(p => p.role === 'doctor' && p.alive) ? !!nightActions.doctor : true;
  const detectiveDone = allPlayers.some(p => p.role === 'detective' && p.alive) ? !!nightActions.detective : true;
  
  // Для мафии: все должны проголосовать, и теперь ночь может закончиться
  // так как у нас есть логика разрешения конфликтов
  return mafiaVotes === mafiaCount && doctorDone && detectiveDone;
}

function getMafiaConsensus() {
  const allPlayers = [...players, ...botManager.getAllBots()];
  const mafiaCount = allPlayers.filter(p => p.role === 'mafia' && p.alive).length;
  if (mafiaCount === 0) return null;
  
  // Если мафия одна, то её голос решающий
  if (mafiaCount === 1) {
    return nightActions.mafia[0]?.target || null;
  }
  
  // Если мафии две или больше, применяем новую логику
  if (nightActions.mafia.length < mafiaCount) {
    return null; // Не все мафии проголосовали
  }
  
  // Проверяем, есть ли среди мафий реальные игроки
  const mafiaPlayers = allPlayers.filter(p => p.role === 'mafia' && p.alive);
  const humanMafia = mafiaPlayers.filter(p => !p.isBot);
  const botMafia = mafiaPlayers.filter(p => p.isBot);
  
  // Если есть реальный игрок среди мафии, его выбор приоритетный
  if (humanMafia.length > 0) {
    const humanVote = nightActions.mafia.find(vote => 
      humanMafia.some(human => human.name === vote.from)
    );
    if (humanVote) {
      console.log(`[MAFIA] Приоритет голосу людини: ${humanVote.from} -> ${humanVote.target}`);
      return humanVote.target;
    }
  }
  
  // Если все мафии - боты, случайно выбираем одну из целей
  if (botMafia.length === mafiaCount) {
    const targets = nightActions.mafia.map(vote => vote.target);
    const randomTarget = targets[Math.floor(Math.random() * targets.length)];
    console.log(`[MAFIA] Випадковий вибір між ботами: ${targets.join(', ')} -> ${randomTarget}`);
    return randomTarget;
  }
  
  // Если есть и люди, и боты, но голос человека не найден, используем случайный выбор
  const targets = nightActions.mafia.map(vote => vote.target);
  const randomTarget = targets[Math.floor(Math.random() * targets.length)];
  console.log(`[MAFIA] Випадковий вибір (змішана ситуація): ${targets.join(', ')} -> ${randomTarget}`);
  return randomTarget;
}

function startNightPhase() {
  resetNightActions();
  gameState.phase = 'night';
  gameState.round = (gameState.round || 0) + 1;
  gameState.log.push(`У місті настала ніч #${gameState.round}. Всі засинають...`);
  broadcastGameState();
  
  // Автоматически выполняем ночные действия ботов
  setTimeout(() => {
    executeBotNightActions();
  }, 3000);
}

async function executeBotNightActions() {
  const allPlayers = [...players, ...botManager.getAllBots()];
  const bots = botManager.getAliveBots();
  
  for (const bot of bots) {
    if (bot.role === 'mafia' || bot.role === 'doctor' || bot.role === 'detective') {
      try {
        console.log(`[NIGHT] Бот ${bot.name} (${bot.role}) виконує нічне дію...`);
        const target = await botManager.generateNightAction(bot, allPlayers, nightActions);
        console.log(`[NIGHT] Бот ${bot.name} вибрав ціль: ${target}`);
        
        if (bot.role === 'mafia') {
          // Удаляем предыдущий голос этого бота, если он есть
          nightActions.mafia = nightActions.mafia.filter(a => a.from !== bot.name);
          // Добавляем новый голос
          nightActions.mafia.push({ from: bot.name, target: target });
          
          // Отправляем информацию о голосах мафии всем мафиям
          const mafiaPlayers = allPlayers.filter(p => p.role === 'mafia' && p.alive);
          const mafiaVotes = nightActions.mafia.map(vote => ({
            from: vote.from,
            target: vote.target
          }));
          
          mafiaPlayers.forEach(mafiaPlayer => {
            if (mafiaPlayer.ws && mafiaPlayer.ws.readyState === WebSocket.OPEN) {
              mafiaPlayer.ws.send(JSON.stringify({
                type: 'mafia_votes',
                votes: mafiaVotes,
                consensus: getMafiaConsensus()
              }));
            }
          });
        } else if (bot.role === 'doctor') {
          nightActions.doctor = { from: bot.name, target: target };
        } else if (bot.role === 'detective') {
          nightActions.detective = { from: bot.name, target: target };
        }
        
        // Обновляем память бота
        botManager.updateBotMemory(bot.id, {
          type: 'night_action',
          role: bot.role,
          target: target,
          round: gameState.round
        });
        
      } catch (error) {
        console.error(`Ошибка виконання нічного дії бота ${bot.name}:`, error);
        
        // Логируем статистику провайдеров при ошибках
        if (error.message.includes('429') || error.message.includes('rate limit')) {
          const stats = botManager.getAIProviderStats();
          console.log('[AI ERROR] Статистика провайдеров после ошибки:', stats);
        }
      }
    }
    
    // Задержка между действиями ботов (уменьшена для более быстрой игры)
    await new Promise(resolve => setTimeout(resolve, 4000));
  }
  
  // Проверяем, можно ли закончить ночь
  if (allNightActionsDone()) {
    finishNight();
  }
}

function handleNightAction(data, ws) {
  const player = players.find((p) => p.ws === ws);
  if (!player || !player.alive) return;
  
  const allPlayers = [...players, ...botManager.getAllBots()];
  
  if (player.role === 'mafia' && data.target) {
    // Удаляем предыдущий голос этого игрока, если он есть
    nightActions.mafia = nightActions.mafia.filter(a => a.from !== player.name);
    // Добавляем новый голос
    nightActions.mafia.push({ from: player.name, target: data.target });
    
    // Отправить информацию о голосах мафии всем мафиям
    const mafiaPlayers = allPlayers.filter(p => p.role === 'mafia' && p.alive);
    const mafiaVotes = nightActions.mafia.map(vote => ({
      from: vote.from,
      target: vote.target
    }));
    
    mafiaPlayers.forEach(mafiaPlayer => {
      if (mafiaPlayer.ws && mafiaPlayer.ws.readyState === WebSocket.OPEN) {
        mafiaPlayer.ws.send(JSON.stringify({
          type: 'mafia_votes',
          votes: mafiaVotes,
          consensus: getMafiaConsensus()
        }));
      }
    });
  }
  if (player.role === 'doctor' && data.target) {
    nightActions.doctor = { from: player.name, target: data.target };
  }
  if (player.role === 'detective' && data.target) {
    nightActions.detective = { from: player.name, target: data.target };
  }
  
  // Проверяем, можно ли закончить ночь
  if (allNightActionsDone()) {
    finishNight();
  }
}

function startDayPhase() {
  gameState.phase = 'day';
  gameState.log.push('Настав день. Обговорення та голосування по черзі!');
  
  // Создаем очередь из всех игроков (реальных и ботов)
  const allPlayers = [...players, ...botManager.getAllBots()];
  dayQueue = allPlayers
    .map((p, idx) => ({ idx, alive: p.alive, isBot: p.isBot || false }))
    .filter(p => p.alive)
    .map(p => p.idx);
  
  currentSpeakerIndex = 0;
  dayVoteResults = {};
  gameState.currentSpeaker = null;
  gameState.speakTimer = null;
  
  // Сбрасываем историю дня для оптимизации токенов
  botManager.resetDayHistory();
  
  broadcastGameState();
  startNextSpeaker();
}

function startNextSpeaker() {
  if (daySpeakTimeout) clearTimeout(daySpeakTimeout);
  if (currentSpeakerIndex >= dayQueue.length) {
    finishDaySequential();
    return;
  }
  
  const speakerIndex = dayQueue[currentSpeakerIndex];
  const allPlayers = [...players, ...botManager.getAllBots()];
  const speaker = allPlayers[speakerIndex];
  
  gameState.currentSpeaker = speakerIndex;
  gameState.speakTimer = null;
  broadcastGameState();
  
  // Если это бот, автоматически запускаем таймер и генерируем речь и голос
  if (speaker && speaker.isBot) {
    // Сразу запускаем таймер для бота
    gameState.speakTimer = 5;
    broadcastGameState();
    
    setTimeout(async () => {
      try {
        console.log(`[DAY] Бот ${speaker.name} генерує речь...`);
        // Генерируем речь бота с оптимизированным промптом
        const speech = await botManager.generateDaySpeech(speaker, allPlayers, currentSpeakerIndex);
        gameState.log.push({ text: `${speaker.name}: ${speech}`, type: 'bot', from: speaker.name });
        // Добавляем сообщение в историю дня для следующих ботов
        botManager.addDayMessage(speaker.name, speech);
        broadcastGameState();
        
        // Ждем 4 секунды, затем генерируем голос
        setTimeout(async () => {
          try {
            console.log(`[DAY] Генеруємо голос для бота ${speaker.name}...`);
            const vote = await botManager.generateDayVote(speaker, allPlayers, dayVoteResults);
            console.log(`[DAY] Бот ${speaker.name} проголосував за: ${vote}`);
            handleDayVoteSequential({ target: vote }, null, false);
          } catch (error) {
            console.error('Ошибка генерации голоса бота:', error);
            handleDayVoteSequential({ target: null }, null, false);
          }
        }, 4000);
      } catch (error) {
        console.error('Ошибка генерации речи бота:', error);
        handleDayVoteSequential({ target: null }, null, false);
      }
    }, 4000);
  }
}

function handleDayVoteSequential(data, ws, isTimeout = false) {
  const idx = gameState.currentSpeaker;
  if (typeof idx !== 'number') return;
  
  const allPlayers = [...players, ...botManager.getAllBots()];
  const currentPlayer = allPlayers[idx];
  
  console.log(`Обробка голосування: гравець=${currentPlayer?.name}, голос=${data.target}, isBot=${currentPlayer?.isBot}, ws=${!!ws}`);
  
  // Проверяем, что голосует правильный игрок (человек или бот)
  if (!isTimeout && ws && currentPlayer && !currentPlayer.isBot && currentPlayer.ws !== ws) {
    console.log('Голос відхилено: неправильний гравець');
    return; // Только текущий игрок-человек может голосовать через WebSocket
  }
  
  dayVoteResults[idx] = data.target; // Может быть null (пропуск)
  console.log(`Голос прийнятий: ${currentPlayer?.name} -> ${data.target}`);
  if (daySpeakTimeout) clearTimeout(daySpeakTimeout);
  currentSpeakerIndex++;
  startNextSpeaker();
}

function finishDaySequential() {
  if (daySpeakTimeout) clearTimeout(daySpeakTimeout);
  gameState.currentSpeaker = null;
  gameState.speakTimer = null;
  
  const allPlayers = [...players, ...botManager.getAllBots()];
  
  // Подсчёт голосов
  const voteCounts = {};
  Object.values(dayVoteResults).forEach((name) => {
    if (name) voteCounts[name] = (voteCounts[name] || 0) + 1;
  });
  let max = 0;
  let exiled = null;
  for (const name in voteCounts) {
    if (voteCounts[name] > max) {
      max = voteCounts[name];
      exiled = name;
    }
  }
  let logMsg = '';
  if (exiled) {
    const player = allPlayers.find(p => p.name === exiled);
    if (player) {
      player.alive = false;
      if (player.isBot) {
        botManager.killBot(player.id);
      }
    }
    logMsg = `Вдень за голосуванням вигнано гравця ${exiled}.`;
  } else {
    logMsg = 'Нікого не було вигнано.';
  }
  gameState.log.push(logMsg);
  gameState.players = allPlayers.map((p) => ({ name: p.name, alive: p.alive }));
  
  // Проверка победы
  const mafiaAlive = allPlayers.filter(p => p.role === 'mafia' && p.alive).length;
  const citizensAlive = allPlayers.filter(p => p.role !== 'mafia' && p.alive).length;
  if (mafiaAlive === 0) {
    gameState.phase = 'finished';
    gameState.log.push('Перемога мирних!');
    broadcastGameState();
    return;
  }
  if (mafiaAlive >= citizensAlive) {
    gameState.phase = 'finished';
    gameState.log.push('Перемога мафії!');
    broadcastGameState();
    return;
  }
  // Следующая ночь
  startNightPhase();
}

function finishDay() {
  // Подсчёт голосов
  const voteCounts = {};
  Object.values(dayVotes).forEach((name) => {
    if (name) voteCounts[name] = (voteCounts[name] || 0) + 1;
  });
  let max = 0;
  let exiled = null;
  for (const name in voteCounts) {
    if (voteCounts[name] > max) {
      max = voteCounts[name];
      exiled = name;
    }
  }
  let logMsg = '';
  if (exiled) {
    const player = players.find(p => p.name === exiled);
    if (player) player.alive = false;
    logMsg = `Днём по голосованию изгнан игрок ${exiled}.`;
  } else {
    logMsg = 'Никто не был изгнан.';
  }
  gameState.log.push(logMsg);
  gameState.players = players.map((p) => ({ name: p.name, alive: p.alive }));
  // Проверка победы
  const mafiaAlive = players.filter(p => p.role === 'mafia' && p.alive).length;
  const citizensAlive = players.filter(p => p.role !== 'mafia' && p.alive).length;
  if (mafiaAlive === 0) {
    gameState.phase = 'finished';
    gameState.log.push('Победа мирных!');
    broadcastGameState();
    return;
  }
  if (mafiaAlive >= citizensAlive) {
    gameState.phase = 'finished';
    gameState.log.push('Победа мафии!');
    broadcastGameState();
    return;
  }
  // Следующая ночь
  startNightPhase();
}

function finishNight() {
  const allPlayers = [...players, ...botManager.getAllBots()];
  
  // Получаем консенсус мафии
  const mafiaTarget = getMafiaConsensus();
  // Доктор
  const saved = nightActions.doctor ? nightActions.doctor.target : null;
  // Комиссар
  const checked = nightActions.detective ? nightActions.detective.target : null;
  const checkedRole = checked ? (allPlayers.find((p) => p.name === checked)?.role || null) : null;

  // Итоги ночи
  let killed = null;
  if (mafiaTarget && mafiaTarget !== saved) {
    const victim = allPlayers.find((p) => p.name === mafiaTarget);
    if (victim) {
      victim.alive = false;
      if (victim.isBot) {
        botManager.killBot(victim.id);
      }
      killed = mafiaTarget;
    }
  }

  // Лог
  let logMsg = '';
  if (killed) {
    logMsg += `Вночі було вбито гравця ${killed}.\n`;
  } else if (mafiaTarget) {
    logMsg += `Лікар врятував гравця ${mafiaTarget}!\n`;
  } else {
    logMsg += 'Вночі ніхто не постраждав.\n';
  }
  if (checked) {
    const detective = allPlayers.find((p) => p.role === 'detective');
    const checkedPlayer = allPlayers.find((p) => p.name === checked);
    
    console.log('Проверка комиссара:', { 
      checked, 
      checkedRole, 
      checkedPlayerAlive: checkedPlayer ? checkedPlayer.alive : 'player not found',
      detective: detective ? detective.name : 'null',
      detectiveAlive: detective ? detective.alive : 'null',
      wsReady: detective ? (detective.ws ? detective.ws.readyState : 'bot') : 'null'
    });
    
    if (detective) {
      if (detective.ws && detective.ws.readyState === WebSocket.OPEN) {
        // Реальный игрок
        if (checkedPlayer && checkedPlayer.alive) {
          console.log('Відправляємо результат комісару:', { target: checked, role: checkedRole });
          detective.ws.send(JSON.stringify({ type: 'detective_result', target: checked, role: checkedRole }));
        } else {
          console.log('Перевірений гравець мертвий або не знайдений, відправляємо повідомлення про смерть');
          detective.ws.send(JSON.stringify({ type: 'detective_result', target: checked, role: 'dead' }));
        }
      } else if (detective.isBot) {
        // Бот
        if (checkedPlayer && checkedPlayer.alive) {
          botManager.addDetectiveResult(detective.id, checked, checkedRole);
        } else {
          botManager.addDetectiveResult(detective.id, checked, 'dead');
        }
      }
    } else {
      console.log('Комиссар не найден');
    }
  }
  gameState.log.push(logMsg);
  gameState.players = allPlayers.map((p) => ({ name: p.name, alive: p.alive }));
  
  // Устанавливаем результаты ночи для ботов (оптимизация токенов)
  botManager.setNightResults(logMsg);
  
  // Проверка победы после ночи
  const mafiaAlive = allPlayers.filter(p => p.role === 'mafia' && p.alive).length;
  const citizensAlive = allPlayers.filter(p => p.role !== 'mafia' && p.alive).length;
  if (mafiaAlive === 0) {
    gameState.phase = 'finished';
    gameState.log.push('Перемога мирних!');
    broadcastGameState();
    return;
  }
  if (mafiaAlive >= citizensAlive) {
    gameState.phase = 'finished';
    gameState.log.push('Перемога мафії!');
    broadcastGameState();
    return;
  }
  
  gameState.phase = 'day';
  broadcastGameState();
  startDayPhase();
  resetNightActions();
}

function assignRoles() {
  let roles = [];
  const totalPlayers = players.length + botManager.getAllBots().length;
  const actualMafiaCount = Math.min(mafiaCount, Math.floor(totalPlayers / 2)); // Не больше половины игроков
  
  if (totalPlayers >= 4) {
    roles = [
      ...Array(actualMafiaCount).fill('mafia'),
      'doctor',
      'detective',
      ...Array(totalPlayers - actualMafiaCount - 2).fill('citizen')
    ];
  } else if (totalPlayers === 3) {
    roles = ['mafia', 'doctor', 'citizen'];
  } else if (totalPlayers === 2) {
    roles = ['mafia', 'citizen'];
  } else if (totalPlayers === 1) {
    roles = ['mafia'];
  }
  
  console.log('Розподіл ролей:', { players: players.length, mafiaCount: actualMafiaCount, roles });
  
  // Перемешиваем роли
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }
  
  // Распределяем роли между реальными игроками и ботами
  let roleIndex = 0;
  
  // Сначала распределяем роли реальным игрокам
  players.forEach((p, i) => {
    if (!p.isBot) {
      p.role = roles[roleIndex];
      p.alive = true;
      roleIndex++;
      // Отправляем индивидуальное сообщение о роли
      if (p.ws.readyState === WebSocket.OPEN) {
        p.ws.send(JSON.stringify({ type: 'role', role: p.role }));
      }
    }
  });
  
  // Затем распределяем роли ботам
  const bots = botManager.getAllBots();
  bots.forEach((bot) => {
    if (roleIndex < roles.length) {
      bot.role = roles[roleIndex];
      bot.alive = true;
      roleIndex++;
      botManager.setBotRole(bot.id, bot.role);
    }
  });
}

function startGame() {
  // Создаем ботов перед началом игры
  botManager.clearBots(); // Очищаем старых ботов
  for (let i = 0; i < botCount; i++) {
    botManager.createBot();
  }
  
  assignRoles();
  startIntroDayPhase();
}

function startIntroDayPhase() {
  gameState.phase = 'intro_day';
  gameState.log.push('Гра починається! Обговорення по черзі без голосування.');
  
  // Создаем очередь из всех игроков (реальных и ботов)
  const allPlayers = [...players, ...botManager.getAllBots()];
  dayQueue = allPlayers
    .map((p, idx) => ({ idx, alive: p.alive, isBot: p.isBot || false }))
    .filter(p => p.alive)
    .map(p => p.idx);
  
  currentSpeakerIndex = 0;
  dayVoteResults = {};
  gameState.currentSpeaker = null;
  gameState.speakTimer = null;
  startNextIntroSpeaker();
}

function startNextIntroSpeaker() {
  if (daySpeakTimeout) clearTimeout(daySpeakTimeout);
  if (currentSpeakerIndex >= dayQueue.length) {
    startNightPhase();
    return;
  }
  
  const speakerIndex = dayQueue[currentSpeakerIndex];
  const allPlayers = [...players, ...botManager.getAllBots()];
  const speaker = allPlayers[speakerIndex];
  
  gameState.currentSpeaker = speakerIndex;
  gameState.speakTimer = null;
  broadcastGameState();
  
  // Если это бот, автоматически генерируем его речь
  if (speaker && speaker.isBot) {
    setTimeout(async () => {
      try {
        console.log(`[INTRO] Бот ${speaker.name} генерує привітання...`);
        const greeting = await botManager.generateBotGreeting(speaker, allPlayers);
        gameState.log.push({ text: `${speaker.name}: ${greeting}`, type: 'bot', from: speaker.name });
        broadcastGameState();
        
        // Переходим к следующему игроку через 4 секунды
        setTimeout(() => {
          currentSpeakerIndex++;
          startNextIntroSpeaker();
        }, 4000);
      } catch (error) {
        console.error('Ошибка генерации приветствия бота:', error);
        currentSpeakerIndex++;
        startNextIntroSpeaker();
      }
    }, 4000);
  }
}

wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'join') {
        if (!players.find((p) => p.name === data.name)) {
          const player = { name: data.name, ws, alive: true, role: null };
          players.push(player);
          const allPlayers = [...players, ...botManager.getAllBots()];
          gameState.players = allPlayers.map((p) => ({ name: p.name, alive: p.alive }));
          broadcastGameState();
        }
      }
      if (data.type === 'start') {
        console.log('Отримано подію start:', { phase: gameState.phase, players: players.length, mafiaCount: data.mafiaCount, botCount: data.botCount });
        if (gameState.phase === 'waiting') {
          // Обновляем количество мафий из сообщения
          if (data.mafiaCount && (data.mafiaCount === 1 || data.mafiaCount === 2)) {
            mafiaCount = data.mafiaCount;
            console.log('Установлено кількість мафій:', mafiaCount);
          }
          
          // Обновляем количество ботов из сообщения
          if (data.botCount && data.botCount >= 0 && data.botCount <= 10) {
            botCount = data.botCount;
            console.log('Установлено кількість ботів:', botCount);
          }
          
          console.log('Виклик startGame()');
          startGame();
        }
      }
      if (data.type === 'night_action') {
        handleNightAction(data, ws);
      }
      if (data.type === 'day_vote') {
        const player = players.find((p) => p.ws === ws);
        if (player && player.alive) {
          handleDayVoteSequential(data, ws);
        }
      }
      if (data.type === 'start_speak') {
        if (gameState.phase === 'intro_day') {
          const idx = gameState.currentSpeaker;
          if (typeof idx === 'number' && players[idx] && players[idx].ws === ws && players[idx].alive) {
            if (daySpeakTimeout) clearTimeout(daySpeakTimeout);
            gameState.speakTimer = 5;
            broadcastGameState();
            daySpeakTimeout = setTimeout(() => {
              gameState.speakTimer = null;
              broadcastGameState();
              currentSpeakerIndex++;
              startNextIntroSpeaker();
            }, 5000);
          }
          return;
        }
        const idx = gameState.currentSpeaker;
        if (typeof idx === 'number' && players[idx] && players[idx].ws === ws && players[idx].alive) {
          if (daySpeakTimeout) clearTimeout(daySpeakTimeout);
          gameState.speakTimer = 5;
          broadcastGameState();
          daySpeakTimeout = setTimeout(() => {
            gameState.speakTimer = null;
            broadcastGameState();
            // Не переходим к следующему игроку, ждём голосования
            // Таймер истек, но игрок может продолжать голосовать
          }, 5000);
        }
      }
      if (data.type === 'finish_night') {
        finishNight();
      }
      if (data.type === 'restart') {
        // Сброс игры, но сохраняем игроков
        players.forEach(p => {
          p.alive = true;
          p.role = null;
        });
        
        // Очищаем ботов
        botManager.clearBots();
        
        gameState = {
          phase: 'waiting',
          players: players.map((p) => ({ name: p.name, alive: p.alive })),
          round: 0,
          log: [],
          currentSpeaker: null,
          speakTimer: null,
        };
        resetNightActions();
        dayVotes = {};
        dayVoteResults = {};
        dayQueue = [];
        currentSpeakerIndex = 0;
        if (daySpeakTimeout) clearTimeout(daySpeakTimeout);
        broadcastGameState();
      }
    } catch (e) { /* ignore */ }
  });
  ws.send(JSON.stringify({ type: 'state', state: gameState }));
});

function broadcastGameState() {
  const allPlayers = [...players, ...botManager.getAllBots()];
  const state = JSON.stringify({ 
    type: 'state', 
    state: {
      ...gameState,
      players: allPlayers.map((p) => ({ name: p.name, alive: p.alive }))
    }
  });
  players.forEach((p) => {
    if (p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(state);
    }
  });
}

app.get('/favicon.ico', (req, res) => res.status(204).end());

app.use(express.static(path.join(__dirname, 'client', 'build')));
app.get(/^\/((?!api|ws).)*$/, (req, res) => {
  res.sendFile(path.join(__dirname, 'client', 'build', 'index.html'));
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
}); 