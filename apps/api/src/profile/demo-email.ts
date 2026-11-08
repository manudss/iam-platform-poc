/** The demo sign-in account's real e-mail address comes from the server environment (IAM_DEMO_PROFILE_EMAIL),
 * never from this repo. Same shape rule as UsersService.validate: a present value must look like an e-mail
 * address, otherwise it is ignored and the seed keeps the fictional example.invalid address. */
export const demoProfileEmail = (v: string | undefined): string | undefined => {
  if (typeof v !== 'string' || v.length > 254) return undefined;
  return /^[^\s@<>",;]{1,64}@[^\s@<>",;]{1,190}$/.test(v) ? v : undefined;
};
