// Data only, generated from the server (AuthnService.reachable on SEED_CONFIG variants). apps/api/src/authn/reachable-contract.spec.ts asserts the same tables on the server side: the two rules cannot drift apart unnoticed.
export const REACHABLE_FIXTURE = {
 "seed": {
  "cfg": {
   "methods": [
    {
     "id": "password",
     "name": "Password",
     "enabled": true
    },
    {
     "id": "authenticator-app",
     "name": "Authenticator app",
     "enabled": true
    },
    {
     "id": "e-mail-code",
     "name": "E-mail code",
     "enabled": true
    },
    {
     "id": "pin-keypad",
     "name": "PIN keypad",
     "enabled": true
    },
    {
     "id": "pin-keypad-8",
     "name": "PIN keypad (8 digits)",
     "enabled": true
    },
    {
     "id": "passkey",
     "name": "Passkey",
     "enabled": true
    }
   ],
   "chains": [
    {
     "id": "password-only",
     "name": "Password only",
     "enabled": true,
     "steps": [
      "password"
     ],
     "level": 3
    },
    {
     "id": "passkey-only",
     "name": "Passkey only",
     "enabled": true,
     "steps": [
      "passkey"
     ],
     "level": 9
    },
    {
     "id": "password-then-passkey",
     "name": "Password then passkey",
     "enabled": true,
     "steps": [
      "password",
      "passkey"
     ],
     "level": 9
    },
    {
     "id": "password-then-authenticator",
     "name": "Password then authenticator",
     "enabled": true,
     "steps": [
      "password",
      "authenticator-app"
     ],
     "level": 8
    },
    {
     "id": "password-then-e-mail-code",
     "name": "Password then e-mail code",
     "enabled": true,
     "steps": [
      "password",
      "e-mail-code"
     ],
     "level": 5
    },
    {
     "id": "e-mail-then-pin-keypad",
     "name": "E-mail then PIN keypad",
     "enabled": true,
     "steps": [
      "e-mail-code",
      "pin-keypad"
     ],
     "level": 7
    },
    {
     "id": "password-e-mail-pin",
     "name": "Password, e-mail code, PIN",
     "enabled": true,
     "steps": [
      "password",
      "e-mail-code",
      "pin-keypad-8"
     ],
     "level": 8
    }
   ]
  },
  "analyses": [
   {
    "id": "password-only",
    "effectiveLevel": 3,
    "simulatedSteps": []
   },
   {
    "id": "passkey-only",
    "effectiveLevel": 9,
    "simulatedSteps": []
   },
   {
    "id": "password-then-passkey",
    "effectiveLevel": 9,
    "simulatedSteps": []
   },
   {
    "id": "password-then-authenticator",
    "effectiveLevel": 8,
    "simulatedSteps": []
   },
   {
    "id": "password-then-e-mail-code",
    "effectiveLevel": 5,
    "simulatedSteps": []
   },
   {
    "id": "e-mail-then-pin-keypad",
    "effectiveLevel": 7,
    "simulatedSteps": []
   },
   {
    "id": "password-e-mail-pin",
    "effectiveLevel": 8,
    "simulatedSteps": []
   }
  ],
  "reachable": {
   "1": true,
   "2": true,
   "3": true,
   "4": true,
   "5": true,
   "6": true,
   "7": true,
   "8": true,
   "9": true,
   "10": false
  }
 },
 "highChainsDisabled": {
  "cfg": {
   "methods": [
    {
     "id": "password",
     "name": "Password",
     "enabled": true
    },
    {
     "id": "authenticator-app",
     "name": "Authenticator app",
     "enabled": true
    },
    {
     "id": "e-mail-code",
     "name": "E-mail code",
     "enabled": true
    },
    {
     "id": "pin-keypad",
     "name": "PIN keypad",
     "enabled": true
    },
    {
     "id": "pin-keypad-8",
     "name": "PIN keypad (8 digits)",
     "enabled": true
    },
    {
     "id": "passkey",
     "name": "Passkey",
     "enabled": true
    }
   ],
   "chains": [
    {
     "id": "password-only",
     "name": "Password only",
     "enabled": true,
     "steps": [
      "password"
     ],
     "level": 3
    },
    {
     "id": "passkey-only",
     "name": "Passkey only",
     "enabled": false,
     "steps": [
      "passkey"
     ],
     "level": 9
    },
    {
     "id": "password-then-passkey",
     "name": "Password then passkey",
     "enabled": false,
     "steps": [
      "password",
      "passkey"
     ],
     "level": 9
    },
    {
     "id": "password-then-authenticator",
     "name": "Password then authenticator",
     "enabled": false,
     "steps": [
      "password",
      "authenticator-app"
     ],
     "level": 8
    },
    {
     "id": "password-then-e-mail-code",
     "name": "Password then e-mail code",
     "enabled": true,
     "steps": [
      "password",
      "e-mail-code"
     ],
     "level": 5
    },
    {
     "id": "e-mail-then-pin-keypad",
     "name": "E-mail then PIN keypad",
     "enabled": true,
     "steps": [
      "e-mail-code",
      "pin-keypad"
     ],
     "level": 7
    },
    {
     "id": "password-e-mail-pin",
     "name": "Password, e-mail code, PIN",
     "enabled": false,
     "steps": [
      "password",
      "e-mail-code",
      "pin-keypad-8"
     ],
     "level": 8
    }
   ]
  },
  "analyses": [
   {
    "id": "password-only",
    "effectiveLevel": 3,
    "simulatedSteps": []
   },
   {
    "id": "passkey-only",
    "effectiveLevel": 9,
    "simulatedSteps": []
   },
   {
    "id": "password-then-passkey",
    "effectiveLevel": 9,
    "simulatedSteps": []
   },
   {
    "id": "password-then-authenticator",
    "effectiveLevel": 8,
    "simulatedSteps": []
   },
   {
    "id": "password-then-e-mail-code",
    "effectiveLevel": 5,
    "simulatedSteps": []
   },
   {
    "id": "e-mail-then-pin-keypad",
    "effectiveLevel": 7,
    "simulatedSteps": []
   },
   {
    "id": "password-e-mail-pin",
    "effectiveLevel": 8,
    "simulatedSteps": []
   }
  ],
  "reachable": {
   "1": true,
   "2": true,
   "3": true,
   "4": true,
   "5": true,
   "6": true,
   "7": true,
   "8": false,
   "9": false,
   "10": false
  }
 },
 "allChainsDisabled": {
  "cfg": {
   "methods": [
    {
     "id": "password",
     "name": "Password",
     "enabled": true
    },
    {
     "id": "authenticator-app",
     "name": "Authenticator app",
     "enabled": true
    },
    {
     "id": "e-mail-code",
     "name": "E-mail code",
     "enabled": true
    },
    {
     "id": "pin-keypad",
     "name": "PIN keypad",
     "enabled": true
    },
    {
     "id": "pin-keypad-8",
     "name": "PIN keypad (8 digits)",
     "enabled": true
    },
    {
     "id": "passkey",
     "name": "Passkey",
     "enabled": true
    }
   ],
   "chains": [
    {
     "id": "password-only",
     "name": "Password only",
     "enabled": false,
     "steps": [
      "password"
     ],
     "level": 3
    },
    {
     "id": "passkey-only",
     "name": "Passkey only",
     "enabled": false,
     "steps": [
      "passkey"
     ],
     "level": 9
    },
    {
     "id": "password-then-passkey",
     "name": "Password then passkey",
     "enabled": false,
     "steps": [
      "password",
      "passkey"
     ],
     "level": 9
    },
    {
     "id": "password-then-authenticator",
     "name": "Password then authenticator",
     "enabled": false,
     "steps": [
      "password",
      "authenticator-app"
     ],
     "level": 8
    },
    {
     "id": "password-then-e-mail-code",
     "name": "Password then e-mail code",
     "enabled": false,
     "steps": [
      "password",
      "e-mail-code"
     ],
     "level": 5
    },
    {
     "id": "e-mail-then-pin-keypad",
     "name": "E-mail then PIN keypad",
     "enabled": false,
     "steps": [
      "e-mail-code",
      "pin-keypad"
     ],
     "level": 7
    },
    {
     "id": "password-e-mail-pin",
     "name": "Password, e-mail code, PIN",
     "enabled": false,
     "steps": [
      "password",
      "e-mail-code",
      "pin-keypad-8"
     ],
     "level": 8
    }
   ]
  },
  "analyses": [
   {
    "id": "password-only",
    "effectiveLevel": 3,
    "simulatedSteps": []
   },
   {
    "id": "passkey-only",
    "effectiveLevel": 9,
    "simulatedSteps": []
   },
   {
    "id": "password-then-passkey",
    "effectiveLevel": 9,
    "simulatedSteps": []
   },
   {
    "id": "password-then-authenticator",
    "effectiveLevel": 8,
    "simulatedSteps": []
   },
   {
    "id": "password-then-e-mail-code",
    "effectiveLevel": 5,
    "simulatedSteps": []
   },
   {
    "id": "e-mail-then-pin-keypad",
    "effectiveLevel": 7,
    "simulatedSteps": []
   },
   {
    "id": "password-e-mail-pin",
    "effectiveLevel": 8,
    "simulatedSteps": []
   }
  ],
  "reachable": {
   "1": false,
   "2": false,
   "3": false,
   "4": false,
   "5": false,
   "6": false,
   "7": false,
   "8": false,
   "9": false,
   "10": false
  }
 }
} as const;
