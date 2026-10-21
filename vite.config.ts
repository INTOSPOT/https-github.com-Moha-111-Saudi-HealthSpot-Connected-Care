import { defineConfig } from 'vite';
export default defineConfig({ base: './', test: { include: ['tests/**/*.test.ts'] } } as any);
