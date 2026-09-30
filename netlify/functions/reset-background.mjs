// Função em segundo plano (o nome termina em "-background": a Netlify responde 202
// na hora e deixa rodar por até 15 min). Só aceita chamadas com a API_KEY.
import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { runReset } from '../../lib/reset-worker.mjs';

export default async (req) => {
  const sent = Buffer.from(req.headers.get('x-api-key') || '');
  const want = Buffer.from(process.env.API_KEY || '');
  if (!want.length || sent.length !== want.length || !crypto.timingSafeEqual(sent, want)) {
    return new Response('unauthorized', { status: 401 });
  }
  const payload = await req.json();
  const store = getStore({ name: 'allowlist', consistency: 'strong' });
  await runReset({ store, payload, env: process.env });
  return new Response('ok');
};
