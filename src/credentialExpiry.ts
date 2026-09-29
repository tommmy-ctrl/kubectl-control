/**
 * Expiry of the credentials a connection authenticates with, read from the
 * kubeconfig itself (no cluster access): the client certificate's `notAfter`
 * and, for JWT bearer tokens, the `exp` claim. Only the user of the context the
 * connection actually uses is inspected. No vscode dependency (unit-testable).
 */
import { X509Certificate, createHash } from 'node:crypto';
import * as jsYaml from 'js-yaml';

export interface CredentialExpiry {
    /** Earliest expiry among the user's credentials. */
    expiresAt: Date;
    kind: 'certificate' | 'token';
}

/** Warn this many days before a credential expires. */
export const EXPIRY_WARN_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

type Named<T> = { name?: unknown } & T;
interface KubeconfigDoc {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- kubeconfig key
    'current-context'?: unknown;
    contexts?: Named<{ context?: { user?: unknown } }>[];
    // eslint-disable-next-line @typescript-eslint/naming-convention -- kubeconfig key
    users?: Named<{ user?: { 'client-certificate-data'?: unknown; token?: unknown } }>[];
}

function certificateExpiry(base64Pem: string): Date | undefined {
    try {
        const cert = new X509Certificate(Buffer.from(base64Pem, 'base64'));
        const at = new Date(cert.validTo);
        return isNaN(at.getTime()) ? undefined : at;
    } catch {
        return undefined;
    }
}

function tokenExpiry(token: string): Date | undefined {
    const parts = token.split('.');
    if (parts.length !== 3) { return undefined; }   // not a JWT (e.g. a static token)
    try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as { exp?: unknown };
        return typeof payload.exp === 'number' && payload.exp > 0 ? new Date(payload.exp * 1000) : undefined;
    } catch {
        return undefined;
    }
}

function computeExpiry(kubeconfigData: string, context: string | undefined): CredentialExpiry | undefined {
    let doc: KubeconfigDoc;
    try {
        doc = jsYaml.load(kubeconfigData, { schema: jsYaml.JSON_SCHEMA }) as KubeconfigDoc;
    } catch {
        return undefined;
    }
    if (!doc || typeof doc !== 'object') { return undefined; }

    // Same exact-key lookup as kubectl (client-go reads kubeconfig keys case-sensitively).
    const contextName = context ?? doc['current-context'];
    const ctx = Array.isArray(doc.contexts) ? doc.contexts.find(c => c?.name === contextName) : undefined;
    const userName = ctx?.context?.user;
    const user = Array.isArray(doc.users) ? doc.users.find(u => u?.name === userName)?.user : undefined;
    if (!user || typeof user !== 'object') { return undefined; }

    const candidates: CredentialExpiry[] = [];
    const certData = user['client-certificate-data'];
    if (typeof certData === 'string') {
        const at = certificateExpiry(certData);
        if (at) { candidates.push({ expiresAt: at, kind: 'certificate' }); }
    }
    if (typeof user.token === 'string') {
        const at = tokenExpiry(user.token);
        if (at) { candidates.push({ expiresAt: at, kind: 'token' }); }
    }
    candidates.sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
    return candidates[0];
}

// The tree re-renders on every status update; parse each kubeconfig only once.
const cache = new Map<string, CredentialExpiry | null>();

export function getCredentialExpiry(kubeconfigData: string, context?: string): CredentialExpiry | undefined {
    const key = createHash('sha256').update(kubeconfigData).update('\0').update(context ?? '').digest('hex');
    if (!cache.has(key)) {
        if (cache.size > 500) { cache.clear(); }
        cache.set(key, computeExpiry(kubeconfigData, context) ?? null);
    }
    return cache.get(key) ?? undefined;
}

/** Whole days until `expiresAt` (negative once expired). */
export function daysUntil(expiresAt: Date, now = Date.now()): number {
    return Math.floor((expiresAt.getTime() - now) / DAY_MS);
}

export type ExpiryState = 'expired' | 'expiring' | 'ok';

export function expiryState(expiry: CredentialExpiry, now = Date.now()): ExpiryState {
    if (expiry.expiresAt.getTime() <= now) { return 'expired'; }
    return expiry.expiresAt.getTime() - now <= EXPIRY_WARN_DAYS * DAY_MS ? 'expiring' : 'ok';
}
