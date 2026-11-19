import type { AuthnConfig } from '../../authn/config.js';
export const SEED_CONFIG: AuthnConfig = {
  methods: [
    { id: 'password', type: 'password', name: 'Password', enabled: true, level: 3, config: {} },
    { id: 'authenticator-app', type: 'totp', name: 'Authenticator app', enabled: true, level: 7, config: {} },
    { id: 'e-mail-code', type: 'email-otp', name: 'E-mail code', enabled: true, level: 4, config: { delivery: 'smtp' } },
    { id: 'pin-keypad', type: 'digit-code', name: 'PIN keypad', enabled: true, level: 3, config: { length: 6 } },
    { id: 'pin-keypad-8', type: 'digit-code', name: 'PIN keypad (8 digits)', enabled: true, level: 4, config: { length: 8 } },
    { id: 'passkey', type: 'webauthn', name: 'Passkey', enabled: true, level: 9, config: {} },
  ],
  chains: [
    { id: 'password-only', name: 'Password only', enabled: true, steps: ['password'], level: 3 },
    { id: 'passkey-only', name: 'Passkey only', enabled: true, steps: ['passkey'], level: 9, note: 'Enroll a passkey from your profile first (signed in, then Security > Passkeys).' },
    { id: 'password-then-passkey', name: 'Password then passkey', enabled: true, steps: ['password', 'passkey'], level: 9 },
    { id: 'password-then-authenticator', name: 'Password then authenticator', enabled: true, steps: ['password', 'authenticator-app'], level: 8 },
    { id: 'password-then-e-mail-code', name: 'Password then e-mail code', enabled: true, steps: ['password', 'e-mail-code'], level: 5, note: 'The e-mail step is simulated unless SMTP is configured.' },
    { id: 'e-mail-then-pin-keypad', name: 'E-mail then PIN keypad', enabled: true, steps: ['e-mail-code', 'pin-keypad'], level: 7, note: 'The e-mail step is simulated unless SMTP is configured.' },
    { id: 'password-e-mail-pin', name: 'Password, e-mail code, PIN', enabled: true, steps: ['password', 'e-mail-code', 'pin-keypad-8'], level: 8, note: 'Three steps, two factor categories at most.' },
  ],
  defaultChain: null,
};
