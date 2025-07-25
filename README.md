# 🎭 AI Mafia Game 🇺🇦

**Гра українською мовою!** 🇺🇦

Інтерактивна гра "Мафія" з інтелектуальними AI ботами, що використовують Gemini API та Cohere API.

## 🎮 Особливості

- **AI боти** з реалістичною поведінкою та особистостями
- **Мульти-провайдерна система** з автоматичним перемиканням між Gemini та Cohere API
- **Оптимізація токенів** - система "ковзного вікна" для економії API запитів
- **Український інтерфейс** та локалізація
- **WebSocket** для реального часу
- **React** фронтенд з сучасним UI

## 🚀 Швидкий старт

### Встановлення залежностей

```bash
npm install
```

### Збірка клієнта

```bash
cd client
npm install
npm run build
cd ..
```

### Запуск сервера

```bash
node server.js
```

Сервер запуститься на порту 4000. Відкрийте http://localhost:4000 у браузері.

## 🔧 Конфігурація

### API ключі

1. **Скопіюйте** файл `env.example` в `.env`:
   ```bash
   cp env.example .env
   ```

2. **Заповніть** `.env` файл своїми API ключами:
   - **Gemini API**: отримайте на https://makersuite.google.com/app/apikey
   - **Cohere API**: отримайте на https://cohere.ai/

3. **Формат** `.env` файлу:
   ```env
   GEMINI_API_KEY_1=your_actual_gemini_key_1
   GEMINI_API_KEY_2=your_actual_gemini_key_2
   GEMINI_API_KEY_3=your_actual_gemini_key_3
   COHERE_API_KEY_1=your_actual_cohere_key_1
   COHERE_API_KEY_2=your_actual_cohere_key_2
   COHERE_API_KEY_3=your_actual_cohere_key_3
   ```

⚠️ **Важливо**: Файл `.env` не потрапить у Git репозиторій і залишиться локальним!

## 🎯 Ігровий процес

1. **Приєднайтеся** до гри з іменем
2. **Виберіть** кількість мафій (1-2) та ботів (0-10)
3. **Почніть гру** - ролі розподіляться автоматично
4. **Привітальна фаза** - боти представляться
5. **Нічна фаза** - мафія, лікар та комісар роблять вибори
6. **Денна фаза** - обговорення та голосування по черзі
7. **Повторюйте** до перемоги однієї зі сторін

## 🤖 AI Система

### Провайдери
- **Gemini API** (3 ключі) - основний провайдер
- **Cohere API** (3 ключі) - резервний провайдер
- **Fallback** - локальні відповіді при недоступності API

### Оптимізація токенів
- **Ковзне вікно** - боти бачать тільки релевантну історію
- **Результати ночі** - передаються всім ботам вранці
- **Детектив** - отримує інформацію про перевірки незалежно від порядку

### Особистості ботів
Кожен бот має унікальну особистість, що впливає на його рішення та стиль спілкування.

## 🛠️ Технології

- **Backend**: Node.js, Express, WebSocket
- **Frontend**: React, TypeScript
- **AI**: Gemini API, Cohere API
- **Стилі**: CSS3 з сучасним дизайном

## 📝 Ліцензія

MIT License

## 🤝 Внесок у проект

Вітаються pull requests та issues!

---

**Приємної гри!** 🎭 