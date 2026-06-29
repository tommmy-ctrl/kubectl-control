import * as assert from 'assert';
import { ClusterStore, ClusterProfile, AddClusterOptions } from '../../store';
import type * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Fake SecretStorage backed by a plain Map so tests run without VS Code host.
// ---------------------------------------------------------------------------
class FakeSecretStorage implements vscode.SecretStorage {
    private readonly _map = new Map<string, string>();

    // The onDidChange event is required by the interface but not exercised here.
    readonly onDidChange: vscode.Event<vscode.SecretStorageChangeEvent> = (_listener: any) => ({
        dispose: () => { /* noop */ },
    }) as vscode.Disposable;

    async get(key: string): Promise<string | undefined> {
        return this._map.get(key);
    }

    async store(key: string, value: string): Promise<void> {
        this._map.set(key, value);
    }

    async delete(key: string): Promise<void> {
        this._map.delete(key);
    }

    async keys(): Promise<string[]> {
        return [...this._map.keys()];
    }
}

/** Build a minimal fake ExtensionContext whose `.secrets` is the given store. */
function makeContext(secrets: vscode.SecretStorage): vscode.ExtensionContext {
    return { secrets } as unknown as vscode.ExtensionContext;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const KUBECONFIG = 'apiVersion: v1\nkind: Config\nclusters: []\ncontexts: []\nusers: []\ncurrent-context: ""\n';

function makeOpts(overrides: Partial<AddClusterOptions> = {}): AddClusterOptions {
    return {
        name: 'test-cluster',
        kubeconfigData: KUBECONFIG,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
suite('ClusterStore', () => {

    test('addCluster: getClusters returns the added cluster', async () => {
        const store = new ClusterStore(makeContext(new FakeSecretStorage()));
        const profile = await store.addCluster(makeOpts({ name: 'my-cluster' }));
        const clusters = await store.getClusters();
        assert.strictEqual(clusters.length, 1);
        assert.strictEqual(clusters[0].name, 'my-cluster');
        assert.strictEqual(clusters[0].id, profile.id);
    });

    test('addCluster: assigned id is a UUID v4 string', async () => {
        const store = new ClusterStore(makeContext(new FakeSecretStorage()));
        const profile = await store.addCluster(makeOpts());
        // UUID v4 pattern: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
        assert.match(profile.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    test('addCluster: cache returns same data on repeated reads (no extra storage calls)', async () => {
        const storage = new FakeSecretStorage();
        const store = new ClusterStore(makeContext(storage));
        await store.addCluster(makeOpts({ name: 'cached' }));
        const first = await store.getClusters();
        const second = await store.getClusters();
        // Strict reference equality proves the cache is being served.
        assert.strictEqual(first, second);
    });

    test('updateCluster: mutates only the targeted fields', async () => {
        const store = new ClusterStore(makeContext(new FakeSecretStorage()));
        const profile = await store.addCluster(makeOpts({ name: 'original', namespace: 'ns1' }));
        await store.updateCluster(profile.id, { name: 'updated' });
        const clusters = await store.getClusters();
        assert.strictEqual(clusters[0].name, 'updated');
        assert.strictEqual(clusters[0].namespace, 'ns1');   // untouched
        assert.strictEqual(clusters[0].kubeconfigData, KUBECONFIG); // untouched
    });

    test('deleteCluster: removes the cluster', async () => {
        const store = new ClusterStore(makeContext(new FakeSecretStorage()));
        const a = await store.addCluster(makeOpts({ name: 'a' }));
        await store.addCluster(makeOpts({ name: 'b' }));
        await store.deleteCluster(a.id);
        const clusters = await store.getClusters();
        assert.strictEqual(clusters.length, 1);
        assert.strictEqual(clusters[0].name, 'b');
    });

    test('importClusters: valid clusters are merged', async () => {
        const store = new ClusterStore(makeContext(new FakeSecretStorage()));
        const incoming: ClusterProfile[] = [
            { id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'imported', kubeconfigData: KUBECONFIG },
        ];
        const added = await store.importClusters(JSON.stringify(incoming));
        assert.strictEqual(added, 1);
        const clusters = await store.getClusters();
        assert.ok(clusters.some(c => c.name === 'imported'));
    });

    test('importClusters: cluster with unsafe activeContext has activeContext dropped', async () => {
        const store = new ClusterStore(makeContext(new FakeSecretStorage()));
        const incoming: ClusterProfile[] = [
            {
                id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
                name: 'unsafe',
                kubeconfigData: KUBECONFIG,
                activeContext: 'foo; rm -rf /',   // fails CONTEXT_REGEX
            },
        ];
        await store.importClusters(JSON.stringify(incoming));
        const clusters = await store.getClusters();
        const cluster = clusters.find(c => c.name === 'unsafe');
        assert.ok(cluster, 'cluster should be imported despite bad activeContext');
        assert.strictEqual(cluster!.activeContext, undefined);
    });

    test('importClusters: cluster missing kubeconfigData is skipped', async () => {
        const store = new ClusterStore(makeContext(new FakeSecretStorage()));
        const incoming = [
            { id: 'cccccccc-cccc-4ccc-cccc-cccccccccccc', name: 'no-kubeconfig' },
            // No kubeconfigData field.
        ];
        const added = await store.importClusters(JSON.stringify(incoming));
        assert.strictEqual(added, 0);
        const clusters = await store.getClusters();
        assert.strictEqual(clusters.length, 0);
    });

    test('schema migration: legacy bare-array JSON is read correctly', async () => {
        // Pre-seed the storage with the legacy format (no envelope wrapper).
        const storage = new FakeSecretStorage();
        const legacyClusters: ClusterProfile[] = [
            { id: 'dddddddd-dddd-4ddd-dddd-dddddddddddd', name: 'legacy', kubeconfigData: KUBECONFIG },
        ];
        await storage.store('kubectl-control.clusters', JSON.stringify(legacyClusters));

        const store = new ClusterStore(makeContext(storage));
        const clusters = await store.getClusters();
        assert.strictEqual(clusters.length, 1);
        assert.strictEqual(clusters[0].name, 'legacy');
        assert.strictEqual(clusters[0].id, 'dddddddd-dddd-4ddd-dddd-dddddddddddd');
    });

    test('concurrency: parallel addCluster calls do not lose entries (write mutex)', async () => {
        const store = new ClusterStore(makeContext(new FakeSecretStorage()));
        const names = ['c1', 'c2', 'c3', 'c4', 'c5'];
        // Fire all without awaiting between them — relies on the write-queue mutex.
        await Promise.all(names.map(name => store.addCluster(makeOpts({ name }))));
        const clusters = await store.getClusters();
        assert.strictEqual(clusters.length, names.length, `Expected ${names.length} clusters, got ${clusters.length}`);
        for (const name of names) {
            assert.ok(clusters.some(c => c.name === name), `Missing cluster "${name}"`);
        }
    });
});
