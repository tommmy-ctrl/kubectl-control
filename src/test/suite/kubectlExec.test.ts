import * as assert from 'assert';
import { contextFlag } from '../../kubectlExec';

suite('kubectlExec', () => {
    test('contextFlag: kubectl uses --context, helm uses --kube-context', () => {
        assert.strictEqual(contextFlag('kubectl'), '--context');
        assert.strictEqual(contextFlag('helm'), '--kube-context');
        assert.strictEqual(contextFlag('/usr/local/bin/helm'), '--kube-context');
        assert.strictEqual(contextFlag('helm.exe'), '--kube-context');
    });
});
