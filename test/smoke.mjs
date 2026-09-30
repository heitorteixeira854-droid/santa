import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createApp } from '../lib/core.mjs';

// banco em memória que imita o Netlify Blobs
const mem = new Map();
const store = {
  async get(k) { return mem.has(k) ? JSON.parse(mem.get(k)) : null; },
  async set(k, v, o = {}) {
    if (o.onlyIfNew && mem.has(k)) return { modified: false };
    mem.set(k, v); return { modified: true };
  },
  async delete(k) { mem.delete(k); },
};

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pubHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
const env = { API_KEY: 'segredo', DISCORD_PUBLIC_KEY: pubHex, DISCORD_TOKEN: 't', LOG_CHANNEL_ID: '999', VERIFIED_ROLE_ID: '555', SET_NICKNAME: 'true' };
const calls = [];
const fetchImpl = async (url, o) => { calls.push(`${o.method} ${url.replace('https://discord.com/api/v10', '')}`); return { ok: true }; };
const app = createApp({ store, env, fetchImpl });

const roblox = (robloxId, key = 'segredo') => app(new Request('https://x.netlify.app/join', {
  method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' },
  body: JSON.stringify({ robloxId, username: 'User' + robloxId }),
})).then(async (r) => ({ status: r.status, body: await r.json() }));

const discord = (payload, { sign = true } = {}) => {
  const raw = JSON.stringify(payload), ts = String(Date.now());
  const sig = sign ? crypto.sign(null, Buffer.from(ts + raw), privateKey).toString('hex') : 'aa'.repeat(64);
  return app(new Request('https://x.netlify.app/discord', {
    method: 'POST', headers: { 'x-signature-ed25519': sig, 'x-signature-timestamp': ts, 'content-type': 'application/json' }, body: raw,
  })).then(async (r) => ({ status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() }));
};
const member = (id) => ({ user: { id } });
const form = (did, nome, rp, real, codigo) => discord({
  type: 5, guild_id: 'G', member: member(did),
  data: { custom_id: 'allowlist_form', components: [
    { components: [{ custom_id: 'nome', value: nome }] }, { components: [{ custom_id: 'idade_rp', value: rp }] },
    { components: [{ custom_id: 'idade_real', value: real }] }, { components: [{ custom_id: 'codigo', value: codigo }] } ] },
});

// 1. chave errada é barrada
assert.equal((await roblox(1, 'errada')).status, 401);
// 2. primeira entrada gera código; segunda entrada devolve o MESMO código
const a = await roblox(1001); assert.equal(a.body.status, 'pending'); assert.match(a.body.code, /^[A-Z2-9]{6}$/);
assert.equal((await roblox(1001)).body.code, a.body.code);
// 3. assinatura inválida é barrada; PING funciona
assert.equal((await discord({ type: 1 }, { sign: false })).status, 401);
assert.deepEqual((await discord({ type: 1 })).body, { type: 1 });
// 4. painel
const panel = await discord({ type: 2, channel_id: 'C', data: { name: 'painelallowlist' }, member: member('admin') });
assert.match(panel.body.data.content, /Painel enviado/); assert.ok(calls.includes('POST /channels/C/messages'));
// 5. botão abre modal com 4 campos
const btn = await discord({ type: 3, member: member('D1'), data: { custom_id: 'allowlist_abrir' } });
assert.equal(btn.body.type, 9); assert.equal(btn.body.data.components.length, 4);
// 6. validações do formulário
assert.match((await form('D1', 'Joao', 'abc', '18', a.body.code)).body.data.content, /números/);
assert.match((await form('D1', 'Joao', '25', '18', 'ZZZZZZ')).body.data.content, /inválido/);
// 7. sucesso -> ID 1 (aceita código em minúsculas)
const ok = await form('D1', 'João Silva', '25', '18', a.body.code.toLowerCase());
assert.match(ok.body.data.content, /ID é \*\*1\*\*/);
assert.ok(calls.includes('PUT /guilds/G/members/D1/roles/555') && calls.includes('PATCH /guilds/G/members/D1') && calls.includes('POST /channels/999/messages'));
// 8. agora o Roblox libera com o ID
assert.deepEqual((await roblox(1001)).body, { status: 'ok', id: 1 });
// 9. código não pode ser reutilizado
assert.match((await form('D2', 'Outro', '30', '20', a.body.code)).body.data.content, /já foi utilizado/);
// 10. botão de quem já foi liberado mostra o ID
assert.match((await discord({ type: 3, member: member('D1'), data: { custom_id: 'allowlist_abrir' } })).body.data.content, /ID é \*\*1\*\*/);
// 11. segundo jogador -> ID 2; mesmo Discord não vincula 2 contas
const b = await roblox(1002), c = await roblox(1003);
assert.match((await form('D2', 'Maria', '22', '19', b.body.code)).body.data.content, /ID é \*\*2\*\*/);
assert.match((await form('D2', 'Maria2', '22', '19', c.body.code)).body.data.content, /já está vinculado/);
// 12. cliques simultâneos nunca repetem ID
const ps = await Promise.all([2001, 2002, 2003, 2004, 2005].map((n) => roblox(n)));
const rs = await Promise.all(ps.map((p, n) => form('DX' + n, 'P' + n, '20', '20', p.body.code)));
const ids = rs.map((r) => Number(r.body.data.content.match(/ID é \*\*(\d+)\*\*/)[1]));
assert.equal(new Set(ids).size, 5, 'IDs repetidos: ' + ids);
console.log('✅ todos os testes passaram. IDs simultâneos:', ids.sort((x, y) => x - y).join(','));
