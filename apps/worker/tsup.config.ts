import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  // Workspace packages ship TypeScript source, so bundle them in. Their
  // heavier libraries (PDF, spreadsheet, S3) are dependencies of this app
  // instead, so they stay external and are installed as published.
  noExternal: [/^@agently\//],
  clean: true,
});
