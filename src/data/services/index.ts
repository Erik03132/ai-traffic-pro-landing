/**
 * Сборка списка услуг из отдельных файлов.
 *
 * Каждая услуга лежит в своём файле `src/data/services/<slug>.ts` — так тексты
 * не раздувают общий модуль и правка одной услуги не трогает остальные.
 * Порядок здесь канонический: он задаёт номера «01»…«06» на главной, в футере
 * и в sitemap.
 */
import type { Service } from '../types';

import { leadgen } from './leadgen';
import { seo } from './seo';
import { smm } from './smm';
import { advertising } from './advertising';
import { landing } from './landing';
import { ecommerce } from './ecommerce';
import { crm } from './crm';

/** 6 направлений — канон из дизайна Stitch. Входят в карточки главной и футера. */
export const SERVICES: Service[] = [leadgen, seo, smm, advertising, landing, ecommerce];

/** Все страницы услуг: 6 основных + CRM как дополнительное направление. */
export const ALL_SERVICES: Service[] = [...SERVICES, crm];

export type { Service };
