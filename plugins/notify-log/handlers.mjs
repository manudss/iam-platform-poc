export default {
  'notify.send': (p, c) => ({ delivered: false, line: `${c.settings.prefix}: ${p.template} -> ${p.to}` }),
};
