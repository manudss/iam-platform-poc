export default {
  'notify.send': (p, c) => ({ delivered: false, real: false, line: `${c.settings.prefix}: ${p.template} -> ${p.to}` }),
  // The log transport never really delivers: say so explicitly (P1-E: the OTP flow asks the slot before promising a real e-mail).
  'notify.capability': () => ({ real: false, note: 'log transport (simulated delivery)' }),
};
