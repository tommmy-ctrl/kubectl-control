import * as vscode from 'vscode';
import * as nodeCrypto from 'node:crypto';
import * as jsYaml from 'js-yaml';
import type { ClusterProfile, ClusterStore } from './store';
import { log } from './logger';
import { t } from './i18n';

/*
 * SECURITY: kubeconfig credential plugins.
 *
 * A kubeconfig can declare `users[].user.exec` (client-go credential plugin) or a
 * legacy `auth-provider` (e.g. gcp with `cmd-path`). kubectl runs those programs
 * on this machine every time it talks to the cluster. An imported or synced
 * kubeconfig must therefore never reach kubectl until the user has seen and
 * approved the exact command. Approval is stored per cluster as a fingerprint of
 * the plugin sections (`ClusterProfile.execTrust`), so any later change to the
 * command (edit, re-import, Gist pull) requires a new approval.
 */

const MAX_SUMMARY_LEN = 1000;

export interface ExecEntry {
    kind: 'exec' | 'auth-provider' | 'unparseable';
    /** Human-readable command line (or provider name) shown in the approval dialog. */
    summary: string;
}

export interface ExecAnalysis {
    entries: ExecEntry[];
    /** Undefined when the kubeconfig contains no credential plugin at all. */
    fingerprint?: string;
    /**
     * True if some mapping has keys that differ only in case (e.g. `Command` and
     * `command`). Legitimate kubeconfigs never do this; it can only serve to make
     * the approval dialog show something other than what kubectl runs.
     */
    ambiguous?: boolean;
}

// DETECTION is deliberately broader than kubectl: `exec`/`auth-provider` keys are
// matched case-insensitively anywhere in the document, so no casing or nesting
// trick hides a plugin (a false positive only costs one confirmation).
function keyIs(key: string, wanted: string): boolean {
    return key.toLowerCase() === wanted;
}

// DISPLAY and FINGERPRINT identity must match exactly what kubectl executes.
// client-go ≥ 1.23 decodes kubeconfigs case-sensitively, so read exact keys only.
function exact(obj: Record<string, unknown>, key: string): unknown {
    return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** JSON serialization with sorted keys, so equal content always hashes equally. */
function stableStringify(v: unknown): string {
    if (Array.isArray(v)) { return `[${v.map(stableStringify).join(',')}]`; }
    if (isObject(v)) {
        return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
    }
    return JSON.stringify(v) ?? 'null';
}

function hasCaseVariantKeys(node: unknown, depth = 0): boolean {
    if (depth > 64) { return false; }
    if (Array.isArray(node)) { return node.some(n => hasCaseVariantKeys(n, depth + 1)); }
    if (!isObject(node)) { return false; }
    const keys = Object.keys(node);
    if (new Set(keys.map(k => k.toLowerCase())).size !== keys.length) { return true; }
    return keys.some(k => hasCaseVariantKeys(node[k], depth + 1));
}

/** Makes control/bidi characters visible so they cannot fake extra lines in the dialog. */
function visible(s: string): string {
    return s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
        c => `\\u{${c.codePointAt(0)!.toString(16)}}`);
}

function truncate(s: string): string {
    return s.length > MAX_SUMMARY_LEN
        ? `${s.slice(0, MAX_SUMMARY_LEN)}… ${t('(+{0} more characters)', s.length - MAX_SUMMARY_LEN)}`
        : s;
}

function str(v: unknown): string {
    return typeof v === 'string' ? v : stableStringify(v);
}

function summarizeExec(v: unknown): string {
    if (!isObject(v)) { return truncate(visible(stableStringify(v))); }
    const parts: string[] = [];
    const env = exact(v, 'env');
    if (Array.isArray(env)) {
        for (const e of env) {
            parts.push(isObject(e) ? `${str(exact(e, 'name'))}=${str(exact(e, 'value'))}` : str(e));
        }
    }
    parts.push(str(exact(v, 'command')));
    const args = exact(v, 'args');
    if (Array.isArray(args)) { parts.push(...args.map(str)); }
    return truncate(visible(parts.join(' ')));
}

function summarizeAuthProvider(v: unknown): string {
    if (!isObject(v)) { return truncate(visible(stableStringify(v))); }
    const config = exact(v, 'config');
    const cmdPath = isObject(config) ? exact(config, 'cmd-path') : undefined;
    const cmdArgs = isObject(config) ? exact(config, 'cmd-args') : undefined;
    let s = `auth-provider: ${str(exact(v, 'name'))}`;
    if (cmdPath !== undefined) {
        s += ` → ${str(cmdPath)}${cmdArgs !== undefined ? ` ${str(cmdArgs)}` : ''}`;
    }
    return truncate(visible(s));
}

/**
 * Only the parts of an auth-provider that decide *what runs* go into the
 * fingerprint — its config also caches access tokens/expiry, which change on
 * refresh and must not invalidate an approval. Exact keys, as client-go reads them.
 */
function authProviderIdentity(v: unknown): unknown {
    if (!isObject(v)) { return v; }
    const config = exact(v, 'config');
    return {
        name: exact(v, 'name') ?? null,
        cmdPath: isObject(config) ? exact(config, 'cmd-path') ?? null : null,
        cmdArgs: isObject(config) ? exact(config, 'cmd-args') ?? null : null,
    };
}

/**
 * Walks the whole document (not just `users[].user`) so that unusual nesting or
 * key casing cannot hide a plugin from the check — false positives only cost an
 * extra confirmation, false negatives would cost code execution.
 */
function collect(node: unknown, found: { kind: 'exec' | 'auth-provider'; value: unknown }[], depth = 0): void {
    if (depth > 64) { return; }
    if (Array.isArray(node)) {
        for (const item of node) { collect(item, found, depth + 1); }
        return;
    }
    if (!isObject(node)) { return; }
    for (const [k, v] of Object.entries(node)) {
        if (keyIs(k, 'exec') && v !== null && v !== undefined) {
            found.push({ kind: 'exec', value: v });
        } else if (keyIs(k, 'auth-provider') && v !== null && v !== undefined) {
            found.push({ kind: 'auth-provider', value: v });
        } else {
            collect(v, found, depth + 1);
        }
    }
}

function sha256(s: string): string {
    return nodeCrypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Detects credential plugins in a kubeconfig and fingerprints them. */
export function analyzeKubeconfig(kubeconfigData: string): ExecAnalysis {
    let doc: unknown;
    try {
        doc = jsYaml.load(kubeconfigData);
    } catch {
        // Cannot prove it is plugin-free, and kubectl's parser may still accept it.
        return {
            entries: [{ kind: 'unparseable', summary: t('(kubeconfig could not be analyzed)') }],
            fingerprint: `raw:${sha256(kubeconfigData)}`,
        };
    }

    const found: { kind: 'exec' | 'auth-provider'; value: unknown }[] = [];
    collect(doc, found);
    if (found.length === 0) { return { entries: [] }; }

    const entries: ExecEntry[] = found.map(f => ({
        kind: f.kind,
        summary: f.kind === 'exec' ? summarizeExec(f.value) : summarizeAuthProvider(f.value),
    }));
    const identity = found.map(f => ({
        kind: f.kind,
        value: f.kind === 'exec' ? f.value : authProviderIdentity(f.value),
    }));
    return { entries, fingerprint: `v1:${sha256(stableStringify(identity))}`, ambiguous: hasCaseVariantKeys(doc) };
}

// ── Trust registry ────────────────────────────────────────────────────────────

/** Fingerprints approved on stored clusters (rebuilt by the store on every load/save). */
let persistedApprovals = new Set<string>();
/** Fingerprints approved in this session for kubeconfigs not stored yet (add/edit form). */
const sessionApprovals = new Set<string>();

export function syncApprovedFingerprints(clusters: readonly ClusterProfile[]): void {
    persistedApprovals = new Set(clusters.map(c => c.execTrust).filter((f): f is string => !!f));
}

function isApproved(fingerprint: string): boolean {
    return persistedApprovals.has(fingerprint) || sessionApprovals.has(fingerprint);
}

/** Non-interactive check: true if the kubeconfig has no plugin or its plugin is approved. */
export function isKubeconfigAllowed(kubeconfigData: string): boolean {
    const { fingerprint } = analyzeKubeconfig(kubeconfigData);
    return fingerprint === undefined || isApproved(fingerprint);
}

export class ExecNotApprovedError extends Error {
    constructor() {
        super(t('This kubeconfig uses a credential plugin (exec/auth-provider) that has not been approved yet. Open a terminal for this connection to review and approve it.'));
        this.name = 'ExecNotApprovedError';
    }
}

/** Last line of defence in front of every kubectl/helm invocation. */
export function assertKubeconfigAllowed(kubeconfigData: string): void {
    if (!isKubeconfigAllowed(kubeconfigData)) {
        throw new ExecNotApprovedError();
    }
}

/**
 * Shows the approval dialog for a kubeconfig that is not stored yet (or whose
 * plugin changed). On approval the fingerprint is allowed for this session;
 * the caller persists it on the cluster profile.
 *
 * @returns `ok: false` if the user declined; `fingerprint` is the value to store.
 */
export async function confirmKubeconfigExec(
    name: string,
    kubeconfigData: string,
): Promise<{ ok: boolean; fingerprint?: string }> {
    const analysis = analyzeKubeconfig(kubeconfigData);
    if (analysis.fingerprint === undefined) { return { ok: true }; }
    if (isApproved(analysis.fingerprint)) { return { ok: true, fingerprint: analysis.fingerprint }; }
    if (analysis.ambiguous) {
        // Cannot show reliably what would run — refuse instead of asking.
        log.warn(`execTrust: refused ambiguous credential plugin for "${name}"`);
        void vscode.window.showErrorMessage(
            t('Connection "{0}" was blocked: its kubeconfig contains keys that differ only in upper/lower case (e.g. "Command" and "command"). Such a file can disguise which program kubectl would run. Please fix the kubeconfig.', name),
            { modal: true },
        );
        return { ok: false };
    }

    const list = analysis.entries.map(e => `• ${e.summary}`).join('\n');
    const btnAllow = t('Allow and continue');
    const choice = await vscode.window.showWarningMessage(
        t('Connection "{0}" runs a program on this computer', name),
        {
            modal: true,
            detail: t('This kubeconfig contains a credential plugin. kubectl will execute the following on your machine every time it connects:\n\n{0}\n\nOnly allow this if you trust where this kubeconfig came from.', list),
        },
        btnAllow,
    );
    if (choice !== btnAllow) {
        log.warn(`execTrust: user declined credential plugin for "${name}"`);
        return { ok: false };
    }
    sessionApprovals.add(analysis.fingerprint);
    log.info(`execTrust: credential plugin approved for "${name}"`);
    return { ok: true, fingerprint: analysis.fingerprint };
}

/**
 * Interactive gate for a stored cluster: asks for approval if its plugin is not
 * approved yet and persists the approval. Returns false if the user declined.
 */
export async function ensureClusterExecTrusted(store: ClusterStore, profile: ClusterProfile): Promise<boolean> {
    const { fingerprint } = analyzeKubeconfig(profile.kubeconfigData);
    if (fingerprint === undefined) { return true; }
    if (profile.execTrust === fingerprint) { return true; }
    const result = await confirmKubeconfigExec(profile.name, profile.kubeconfigData);
    if (!result.ok) { return false; }
    await store.updateCluster(profile.id, { execTrust: result.fingerprint });
    return true;
}
