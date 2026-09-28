import { t } from './i18n';

/**
 * SECURITY: minimum length for every password the user chooses (lock, export
 * file, GitHub Sync). Offline brute force against an export file or the stored
 * PBKDF2 hash is only bounded by the password itself; 12 characters keeps that
 * out of reach. Existing shorter passwords keep working — this applies only
 * when a new password is set.
 */
export const MIN_PASSWORD_LENGTH = 12;

/** `validateInput` for InputBoxes that set a new password. */
export function validateNewPassword(value: string | undefined): string | undefined {
    return (!value || value.length < MIN_PASSWORD_LENGTH)
        ? t('At least {0} characters required', MIN_PASSWORD_LENGTH)
        : undefined;
}

export function isBelowMinimum(password: string): boolean {
    return password.length < MIN_PASSWORD_LENGTH;
}
