/**
 * Тесты общей логики агента (`agent-core.js`).
 *
 * Запуск: node --test server/agent-core.test.js
 * Зависимостей нет.
 *
 * Этот модуль используют ДВА рантайма: Node-сервер на VPS и Cloudflare
 * Worker. Тест защищает от расхождения: если правила поменяются в одном
 * месте, сломается оба. Кейсы взяты из боевого поведения:
 *   - honeypot от ботов должен «проходить», но не отправляться;
 *   - согласие на обработку ПДн обязательно (152-ФЗ);
 *   - в текст заявки не должны попасть сырые HTML-теги.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EMPTY_REPLY,
  FALLBACK_REPLY,
  KNOWLEDGE,
  buildLlmMessages,
  escapeHtml,
  findKnowledge,
  formatLeadMessage,
  validateLead,
} from './agent-core.js';

/* ── Поиск по базе знаний ────────────────────────────────────────────── */

test('findKnowledge: находит ответ по ключевому слову', () => {
  const answer = findKnowledge('сколько стоит лендинг');
  assert.ok(answer, 'ответ должен найтись');
  assert.match(answer, /по запросу/);
});

test('findKnowledge: не находит ответа по бессмысленному запросу', () => {
  assert.equal(findKnowledge('квантовая физика холодильника'), null);
});

test('findKnowledge: регистр не влияет на поиск', () => {
  assert.ok(findKnowledge('СКОЛЬКО СТОИТ'));
});

test('findKnowledge: у каждого правила есть ключевые слова и ответ', () => {
  for (const item of KNOWLEDGE) {
    assert.ok(item.keywords.length > 0, 'у правила должны быть keywords');
    assert.ok(item.answer.length > 20, 'ответ должен быть содержательным');
  }
});

test('findKnowledge: ни один ответ не содержит конкретных цен', () => {
  // Политика AI_CONTENT_POLICY: цены — только по запросу.
  for (const item of KNOWLEDGE) {
    assert.doesNotMatch(item.answer, /\d+\s*(₽|руб)/i, `в ответе есть цена: ${item.answer}`);
  }
});

/**
 * Регресс: 28.10.2026 бот на вопрос «Что такое GEO?» уходил в LLM и отвечал
 * «GEO — это сокращение от Geographic или Geolocation» — то есть выдумывал
 * определение вместо «Generative Engine Optimization». Правильный ответ был в
 * FAQ сайта (`src/data/site.ts`), но не в базе знаний бота: запрос не
 * находился по ключевым словам и уходил в модель.
 */
test('findKnowledge: GEO отвечает правильным определением, а не уходит в LLM', () => {
  for (const question of ['Что такое GEO?', 'что такое geo', 'GEO', 'расскажи про GEO и AEO']) {
    const answer = findKnowledge(question);
    assert.ok(answer, `вопрос «${question}» должен находиться в базе знаний`);
    assert.match(answer, /Generative Engine Optimization/, `ответ на «${question}» врёт про GEO`);
    assert.doesNotMatch(answer, /Geographic|Geolocation/i, `ответ на «${question}» путает GEO с геолокацией`);
  }
});

test('findKnowledge: SEO объясняется как поисковая оптимизация', () => {
  const answer = findKnowledge('что такое SEO');
  assert.ok(answer);
  assert.match(answer, /технический аудит|микроразметка/i);
});

test('FACTS: системный промпт содержит верное определение GEO', () => {
  // Промпт — страховка на тот случай, если вопрос не нашёлся в базе знаний
  // и ушёл в модель: модель обязана знать, чем GEO отличается от геолокации.
  const prompt = buildLlmMessages([], 'Что такое GEO?').find((m) => m.role === 'system');
  assert.ok(prompt, 'системный промпт должен быть');
  assert.match(prompt.content, /Generative Engine Optimization/);
  assert.doesNotMatch(prompt.content, /Geographic|Geolocation/i);
});

/* ── Валидация заявки ────────────────────────────────────────────────── */

test('validateLead: принимает корректную заявку', () => {
  const result = validateLead({
    name: 'Иван',
    contact: '+7 999 000 00 00',
    service: 'seo',
    consent: true,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.lead.name, 'Иван');
  assert.equal(result.lead.service, 'seo');
});

test('validateLead: требует согласие на обработку ПДн', () => {
  const result = validateLead({
    name: 'Иван',
    contact: '+7 999 000 00 00',
    service: 'seo',
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('consent'));
});

test('validateLead: согласие принимается в разных форматах', () => {
  for (const consent of [true, 'true', 'on']) {
    const result = validateLead({
      name: 'Иван',
      contact: '+7 999 000 00 00',
      service: 'seo',
      consent,
    });
    assert.equal(result.ok, true, `consent=${consent} должен приниматься`);
  }
});

test('validateLead: отсекает слишком короткие имя и контакт', () => {
  const result = validateLead({
    name: 'И',
    contact: '+7',
    service: 'seo',
    consent: true,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('name'));
  assert.ok(result.errors.includes('contact'));
});

test('validateLead: honeypot — бот получает «успех», но заявка не валидна', () => {
  const result = validateLead({
    name: 'Бот',
    contact: '+7 999 000 00 00',
    service: 'seo',
    consent: true,
    website: 'http://spam.example',
  });
  assert.equal(result.honeypot, true);
  assert.equal(result.errors.length, 0);
});

test('validateLead: обрезает слишком длинные поля', () => {
  const result = validateLead({
    name: 'Иван',
    contact: '+7 999 000 00 00',
    service: 'seo',
    comment: 'x'.repeat(5000),
    business: 'y'.repeat(500),
    consent: true,
  });
  assert.equal(result.lead.comment.length, 2000);
  assert.equal(result.lead.business.length, 200);
});

/* ── Форматирование заявки для Telegram ──────────────────────────────── */

test('escapeHtml: экранирует HTML-теги', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
});

test('formatLeadMessage: содержит имя, контакт и услугу', () => {
  const text = formatLeadMessage({
    name: 'Иван',
    contact: '+7 999 000 00 00',
    service: 'seo',
    business: '',
    comment: '',
    source: '/',
  });
  assert.match(text, /Иван/);
  assert.match(text, /\+7 999 000 00 00/);
  assert.match(text, /SEO, GEO/);
});

test('formatLeadMessage: HTML в имени экранируется', () => {
  const text = formatLeadMessage({
    name: '<b>жирный</b>',
    contact: '+7 999 000 00 00',
    service: 'seo',
  });
  assert.ok(!text.includes('<b>жирный</b>'), 'сырой HTML не должен попасть в сообщение');
  assert.match(text, /&lt;b&gt;/);
});

test('formatLeadMessage: неизвестная услуга не ломает сообщение', () => {
  const text = formatLeadMessage({ name: 'Иван', contact: '+7999', service: 'unknown-xyz' });
  assert.match(text, /unknown-xyz/);
});

/* ── Промпт для LLM ──────────────────────────────────────────────────── */

test('buildLlmMessages: системный промпт первый, вопрос последний', () => {
  const messages = buildLlmMessages([], 'Сколько стоит?');
  assert.equal(messages[0].role, 'system');
  assert.equal(messages.at(-1).content, 'Сколько стоит?');
});

test('buildLlmMessages: роль бота превращается в assistant', () => {
  const messages = buildLlmMessages([{ role: 'bot', text: 'Привет' }], 'Вопрос');
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[1].content, 'Привет');
});

test('buildLlmMessages: в системный промпт попадают факты', () => {
  const messages = buildLlmMessages([], 'x');
  assert.match(messages[0].content, /ФАКТЫ О КОМПАНИИ/);
  assert.match(messages[0].content, /AI-Traffic PRO/);
});

test('buildLlmMessages: промпт запрещает выдумывать цены', () => {
  const messages = buildLlmMessages([], 'x');
  assert.match(messages[0].content, /Не выдумывай цены/);
});

/* ── Fallback-тексты ─────────────────────────────────────────────────── */

test('fallback-тексты предлагают написать в Telegram', () => {
  assert.match(FALLBACK_REPLY, /Telegram/);
  assert.match(EMPTY_REPLY, /Telegram/);
});
