import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The component specs import the packaged plugin screens (plugins/<id>/screens/*.mjs) straight from the
// repository as 'poc-plugins/<id>/...'; the alias resolves that prefix outside the app source root.
export default defineConfig({
  resolve: { alias: { 'poc-plugins': fileURLToPath(new URL('../../plugins', import.meta.url)) } },
  server: { fs: { allow: ['../..'] } },
});
