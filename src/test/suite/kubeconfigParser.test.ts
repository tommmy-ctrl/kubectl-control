import * as assert from 'assert';
import { parseKubeconfig, getActiveNamespace } from '../../kubeconfigParser';

const VALID_SINGLE = `
apiVersion: v1
kind: Config
current-context: dev-cluster
contexts:
- name: dev-cluster
  context:
    cluster: dev
    namespace: development
`;

const VALID_MULTI = `
apiVersion: v1
kind: Config
current-context: prod-cluster
contexts:
- name: dev-cluster
  context:
    cluster: dev
    namespace: development
- name: prod-cluster
  context:
    cluster: prod
    namespace: production
`;

const MISSING_NAMESPACE = `
apiVersion: v1
kind: Config
current-context: my-ctx
contexts:
- name: my-ctx
  context:
    cluster: my-cluster
`;

// Flow-style YAML: the old line-by-line state machine would fail on this;
// js-yaml handles it correctly.
const FLOW_STYLE = `
apiVersion: v1
kind: Config
current-context: flow-ctx
contexts:
- {name: flow-ctx, context: {cluster: flow-cluster, namespace: flow-ns}}
`;

suite('kubeconfigParser', () => {
    test('empty input returns valid:false with German error', () => {
        const r = parseKubeconfig('   ');
        assert.strictEqual(r.valid, false);
        assert.strictEqual(r.error, 'Leerer Inhalt');
        assert.deepStrictEqual(r.contexts, []);
        assert.strictEqual(r.currentContext, '');
    });

    test('missing apiVersion returns valid:false', () => {
        const r = parseKubeconfig('kind: Config\ncurrent-context: x\n');
        assert.strictEqual(r.valid, false);
        assert.ok(r.error?.includes('apiVersion'));
    });

    test('missing kind Config returns valid:false', () => {
        const r = parseKubeconfig('apiVersion: v1\nkind: List\n');
        assert.strictEqual(r.valid, false);
        assert.ok(r.error?.includes('kind'));
    });

    test('valid single-context kubeconfig', () => {
        const r = parseKubeconfig(VALID_SINGLE);
        assert.strictEqual(r.valid, true);
        assert.strictEqual(r.contexts.length, 1);
        assert.strictEqual(r.contexts[0].name, 'dev-cluster');
        assert.strictEqual(r.contexts[0].cluster, 'dev');
        assert.strictEqual(r.contexts[0].namespace, 'development');
        assert.strictEqual(r.currentContext, 'dev-cluster');
    });

    test('valid multi-context kubeconfig selects current-context', () => {
        const r = parseKubeconfig(VALID_MULTI);
        assert.strictEqual(r.valid, true);
        assert.strictEqual(r.contexts.length, 2);
        assert.strictEqual(r.currentContext, 'prod-cluster');
        const ns = getActiveNamespace(r);
        assert.strictEqual(ns, 'production');
    });

    test('missing namespace defaults to "default"', () => {
        const r = parseKubeconfig(MISSING_NAMESPACE);
        assert.strictEqual(r.valid, true);
        assert.strictEqual(r.contexts[0].namespace, 'default');
    });

    test('getActiveNamespace falls back to first context when current-context not found', () => {
        const r = parseKubeconfig(VALID_MULTI);
        // Override currentContext to something nonexistent
        const patched = { ...r, currentContext: 'nonexistent' };
        const ns = getActiveNamespace(patched);
        assert.strictEqual(ns, 'development'); // first context
    });

    test('getActiveNamespace returns "default" for invalid parse result', () => {
        const r = parseKubeconfig('');
        assert.strictEqual(getActiveNamespace(r), 'default');
    });

    test('malformed YAML returns valid:false with Ungültiges YAML error', () => {
        const r = parseKubeconfig('key: [unclosed bracket\nanother: value\n');
        assert.strictEqual(r.valid, false);
        assert.ok(r.error?.startsWith('Ungültiges YAML'));
    });

    test('flow-style YAML (proves js-yaml upgrade over old parser)', () => {
        const r = parseKubeconfig(FLOW_STYLE);
        assert.strictEqual(r.valid, true);
        assert.strictEqual(r.contexts.length, 1);
        assert.strictEqual(r.contexts[0].name, 'flow-ctx');
        assert.strictEqual(r.contexts[0].cluster, 'flow-cluster');
        assert.strictEqual(r.contexts[0].namespace, 'flow-ns');
        assert.strictEqual(getActiveNamespace(r), 'flow-ns');
    });
});
