import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Avoid a hard dependency on @types/node just for this one read.
declare const process: { env: Record<string, string | undefined> };

// Path-based hosting on elnuevos.es: the prefix is baked in at build time, so
// the bundle can't collide with the sibling apps. Local dev stays at '/'.
const raw = process.env.BASE_PATH?.replace(/^\/+|\/+$/g, '');
const base = raw ? `/${raw}/` : '/';

// 5173/5174 are taken by the siblings; 5175 keeps `npm run dev` predictable.
const port = process.env.PORT ? Number(process.env.PORT) : 5175;

export default defineConfig({
  base,
  plugins: [react()],
  server: { port },
});
