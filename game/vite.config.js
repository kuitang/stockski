import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)), // root = game/ regardless of invocation cwd
  base: './', // relative asset URLs so the built bundle serves from any subpath (CONTRACTS §6: static publish on 8090)
  server: { port: 5173, host: true },
});
