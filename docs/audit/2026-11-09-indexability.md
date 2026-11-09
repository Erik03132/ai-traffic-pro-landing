# Аудит индексируемости — 2026-11-09

Задача **1.9**. Метод: прямые HTTP-запросы (Python `urllib`, без рендеринга браузером).
Сайт статический (Astro), JS на разметку не влияет, поэтому curl-проверки достаточно.
Источник списка URL — `https://ai-traffic-pro.ru/sitemap.xml` (20 адресов на 09.11.2026).

## Итог

| Проверка | Результат |
| --- | --- |
| Все URL из sitemap отдают 200 | ✅ 20 из 20 |
| `canonical` совпадает с адресом страницы | ✅ 20 из 20 |
| `noindex` на индексируемых страницах | ✅ нет ни одного |
| `X-Robots-Tag` в заголовках | ✅ отсутствует |
| Ровно один `H1` | ✅ 20 из 20 |
| Дубли `www` / `http` / без слэша | ✅ все 301 в один хоп |
| `lastmod` — реальная дата, не дата сборки | ⚠️ да, но у одной статьи дата в будущем |
| `title` ≤ 60 символов | ⚠️ 1 страница длиннее |
| `description` 140–160 символов | ⚠️ 6 страниц длиннее |

## Все 20 URL

| URL | Код | `canonical` | `title` | `description` |
| --- | --- | --- | --- | --- |
| `/` | 200 | self | 47 | 142 |
| `/blog/` | 200 | self | 50 | 150 |
| `/requisites/` | 200 | self | 37 | 151 |
| `/privacy/` | 200 | self | 44 | 114 ⚠️ |
| `/services/leadgen/` | 200 | self | 60 | 170 ⚠️ |
| `/services/seo/` | 200 | self | 61 ⚠️ | 178 ⚠️ |
| `/services/smm/` | 200 | self | 51 | 170 ⚠️ |
| `/services/advertising/` | 200 | self | 59 | 168 ⚠️ |
| `/services/landing/` | 200 | self | 53 | 157 |
| `/services/crm/` | 200 | self | 60 | 158 |
| `/services/ecommerce/` | 200 | self | 57 | 169 ⚠️ |
| `/blog/kak-vybrat-kanal-prodvizheniya/` | 200 | self | 58 | 142 |
| `/blog/kak-sostavit-brif-na-prodvizhenie/` | 200 | self | 53 | 146 |
| `/blog/kak-schitat-okupaemost-reklamy/` | 200 | self | 49 | 149 |
| `/blog/geo-prodvizhenie-checklist/` | 200 | self | 58 | 141 |
| `/blog/kontent-plan-dlya-sotssetey/` | 200 | self | 51 | 150 |
| `/blog/lending-ili-sayt/` | 200 | self | 46 | 146 |
| `/blog/kak-nachat-prodavat-na-marketpleysah/` | 200 | self | 54 | 153 |
| `/blog/zayavki-teryayutsya/` | 200 | self | 53 | 151 |
| `/blog/crm-i-erp-raznica/` | 200 | self | 55 | 171 ⚠️ |

## Дубли и редиректы

| Запрос | Ответ |
| --- | --- |
| `https://www.ai-traffic-pro.ru/` | `301` → `https://ai-traffic-pro.ru/` |
| `http://ai-traffic-pro.ru/` | `301` → `https://ai-traffic-pro.ru/` |
| `/services/seo` (без слэша) | `301` → `/services/seo/` |
| `/blog` (без слэша) | `301` → `/blog/` |
| `/blog/geo-prodvizhenie-checklist` | `301` → `/blog/geo-prodvizhenie-checklist/` |
| `/INDEX.html` | `404` (мусорный URL, не мягкая ошибка) |
| `/services/seo/?utm_source=test` | `200`, `canonical` чистый — дубля нет |

## Найденные дефекты

### 1. `lastmod` на 30 минут в будущем (мелочь)
`/blog/crm-i-erp-raznica/` — `lastmod` = `2026-11-10`, проверка 09.11 в 23:28 MSK.
Дата стоит в `src/data/blog/crm-i-erp-raznica.ts` (`date: '2026-11-10'`) и совпадает с
записью в `ACTIVE_TASKS` «опубликована 10.11.2026»: статья выложена вечером 9-го,
дата проставлена на следующий день. Не ошибка сборки, часовой пояс тоже ни при чём
(машина в MSK). Влияние минимальное — Google может проигнорировать будущий `lastmod`.
Править не срочно: либо оставить как дату публикации, либо ставить фактическую дату выкладки.

### 2. Search Console знает 18 URL, в sitemap 20
В GSC `Last read` = 02.11, а блог-кластер (10 статей + `/blog/`) появился позже.
Переотправить sitemap и проверить, что `Discovered pages` = 20.

### 3. Мета длиннее лимитов (снижает CTR в выдаче)
| URL | `title` | `description` |
| --- | --- | --- |
| `/services/seo/` | **61** (лимит 60) | **178** (лимит 160) |
| `/services/leadgen/` | 60 | **170** |
| `/services/smm/` | 51 | **170** |
| `/services/advertising/` | 59 | **168** |
| `/services/ecommerce/` | 57 | **169** |
| `/blog/crm-i-erp-raznica/` | 55 | **171** |
| `/privacy/` | 44 | **114** (короче 140) |

### 4. Устаревший комментарий в `robots.txt`
Там написано, что `/privacy/` и `/consent/` отдают `noindex`. По факту у `/privacy/`
`noindex` снят коммитом `27a524d` и она добавлена в sitemap — это осознанное решение
(политика в индексе как сигнал доверия). У `/consent/` `noindex` на месте, в sitemap её нет — верно.
Комментарий вводит в заблуждение при следующей правке — переписать.

## Что закрыто этой проверкой

- **1.9** — аудит индексируемости 18 (фактически 20) URL.
- **1.4** — `lastmod` больше не одна дата на весь сайт: 28.10 / 04.11 / 09.11 по разделам,
  берётся из `date` статей и `lastmod` услуг, а не из времени сборки.
- **1.5** — `www` → apex 301 в один хоп (подтверждено повторно).

---

## Исправлено в тот же день (09.11.2026, вечер)

| Пункт | Что сделано | Проверка |
| --- | --- | --- |
| 1.9c | `description` сокращены/расширены до 140–160 у 7 страниц; `title` `/services/seo/` 61 → 59 | сборка: 21/21 страница в лимитах, замечаний 0 |
| 1.9г | комментарий в `robots.txt` переписан: правило «только `noindex`, не `Disallow`», статус `/privacy/` и `/consent/` описан по факту | `dist/robots.txt` |
| 1.9а | `date` статьи `crm-i-erp-raznica` 2026-11-10 → 2026-11-09 | sitemap: 21 URL, даты 28.10 / 04.11 / 09.11 |
| 1.9b | sitemap отправлен вручную полным путём (действие владельца в GSC) | отчёт GSC: `Last read` обновится в течение суток |

Изменение `description` — это правка содержания, поэтому `lastmod` затронутых
страниц услуг сдвинут на 09.11 (в `SERVICE_LASTMOD`), а не оставлен 04.11.
