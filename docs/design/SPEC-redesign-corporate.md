# Спецификация редизайна: Corporate Elegance Hub (справочник)

Источник референса: <https://motiondesignspain.github.io/Google-Stitch-Style-Hub/demos/corporate.html>
Локальная копия темы: `docs/design/theme-corporate.css` (497 строк) и `docs/design/README-corporate.md`.

Задача: переделать главную страницу `src/pages/index.astro` (и её компоненты) под
Corporate Elegance Hub, **сохранив весь контент, структуру секций, логику форм и API**.

## 1. Точные токены темы (из `:root` референса)

| Токен | Значение | Назначение |
|-------|----------|------------|
| `--stitch-color-text` | `#172b4d` | основной текст (тёмно-синий, не чёрный) |
| `--stitch-color-text-muted` | `#5e6c84` | вторичный текст |
| `--stitch-color-bg` | `#f4f5f7` | фон страницы (серо-голубой) |
| `--stitch-color-surface` | `#ffffff` | карточки, поверхности |
| `--stitch-color-border` | `#dfe1e6` | границы |
| `--stitch-color-primary` | `#0052cc` | основной акцент (насыщенный синий) |
| `--stitch-color-primary-hover` | `#0047b3` | hover акцента |
| `--stitch-color-danger` | `#de350b` | ошибки |
| `--stitch-color-success` | `#00875a` | успех |
| `--stitch-radius-sm` | `4px` | кнопки, поля, бейджи |
| `--stitch-radius-md` | `8px` | карточки, контейнеры |
| `--stitch-space-sm/md/lg` | `8 / 16 / 24px` | внутренние отступы |
| `--stitch-shadow-sm` | `0 1px 2px rgba(9,30,66,.05)` | карточка в покое |
| `--stitch-shadow-md` | `0 4px 8px -2px rgba(9,30,66,.08), 0 0 1px rgba(9,30,66,.08)` | карточка при hover |
| `--stitch-shadow-hover` | `0 8px 16px -4px rgba(9,30,66,.12), 0 0 1px rgba(9,30,66,.08)` | контейнер при hover |

**Важно:** тени в референсе **горизонтальные и мягкие** (большой blur, малый offset),
а не «объёмные» как в текущей версии проекта. Токены тени имеют синий подтон `rgba(9,30,66,…)`.

## 2. Маппинг токенов проекта → токены референса

Текущие токены в `src/styles/global.css` (`--color-*`, `--shadow-*`) нужно заменить:

| Сейчас | Должно стать |
|--------|--------------|
| `--color-primary: #1e3a5f` | `--color-primary: #0052cc` |
| `--color-primary-container: #2d5a87` | `--color-primary-container: #0052cc` |
| `--color-on-primary: #ffffff` | без изменений |
| `--color-surface: #f5f7fa` | `--color-surface: #f4f5f7` |
| `--color-surface-container-lowest: #ffffff` | без изменений |
| `--color-surface-container-low: #eef1f6` | `#ebecf0` (hover-подложка полей из референса) |
| `--color-surface-container: #e4e8f0` | `#ebecf0` |
| `--color-surface-container-high: #d8dde6` | `#f4f5f7` |
| `--color-on-surface: #0f1a2e` | `#172b4d` |
| `--color-on-surface-variant: #4a5568` | `#5e6c84` |
| `--color-outline: #6b7280` | `#5e6c84` |
| `--color-outline-variant: #d1d5db` | `#dfe1e6` |
| `--color-line: #e5e7eb` | `#dfe1e6` |
| `--color-error: #dc2626` | `#de350b` |
| `--shadow-soft` | `0 1px 2px rgba(9,30,66,.05)` |
| `--shadow-card` | `0 4px 8px -2px rgba(9,30,66,.08), 0 0 1px rgba(9,30,66,.08)` |
| `--shadow-elevated` | `0 8px 16px -4px rgba(9,30,66,.12), 0 0 1px rgba(9,30,66,.08)` |

## 3. Ключевые визуальные паттерны референса

1. **Карточки** (`stitch-card`): белый фон, граница `#dfe1e6`, radius **8px**,
   тень `shadow-sm`, при hover `shadow-md` + `translateY(-2px)`.
2. **Кнопки**: `padding: 10px 20px`, `font-size: .875rem`, `font-weight: 500`,
   radius **4px** (не 8px!), `transition: all .2s`. Primary — заливка `#0052cc`,
   тень `0 1px 2px rgba(9,30,66,.2)`. Secondary — белый фон + серая граница.
3. **Заголовки секций**: `stitch-section-title` — `1.25rem`, weight **500**,
   `padding-bottom: 8px`, `border-bottom: 2px solid #dfe1e6`.
4. **H1**: `2rem`, weight **700** (референс скромный; в проекте H1 крупнее —
   можно оставить крупный, но насыщенность `#172b4d` и без «объёмной» тени).
5. **Бейджи**: `stitch-badge-primary` — фон `#deebff`, текст `#0747a6`,
   граница `#b3d4ff`, `text-transform: uppercase`, radius 4px.
6. **Поля форм**: `padding: 12px 14px`, `border: 2px solid #dfe1e6`,
   radius 4px, фон `#fafbfc`; focus → `border-color: #0052cc` +
   `box-shadow: 0 0 0 3px rgba(0,82,204,.1)`.
7. **Sticky nav**: фон с полупрозрачностью + blur, высота ~56px (в проекте 72px).
8. **Сетка**: 12 колонок, максимум 1280px, поля 24px, gap 24px.
9. **Фон страницы** `#f4f5f7`, секции-«поверхности» белые или `#ebecf0`.

## 4. Что НЕ менять

- Контент (`src/data/site.ts` — единый источник истины) и порядок секций:
  hero → направления → подход → этапы → как мы работаем → обсуждение → FAQ.
- Логику форм: `src/components/ContactSection.astro`, `src/lib/submit-lead.ts`.
- API-адреса (`API` в `src/data/site.ts`), Worker, DNS, NS, секреты, env.
- Логотип — текущая версия (`public/logo.svg`) принята, не переделывать.

## 5. Что было сделано в коммите `ad0e7f1` (и почему не подошло)

- Заменены токены палитры на «сапфировые» (#1e3a5f/#2d5a87) и добавлены
  собственные `--shadow-soft/card/elevated` с вертикальным смещением.
- Добавлены градиенты на hero, тени на карточки/кнопки/хедер, новый `public/logo.svg`.
- **Отклонение от референса:** акцент должен быть `#0052cc` (яркий синий), а не
  тёмно-сапфировый; тени — горизонтальные мягкие с синим подтоном, а не
  вертикальные «объёмные»; radius кнопок 4px, не 8px; заголовки секций с
  `border-bottom: 2px`; бейджи с цветной заливкой `#deebff`.
