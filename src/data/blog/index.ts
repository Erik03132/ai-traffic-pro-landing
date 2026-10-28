/**
 * Сборка блога: одна статья — один файл `src/data/blog/<slug>.ts`.
 *
 * Порядок в массиве не важен: список статей сортируется по дате на странице
 * `/blog/`, а соседние материалы для блока «Читать дальше» подбираются
 * по `service` (перелинковка «статья → её услуга», задача 2.7 ROADMAP).
 */
import type { Article } from '../types';

import { kakVybratKanal } from './kak-vybrat-kanal-prodvizheniya';
import { kakSostavitBrif } from './kak-sostavit-brif-na-prodvizhenie';
import { kakSchitatOkupaemost } from './kak-schitat-okupaemost-reklamy';
import { geoProvizhenieChecklist } from './geo-prodvizhenie-checklist';
import { kontentPlanDlyaSotssetey } from './kontent-plan-dlya-sotssetey';
import { lendingIliSayt } from './lending-ili-sayt';
import { kakNachatProdavatNaMarketpleysah } from './kak-nachat-prodavat-na-marketpleysah';
import { zayavkiTeryayutsya } from './zayavki-teryayutsya';

export const ARTICLES: Article[] = [
  kakVybratKanal,
  kakSostavitBrif,
  kakSchitatOkupaemost,
  geoProvizhenieChecklist,
  kontentPlanDlyaSotssetey,
  lendingIliSayt,
  kakNachatProdavatNaMarketpleysah,
  zayavkiTeryayutsya,
];

export type { Article };
