import * as assert from 'assert';
import { parseKubectlTable, podStatusClass } from '../../features/kubeTable';

suite('kubeTable', () => {

    test('parses pods in one namespace', () => {
        const out = [
            'NAME                     READY   STATUS             RESTARTS      AGE',
            'web-7d9c6b5f4-abcde      1/1     Running            0             3d',
            'worker-5c8d7f9b6-xyz12   0/1     CrashLoopBackOff   7 (2m ago)    1h',
            '',
        ].join('\n');
        const rows = parseKubectlTable(out);
        assert.strictEqual(rows.length, 2);
        assert.deepStrictEqual(
            ['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE'].map(k => rows[0][k]),
            ['web-7d9c6b5f4-abcde', '1/1', 'Running', '0', '3d'],
        );
        assert.strictEqual(rows[1].RESTARTS, '7 (2m ago)', 'values with spaces stay intact');
        assert.strictEqual(rows[1].STATUS, 'CrashLoopBackOff');
    });

    test('parses --all-namespaces deployments incl. hyphenated headers', () => {
        const out = [
            'NAMESPACE     NAME      READY   UP-TO-DATE   AVAILABLE   AGE',
            'kube-system   coredns   2/2     2            2           40d',
        ].join('\n');
        const [row] = parseKubectlTable(out);
        assert.strictEqual(row.NAMESPACE, 'kube-system');
        assert.strictEqual(row['UP-TO-DATE'], '2');
        assert.strictEqual(row.AGE, '40d');
    });

    test('multi-word headers are one column', () => {
        const out = [
            'NAME   READY   NOMINATED NODE   READINESS GATES',
            'a      1/1     <none>           <none>',
        ].join('\n');
        const [row] = parseKubectlTable(out);
        assert.strictEqual(row['NOMINATED NODE'], '<none>');
        assert.strictEqual(row['READINESS GATES'], '<none>');
    });

    test('empty output gives no rows; CRLF is handled', () => {
        assert.deepStrictEqual(parseKubectlTable(''), []);
        assert.strictEqual(parseKubectlTable('NAME   AGE\r\na      1d\r\n')[0].AGE, '1d');
    });

    test('status classes', () => {
        assert.strictEqual(podStatusClass('Running'), 'running');
        assert.strictEqual(podStatusClass('Completed'), 'succeeded');
        assert.strictEqual(podStatusClass('Init:0/1'), 'pending');
        assert.strictEqual(podStatusClass('ContainerCreating'), 'pending');
        assert.strictEqual(podStatusClass('CrashLoopBackOff'), 'failed');
        assert.strictEqual(podStatusClass('ImagePullBackOff'), 'failed');
        assert.strictEqual(podStatusClass('OOMKilled'), 'failed');
        assert.strictEqual(podStatusClass('Terminating'), 'other');
    });
});
