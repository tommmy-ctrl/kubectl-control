import * as vscode from 'vscode';
import { de } from './i18n/translations.de';

export type Lang = 'en' | 'de';

const SUPPORTED: Lang[] = ['en', 'de'];

let cachedLang: Lang | undefined;

function detectLang(): Lang {
    const setting = vscode.workspace.getConfiguration('kubectl-control').get<string>('language', 'auto');
    if (setting === 'en' || setting === 'de') {
        return setting;
    }
    const vsLang = vscode.env.language.toLowerCase();
    const base = vsLang.split('-')[0];
    return (SUPPORTED as string[]).includes(base) ? (base as Lang) : 'en';
}

/** Current effective UI language, honoring the kubectl-control.language override. */
export function getLanguage(): Lang {
    if (!cachedLang) {
        cachedLang = detectLang();
    }
    return cachedLang;
}

/** Re-reads the language setting / VS Code display language. Call after a config change. */
export function refreshLanguage(): Lang {
    cachedLang = detectLang();
    return cachedLang;
}

function format(template: string, args: unknown[]): string {
    if (args.length === 0) {
        return template;
    }
    return template.replace(/\{(\d+)\}/g, (match, idx: string) => {
        const i = Number(idx);
        return i < args.length ? String(args[i]) : match;
    });
}

/**
 * Translates a source string (English) into the current UI language and
 * substitutes {0}, {1}, ... placeholders with the given arguments.
 * Source strings double as dictionary keys, mirroring vscode.l10n.t().
 */
export function t(key: string, ...args: unknown[]): string {
    const lang = getLanguage();
    const template = lang === 'de' ? (de[key] ?? key) : key;
    return format(template, args);
}
