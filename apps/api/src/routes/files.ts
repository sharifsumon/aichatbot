import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyPluginAsync } from 'fastify';
import type { DiskStore } from '@agently/storage';

const IMAGE_TYPES: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/**
 * Product photos kept on the server's disk, at /files/<workspace>/images/<name>.
 * Only images are public: knowledge base files stay private to the worker.
 * Names are random and never reused, so browsers and Messenger may cache them for good.
 */
export const fileRoutes: FastifyPluginAsync<{ diskFiles: Pick<DiskStore, 'pathOf'> }> = async (app, { diskFiles }) => {
  app.get<{ Params: { workspaceId: string; name: string } }>('/files/:workspaceId/images/:name', async (req, reply) => {
    const { workspaceId, name } = req.params;
    const type = IMAGE_TYPES[name.split('.').pop()?.toLowerCase() ?? ''];
    const path = type ? diskFiles.pathOf(`${workspaceId}/images/${name}`) : undefined;
    const info = path ? await stat(path).catch(() => undefined) : undefined;
    if (!path || !info?.isFile()) return reply.code(404).send({ error: 'Not found' });
    return reply
      .header('content-type', type)
      .header('content-length', info.size)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .send(createReadStream(path));
  });
};
