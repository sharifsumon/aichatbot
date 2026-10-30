import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';

const config: NextConfig = {
  output: 'standalone',
  // Trace from the monorepo root so the standalone build works inside pnpm workspaces.
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
};

export default config;
