/**
 * Список отраслевых посадочных.
 *
 * Порядок задаёт ссылки в футере и sitemap. Новая отрасль — новый файл
 * `src/data/industries/<slug>.ts`; страница собирается шаблоном
 * `src/pages/industries/[slug].astro`.
 */
import type { Industry } from '../types';

import { b2b } from './b2b.ts';
import { medicine } from './medicine.ts';
import { ecommerce } from './ecommerce.ts';

export const INDUSTRIES: Industry[] = [b2b, medicine, ecommerce];
