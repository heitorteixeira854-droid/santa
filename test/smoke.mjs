import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createApp } from '../lib/core.mjs';
import { runReset } from '../lib/reset-worker.mjs';

// banco em memória que imita o Netlify Blobs
const mem = new Map();
const store = {
  async get(k) { return mem.has(k) ? JSON.parse(mem.get(k)) : null; },
  async set(k, v, o = {}) {
    if (o.onlyIfNew && mem.has(k)) return { modified: false };
    mem.set(k, v); return { modified: true };
  },
  async delete(k) { mem.delete(k); },
  async deleteAll() { mem.clear(); },
  list(o = {}) {
    const blobs = [...mem.keys()].filter((k) => k.startsWith(o.prefix || '')).map((key) => ({ key }));
    return o.paginate ? (async function* () { yield { blobs }; })() : Promise.resolve({ blobs });
  },
};

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pubHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
const env = { API_KEY: 'segredo', DISCORD_PUBLIC_KEY: pubHex, DISCORD_TOKEN: 't', LOG_CHANNEL_ID: '999', VERIFIED_ROLE_ID: '555', SET_NICKNAME: 'true' };
const calls = [];
const bodies = [];
const fetchImpl = async (url, o = {}) => {
  const key = `${o.method || 'GET'} ${url.replace('https://discord.com/api/v10', '')}`;
  calls.push(key); bodies.push({ key, body: o.body, headers: o.headers });
  return { ok: true, status: 200, json: async () => ({}) };
};
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
// 13. admin: /alterarid (banco + apelido)
const adm = { id: 'admin', permissions: '8', user: { id: 'admin' } };
const comum = { permissions: '0', user: { id: 'x' } };
const cmd = (name, options = [], m = adm) => discord({ type: 2, guild_id: 'G', member: m, application_id: 'APP', token: 'TOK', data: { name, options } });
const nickBody = (userId) => bodies.filter((b) => b.key === `PATCH /guilds/G/members/${userId}`).map((b) => JSON.parse(b.body).nick);
assert.match((await cmd('alterarid', [{ name: 'novo_id', value: 50 }, { name: 'usuario', value: 'D1' }], comum)).body.data.content, /administradores/);
const alt = await cmd('alterarid', [{ name: 'novo_id', value: 50 }, { name: 'usuario', value: 'D1' }]);
assert.match(alt.body.data.content, /\*\*1\*\* → \*\*50\*\*/); assert.match(alt.body.data.content, /Apelido atualizado/);
assert.equal(nickBody('D1').at(-1), '50 | João Silva');
assert.deepEqual((await roblox(1001)).body, { status: 'ok', id: 50 });          // Roblox já enxerga o ID novo
assert.equal(mem.has('id:1'), false);                                            // ID antigo liberado
assert.match((await cmd('alterarid', [{ name: 'novo_id', value: 2 }, { name: 'usuario', value: 'D1' }])).body.data.content, /já está em uso/);
assert.match((await cmd('alterarid', [{ name: 'novo_id', value: 50 }, { name: 'usuario', value: 'D1' }])).body.data.content, /já tem o ID/);
assert.match((await cmd('alterarid', [{ name: 'novo_id', value: 60 }, { name: 'id_atual', value: 2 }])).body.data.content, /Maria.*\*\*2\*\* → \*\*60\*\*/);
assert.match((await cmd('alterarid', [{ name: 'novo_id', value: 9 }])).body.data.content, /Informe/);
assert.match((await cmd('alterarid', [{ name: 'novo_id', value: 9 }, { name: 'usuario', value: 'naoexiste' }])).body.data.content, /Não encontrei/);
const n8 = await roblox(3001);                                                   // novos jogadores continuam a sequência (sem colidir)
assert.match((await form('D9', 'Novo8', '20', '20', n8.body.code)).body.data.content, /ID é \*\*8\*\*/);

// 14. admin: /removerallow por ID e por @usuario (tira o apelido)
assert.match((await cmd('removerallow', [{ name: 'id', value: 50 }], comum)).body.data.content, /administradores/);
const rem = await cmd('removerallow', [{ name: 'id', value: 50 }]);
assert.match(rem.body.data.content, /Removido: \*\*João Silva\*\* \(ID 50\)/); assert.match(rem.body.data.content, /Apelido removido/);
assert.equal(nickBody('D1').at(-1), null);
assert.ok(calls.includes('DELETE /guilds/G/members/D1/roles/555'));
assert.equal((await roblox(1001)).body.status, 'pending');
assert.match((await cmd('removerallow', [{ name: 'usuario', value: 'D2' }])).body.data.content, /Removido: \*\*Maria\*\*/);
assert.equal(nickBody('D2').at(-1), null);
assert.match((await cmd('removerallow', [{ name: 'usuario', value: 'D2' }])).body.data.content, /Não encontrei/);

// 15. admin: /resetarids (confirmação -> função em segundo plano -> apaga tudo + tira apelidos)
const ask = await cmd('resetarids'); assert.equal(ask.body.data.components[0].components[0].custom_id, 'reset_confirm');
assert.match(ask.body.data.content, /remove o apelido/);
assert.match((await discord({ type: 3, guild_id: 'G', member: comum, data: { custom_id: 'reset_confirm' } })).body.data.content, /administradores/);
const before = mem.size; assert.ok(before > 0);
const conf = await discord({ type: 3, guild_id: 'G', application_id: 'APP', token: 'TOK', member: adm, data: { custom_id: 'reset_confirm' } });
assert.equal(conf.body.type, 7); assert.match(conf.body.data.content, /Apagando tudo.*pessoa\(s\)/);
const trig = bodies.find((b) => b.key.endsWith('/.netlify/functions/reset-background'));
assert.ok(trig && trig.headers['x-api-key'] === 'segredo', 'função em segundo plano não foi acionada');
assert.equal(mem.size, before, 'o servidor principal não deve apagar (quem apaga é o background)');
const payload = JSON.parse(trig.body); assert.equal(payload.ids.length, 6);
const nBefore = bodies.length;
const res = await runReset({ store, payload, env, fetchImpl, sleep: async () => {} });
assert.equal(mem.size, 0); assert.equal(res.ok, payload.ids.length); assert.equal(res.fail, 0);
const sent = bodies.slice(nBefore);
assert.equal(sent.filter((b) => b.key.startsWith('PATCH /guilds/G/members/') && JSON.parse(b.body).nick === null).length, payload.ids.length);
const last = sent.at(-1); assert.equal(last.key, 'PATCH /webhooks/APP/TOK/messages/@original'); assert.match(JSON.parse(last.body).content, /Tudo apagado/);
const fresh = await roblox(7001);
assert.match((await form('N1', 'Novo', '20', '20', fresh.body.code)).body.data.content, /ID é \*\*1\*\*/);   // IDs recomeçam no 1
// 16. o worker lida com limite de requisições (429) e com falhas
let hits = 0;
const flaky = async (url, o = {}) => {
  if (o.method === 'PATCH' && url.includes('/members/')) { hits++; if (hits === 1) return { ok: false, status: 429, json: async () => ({ retry_after: 0.01 }) }; if (hits === 3) return { ok: false, status: 403 }; }
  return { ok: true, status: 200 };
};
const r2 = await runReset({ store, payload: { guildId: 'G', ids: ['a', 'b', 'c'], appId: 'APP', token: 'TOK' }, env, fetchImpl: flaky, sleep: async () => {} });
assert.deepEqual([r2.ok, r2.fail], [2, 1]);
// 17. sem SET_NICKNAME, nenhum apelido é mexido
const app2 = createApp({ store, env: { ...env, SET_NICKNAME: 'false' }, fetchImpl });
const mk = (payload) => { const raw = JSON.stringify(payload), ts = String(Date.now()); return new Request('https://x.netlify.app/discord', { method: 'POST', headers: { 'x-signature-ed25519': crypto.sign(null, Buffer.from(ts + raw), privateKey).toString('hex'), 'x-signature-timestamp': ts }, body: raw }); };
const p2 = await roblox(8001); await form('NN', 'SemNick', '20', '20', p2.body.code);
const c0 = calls.length;
await (await app2(mk({ type: 2, guild_id: 'G', member: adm, data: { name: 'removerallow', options: [{ name: 'usuario', value: 'NN' }] } }))).json();
assert.equal(calls.slice(c0).some((c) => c.startsWith('PATCH /guilds/G/members/NN') && !c.includes('/roles/')), false);
console.log('✅ todos os testes passaram. IDs simultâneos:', ids.sort((x, y) => x - y).join(','));

// 18. /allowlist: liga/desliga a exigência
assert.match((await cmd('allowlist', [{ name: 'estado', value: 'desligar' }], comum)).body.data.content, /administradores/);
assert.match((await cmd('allowlist', [{ name: 'estado', value: 'status' }])).body.data.content, /ATIVADA/);
assert.equal((await roblox(9001)).body.status, 'pending');                 // ligada: precisa de allowlist
const vip = await roblox(7101);
const vipId = Number((await form('V1', 'Vip', '20', '20', vip.body.code)).body.data.content.match(/ID é \*\*(\d+)\*\*/)[1]);
assert.match((await cmd('allowlist', [{ name: 'estado', value: 'desligar' }])).body.data.content, /desativada/);
assert.match((await cmd('allowlist', [{ name: 'estado', value: 'desligar' }])).body.data.content, /já está/);
assert.match((await cmd('allowlist', [{ name: 'estado', value: 'status' }])).body.data.content, /DESATIVADA/);
assert.deepEqual((await roblox(9002)).body, { status: 'open' });           // desligada: entra direto
assert.equal(mem.has('player:9002'), false);                               // e não gera código lixo
assert.deepEqual((await roblox(7101)).body, { status: 'ok', id: vipId });  // quem já tinha allowlist mantém o ID
assert.match((await discord({ type: 3, member: member('Z'), data: { custom_id: 'allowlist_abrir' } })).body.data.content, /desativada/);
await runReset({ store, payload: { guildId: 'G', ids: [], appId: 'APP', token: 'TOK' }, env, fetchImpl, sleep: async () => {} });
assert.deepEqual((await roblox(9003)).body, { status: 'open' });           // reset mantém o modo aberto
assert.match((await cmd('allowlist', [{ name: 'estado', value: 'ligar' }])).body.data.content, /ativada/);
assert.equal((await roblox(9004)).body.status, 'pending');                 // ligou de novo: volta a exigir
assert.ok(calls.some((c) => c === 'POST /channels/999/messages'));
console.log('✅ modo aberto/fechado ok');
