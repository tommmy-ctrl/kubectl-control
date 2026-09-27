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

const MAX_SUMMARY_LEN = 300;

export interface ExecEntry {
    kind: 'exec' | 'auth-provider' | 'unparseable';
    /** Human-readable command line (or provider name) shown in the approval dialog. */
    summary: string;
}

export interface ExecAnalysis {
    entries: ExecEntry[];
    /** Undefined when the kubeconfig contains no credential plugin at all. */
    fingerprint?: string;
}

// kubectl decodes kubeconfigs via YAML → JSON → encoding/json, which matches field
// names case-insensitively ("Exec", "EXEC" are honoured). Match keys the same way.
function keyIs(key: string, wanted: string): boolean {
    return key.toLowerCase() === wanted;
}

function getKey(obj: Record<string, unknown>, wanted: string): unknown {
    for (const [k, v] of Object.entries(obj)) {
        if (keyIs(k, wanted)) { return v; }
    }
    return undefined;
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

function truncate(s: string): string {
    return s.length > MAX_SUMMARY_LEN ? `${s.slice(0, MAX_SUMMARY_LEN)}…` : s;
}

function summarizeExec(v: unknown): string {
    if (!isObject(v)) { return truncate(stableStringify(v)); }
    const command = getKey(v, 'command');
    const args = getKey(v, 'args');
    const parts = [typeof command === 'string' ? command : stableStringify(command)];
    if (Array.isArray(args)) { parts.push(...args.map(a => (typeof a === 'string' ? a : stableStringify(a)))); }
    return truncate(parts.join(' '));
}

function summarizeAuthProvider(v: unknown): string {
    if (!isObject(v)) { return truncate(stableStringify(v)); }
    const name = getKey(v, 'name');
    const config = getKey(v, 'config');
    const cmdPath = isObject(config) ? getKey(config, 'cmd-path') : undefined;
    const cmdArgs = isObject(config) ? getKey(config, 'cmd-args') : undefined;
    let s = `auth-provider: ${typeof name === 'string' ? name : stableStringify(name)}`;
    if (typeof cmdPath === 'string') {
        s += ` → ${cmdPath}${typeof cmdArgs === 'string' ? ` ${cmdArgs}` : ''}`;
    }
    return truncate(s);
}

/**
 * Only the parts of an auth-provider that decide *what runs* go into the
 * fingerprint — its config also caches access tokens/expiry, which change on
 * refresh and must not invalidate an approval.
 */
function authProviderIdentity(v: unknown): unknown {
    if (!isObject(v)) { return v; }
    const config = getKey(v, 'config');
    return {
        name: getKey(v, 'name') ?? null,
        cmdPath: isObject(config) ? getKey(config, 'cmd-path') ?? null : null,
        cmdArgs: isObject(config) ? getKey(config, 'cmd-args') ?? null : null,
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
    return { entries, fingerprint: `v1:${sha256(stableStringify(identity))}` };
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
