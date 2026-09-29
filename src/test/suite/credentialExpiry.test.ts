import * as assert from 'assert';
import { getCredentialExpiry, expiryState, daysUntil } from '../../credentialExpiry';

// Self-signed test certificate (CN=test-user, no private key needed), notAfter 2026-10-29T12:11:43Z.
const CERT_B64 = 'LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSUJmVENDQVNPZ0F3SUJBZ0lVSmVja1UrMVZRMzJ4bE5tZkx2K21SVEMyamp3d0NnWUlLb1pJemowRUF3SXcKRkRFU01CQUdBMVVFQXd3SmRHVnpkQzExYzJWeU1CNFhEVEkyTURreU9URXlNVEUwTTFvWERUSTJNVEF5T1RFeQpNVEUwTTFvd0ZERVNNQkFHQTFVRUF3d0pkR1Z6ZEMxMWMyVnlNRmt3RXdZSEtvWkl6ajBDQVFZSUtvWkl6ajBECkFRY0RRZ0FFalJkUTVublZKeDc2SVRTbGdFdmFmQ2x5ZHVnT2tIc1BZQzczLzlDV3ZGVHp0OVJYUDlFbjRISCsKTHdobVV0Q0ZyVDVLeXpnU1phQ2l0VHJLbzc0RlZxTlRNRkV3SFFZRFZSME9CQllFRk4zZzBXd0NjeU1wRWZ3Sgp3bzI4UXNXQzVKYkZNQjhHQTFVZEl3UVlNQmFBRk4zZzBXd0NjeU1wRWZ3SndvMjhRc1dDNUpiRk1BOEdBMVVkCkV3RUIvd1FGTUFNQkFmOHdDZ1lJS29aSXpqMEVBd0lEU0FBd1JRSWdRNG14bWh4THNqZThYN3lwRmorMVhwUnEKQjNXYU9TOXRHeFJ0cTkrS0V2b0NJUURKLzBtbjNha3VQUXFrNkYrSUZvMHNBRmhOdDZXc2p4WWNCTGxUM3piVAp0QT09Ci0tLS0tRU5EIENFUlRJRklDQVRFLS0tLS0K';
const CERT_NOT_AFTER = Date.parse('2026-10-29T12:11:43Z');

function jwt(exp: number): string {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${enc({ alg: 'none' })}.${enc({ exp })}.sig`;
}

function kubeconfig(users: string, current = 'ctx-a'): string {
    return [
        'apiVersion: v1', 'kind: Config', `current-context: ${current}`,
        'contexts:',
        '- name: ctx-a', '  context: {cluster: c, user: cert-user}',
        '- name: ctx-b', '  context: {cluster: c, user: token-user}',
        'users:', users, '',
    ].join('\n');
}

const USERS = [
    '- name: cert-user', '  user:', `    client-certificate-data: ${CERT_B64}`,
    '- name: token-user', '  user:', `    token: ${jwt(Date.parse('2026-10-05T00:00:00Z') / 1000)}`,
].join('\n');

suite('credentialExpiry', () => {

    test('reads the client certificate notAfter of the current context\'s user', () => {
        const e = getCredentialExpiry(kubeconfig(USERS));
        assert.ok(e);
        assert.strictEqual(e.kind, 'certificate');
        assert.strictEqual(e.expiresAt.getTime(), CERT_NOT_AFTER);
    });

    test('uses the connection\'s active context, not current-context', () => {
        const e = getCredentialExpiry(kubeconfig(USERS), 'ctx-b');
        assert.ok(e);
        assert.strictEqual(e.kind, 'token');
        assert.strictEqual(e.expiresAt.toISOString(), '2026-10-05T00:00:00.000Z');
    });

    test('static tokens, missing users and invalid data give no expiry', () => {
        const plain = '- name: cert-user\n  user:\n    token: abcdef0123456789';
        assert.strictEqual(getCredentialExpiry(kubeconfig(plain)), undefined);
        assert.strictEqual(getCredentialExpiry(kubeconfig(USERS), 'no-such-context'), undefined);
        const broken = '- name: cert-user\n  user:\n    client-certificate-data: bm90IGEgY2VydA==';
        assert.strictEqual(getCredentialExpiry(kubeconfig(broken)), undefined);
        assert.strictEqual(getCredentialExpiry('a: [unclosed'), undefined);
    });

    test('state: ok, expiring within 14 days, expired', () => {
        const e = { expiresAt: new Date(CERT_NOT_AFTER), kind: 'certificate' as const };
        const day = 24 * 60 * 60 * 1000;
        assert.strictEqual(expiryState(e, CERT_NOT_AFTER - 30 * day), 'ok');
        assert.strictEqual(expiryState(e, CERT_NOT_AFTER - 14 * day), 'expiring');
        assert.strictEqual(expiryState(e, CERT_NOT_AFTER - 1), 'expiring');
        assert.strictEqual(expiryState(e, CERT_NOT_AFTER), 'expired');
        assert.strictEqual(daysUntil(e.expiresAt, CERT_NOT_AFTER - 5.5 * day), 5);
    });
});
