import * as assert from 'assert';
import { contextFlag, tempKubeconfigPath, isOrphanedTempFile } from '../../kubectlExec';

suite('kubectlExec', () => {
    test('contextFlag: kubectl uses --context, helm uses --kube-context', () => {
        assert.strictEqual(contextFlag('kubectl'), '--context');
        assert.strictEqual(contextFlag('helm'), '--kube-context');
        assert.strictEqual(contextFlag('/usr/local/bin/helm'), '--kube-context');
        assert.strictEqual(contextFlag('helm.exe'), '--kube-context');
    });
});

suite('kubectlExec temp files', () => {
    const HOUR = 60 * 60 * 1000;
    const other = process.pid + 1;

    test('names carry the owning PID', () => {
        const p = tempKubeconfigPath('term', 'abc');
        assert.ok(p.endsWith(`kubeconfig-term-p${process.pid}-abc.yaml`), p);
    });

    test('a live window\'s files are kept, a dead window\'s files are removed', () => {
        const name = `kubeconfig-term-p${other}-abc.yaml`;
        assert.strictEqual(isOrphanedTempFile(name, 10 * 24 * HOUR, () => true), false);
        assert.strictEqual(isOrphanedTempFile(name, 0, () => false), true);
    });

    test('own files are never orphans', () => {
        assert.strictEqual(isOrphanedTempFile(`kubeconfig-exec-p${process.pid}-x.yaml`, 99 * HOUR, () => false), false);
    });

    test('legacy names (no PID) only once older than a day; unrelated files never', () => {
        assert.strictEqual(isOrphanedTempFile('kubeconfig-1234.yaml', HOUR, () => false), false);
        assert.strictEqual(isOrphanedTempFile('kubeconfig-1234.yaml', 25 * HOUR, () => false), true);
        assert.strictEqual(isOrphanedTempFile('notes.txt', 99 * HOUR, () => false), false);
    });
});
