import { getStore } from '@netlify/blobs';
import { createApp } from '../../lib/core.mjs';

export default async (req) => {
  const store = getStore({ name: 'allowlist', consistency: 'strong' });
  const app = createApp({ store, env: process.env });
  return app(req);
};

// /join  -> chamado pelo Roblox
// /discord -> "Interactions Endpoint URL" do Discord
export const config = { path: ['/join', '/discord'] };
