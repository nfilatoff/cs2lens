// Interface language: English by default; Russian or Spanish when the browser or the
// operating system (reported by the local backend) uses one of them. A choice made in the
// app is remembered in this browser. Non-React code (canvas captions, clip descriptions)
// reads the current language through `t` too, so the app remounts its pages on a change.
import { useSyncExternalStore } from "react";
import { en, type Entry, type Key } from "./locales/en";
import { ru } from "./locales/ru";
import { es } from "./locales/es";

export type Lang = "en" | "ru" | "es";
export type { Key };
export const LANGS: [Lang, string][] = [["en", "English"], ["ru", "Русский"], ["es", "Español"]];

const DICTS: Record<Lang, Record<Key, Entry>> = { en, ru, es };
const STORAGE = "cs2lens.lang";

/** "ru-RU", "es_419", "Spanish_Spain"... -> a supported non-default language, or null. */
export function langOf(tag: string | null | undefined): Lang | null {
  const t = (tag ?? "").toLowerCase();
  if (/^ru([-_.]|$)|^russian/.test(t)) return "ru";
  if (/^es([-_.]|$)|^spanish/.test(t)) return "es";
  return null;
}

function saved(): Lang | null {
  try {
    const v = localStorage.getItem(STORAGE);
    return v === "en" || v === "ru" || v === "es" ? v : null;
  } catch {
    return null;
  }
}

let current: Lang = saved() ?? langOf(navigator.language) ?? "en";
const listeners = new Set<() => void>();

function apply(lang: Lang) {
  current = lang;
  document.documentElement.lang = lang;
  listeners.forEach((l) => l());
}
apply(current);

/** The user's choice from the switcher; remembered in this browser. */
export function setLang(lang: Lang) {
  try {
    localStorage.setItem(STORAGE, lang);
  } catch {
    /* storage blocked: the choice lasts until the page is reloaded */
  }
  apply(lang);
}

/** Without a saved choice and with a browser in a language we don't have, follow the OS language. */
export function detectSystemLang(fetchLocale: () => Promise<string | null>) {
  if (saved() || langOf(navigator.language)) return;
  fetchLocale().then((loc) => {
    const lang = langOf(loc);
    if (lang && !saved()) apply(lang);
  }).catch(() => {});
}

export const getLang = () => current;
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const useLang = () => useSyncExternalStore(subscribe, getLang);

type Params = Record<string, string | number | null | undefined>;
const plurals = new Map<Lang, Intl.PluralRules>();

function format(entry: Entry, params?: Params): string {
  let s: string;
  if (typeof entry === "string") s = entry;
  else {
    const n = Number(params?.n ?? 0);
    let rules = plurals.get(current);
    if (!rules) plurals.set(current, (rules = new Intl.PluralRules(current)));
    const form = rules.select(n) as keyof typeof entry;
    s = entry[form] ?? entry.other;
  }
  return params ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k] ?? "") : m)) : s;
}

/** A string of the current language; `{name}` placeholders are filled from `params`, plurals use `params.n`. */
export function t(key: Key, params?: Params): string {
  return format(DICTS[current][key] ?? en[key], params);
}

/** A key built at run time (column names, reasons from the data); `fallback` when there is no such key. */
export function td(key: string, fallback: string, params?: Params): string {
  const e = (DICTS[current] as Record<string, Entry>)[key] ?? (en as Record<string, Entry>)[key];
  return e === undefined ? fallback : format(e, params);
}
