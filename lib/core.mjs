import crypto from 'node:crypto';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

const EPHEMERAL = 64;
const reply = (content) => json({ type: 4, data: { content, flags: EPHEMERAL } });
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);

export function createApp({ store, env, fetchImpl = fetch }) {
  // ---------- helpers de banco (Netlify Blobs) ----------
  const get = (k) => store.get(k, { type: 'json' });
  const put = (k, v) => store.set(k, JSON.stringify(v));
  // cria só se não existir; retorna true se conseguiu
  const create = async (k, v) => (await store.set(k, JSON.stringify(v), { onlyIfNew: true })).modified;

  const genCode = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O/1/I
    let c = '';
    for (let i = 0; i < 6; i++) c += chars[crypto.randomInt(chars.length)];
    return c;
  };

  // ---------- lógica: Roblox ----------
  async function join({ robloxId, username }) {
    let p = await get(`player:${robloxId}`);
    if (!p) {
      let code = null;
      for (let n = 0; n < 20 && !code; n++) {
        const c = genCode();
        if (await create(`code:${c}`, robloxId)) code = c;
      }
      if (!code) throw new Error('não consegui gerar código');
      const novo = { robloxId, username: String(username || ''), code, verified: false, createdAt: new Date().toISOString() };
      p = (await create(`player:${robloxId}`, novo)) ? novo : await get(`player:${robloxId}`);
    }
    return p.verified ? { status: 'ok', id: p.allowId } : { status: 'pending', code: p.code };
  }

  // ---------- lógica: verificação do formulário ----------
  async function verify({ code, nome, idadeRp, idadeReal }, discordId) {
    const robloxId = await get(`code:${code}`);
    if (robloxId == null) return { err: 'Código inválido. Confira o código que apareceu ao tentar entrar no jogo.' };
    const p = await get(`player:${robloxId}`);
    if (!p) return { err: 'Código inválido.' };
    if (p.verified) return { err: 'Esse código já foi utilizado.' };

    // reserva o código para este Discord (evita dois usarem ao mesmo tempo)
    if (!(await create(`claim:${robloxId}`, discordId))) {
      if ((await get(`claim:${robloxId}`)) !== discordId) return { err: 'Esse código já foi utilizado.' };
    }
    // um Discord só pode ter uma conta Roblox
    if (!(await create(`discord:${discordId}`, robloxId))) {
      if ((await get(`discord:${discordId}`)) !== robloxId) {
        await store.delete(`claim:${robloxId}`);
        return { err: 'Seu Discord já está vinculado a outra conta do Roblox.' };
      }
    }
    // próximo ID livre (nunca repete, mesmo com cliques simultâneos)
    let id = ((await get('meta:lastId')) || 0) + 1;
    while (!(await create(`id:${id}`, robloxId))) {
      if ((await get(`id:${id}`)) === robloxId) break;
      id++;
    }
    await put('meta:lastId', id);

    await put(`player:${robloxId}`, {
      ...p, verified: true, allowId: id, discordId, nome, idadeRp, idadeReal, verifiedAt: new Date().toISOString(),
    });
    return { id, username: p.username };
  }

  // ---------- Discord ----------
  const discordApi = (method, path, body) =>
    fetchImpl(`https://discord.com/api/v10${path}`, {
      method,
      headers: { Authorization: `Bot ${env.DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });

  const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
  function validSignature(raw, sig, ts) {
    try {
      const key = crypto.createPublicKey({
        key: Buffer.concat([SPKI_PREFIX, Buffer.from(env.DISCORD_PUBLIC_KEY, 'hex')]),
        format: 'der', type: 'spki',
      });
      return crypto.verify(null, Buffer.from(ts + raw), key, Buffer.from(sig, 'hex'));
    } catch { return false; }
  }

  const textInput = (custom_id, label, placeholder, max) => ({
    type: 1,
    components: [{ type: 4, custom_id, label, placeholder, style: 1, required: true, max_length: max }],
  });

  async function handleDiscord(req) {
    const raw = await req.text();
    const sig = req.headers.get('x-signature-ed25519');
    const ts = req.headers.get('x-signature-timestamp');
    if (!sig || !ts || !validSignature(raw, sig, ts)) return new Response('invalid request signature', { status: 401 });

    const i = JSON.parse(raw);
    const user = (i.member?.user ?? i.user);

    if (i.type === 1) return json({ type: 1 }); // PING

    // /painelallowlist -> posta o embed com botões no canal
    if (i.type === 2 && i.data.name === 'painelallowlist') {
      const bannerUrl = env.BANNER_URL || `${new URL(req.url).origin}/banner.png`;
      const buttons = [
        { type: 2, style: 2, label: 'Iniciar Allowlist', emoji: { name: '📝' }, custom_id: 'allowlist_abrir' },
      ];
      if (env.RULES_URL) {
        buttons.push({ type: 2, style: 5, label: 'Regras do Servidor', emoji: { name: '📜' }, url: env.RULES_URL });
      }
      const r = await discordApi('POST', `/channels/${i.channel_id}/messages`, {
        embeds: [{
          color: 0x8b0000, // vermelho escuro
          title: '📝 Faça sua Allowlist no Santa Califórnia RP!',
          description:
            'Antes de iniciar o preenchimento da allowlist, recomendamos que leia atentamente todas as regras do servidor para evitar problemas futuros.\n\n' +
            '> Após estar ciente de todas as regras, clique no botão abaixo para iniciar a allowlist e garantir sua entrada no servidor.\n\n' +
            '**Como funciona**\n' +
            '1️⃣ Tente entrar no servidor do Roblox e anote o **código** que aparecer.\n' +
            '2️⃣ Clique em **Iniciar Allowlist** e preencha o formulário.\n' +
            '3️⃣ Receba seu **ID** e entre no jogo.',
          image: { url: bannerUrl },
          footer: { text: 'Santa Califórnia RP © Todos os direitos reservados' },
        }],
        components: [{ type: 1, components: buttons }],
      });
      return reply(r.ok ? '✅ Painel enviado.' : '❌ Não consegui enviar. Dê ao bot permissão de ver e enviar mensagens neste canal.');
    }

    // clicou no botão -> abre o formulário
    if (i.type === 3 && i.data.custom_id === 'allowlist_abrir') {
      const linked = await get(`discord:${user.id}`);
      if (linked != null) {
        const p = await get(`player:${linked}`);
        if (p?.verified) return reply(`✅ Você já está liberado. Seu ID é **${p.allowId}**.`);
      }
      return json({
        type: 9,
        data: {
          custom_id: 'allowlist_form',
          title: 'Allowlist | Santa Califórnia RP',
          components: [
            textInput('nome', 'Nome do personagem', 'Ex: João Silva', 40),
            textInput('idade_rp', 'Idade no roleplay', 'Ex: 25', 3),
            textInput('idade_real', 'Idade na vida real', 'Ex: 18', 3),
            textInput('codigo', 'Código da allowlist (aparece no jogo)', 'Ex: K7M2XQ', 6),
          ],
        },
      });
    }

    // enviou o formulário
    if (i.type === 5 && i.data.custom_id === 'allowlist_form') {
      const f = {};
      for (const row of i.data.components) for (const c of row.components) f[c.custom_id] = (c.value || '').trim();

      if (!/^\d{1,3}$/.test(f.idade_rp) || !/^\d{1,3}$/.test(f.idade_real)) return reply('❌ As idades precisam ser números.');
      const idadeRp = Number(f.idade_rp), idadeReal = Number(f.idade_real);
      if (idadeRp < 1 || idadeRp > 120 || idadeReal < 1 || idadeReal > 99) return reply('❌ Idade inválida.');
      if (!f.nome) return reply('❌ Informe o nome do personagem.');

      const r = await verify({ code: f.codigo.toUpperCase(), nome: f.nome, idadeRp, idadeReal }, user.id);
      if (r.err) return reply(`❌ ${r.err}`);

      // extras opcionais (em paralelo, com limite de tempo pra não estourar os 3s do Discord)
      const extras = [];
      if (env.VERIFIED_ROLE_ID)
        extras.push(discordApi('PUT', `/guilds/${i.guild_id}/members/${user.id}/roles/${env.VERIFIED_ROLE_ID}`));
      if (env.SET_NICKNAME === 'true')
        extras.push(discordApi('PATCH', `/guilds/${i.guild_id}/members/${user.id}`, { nick: `${r.id} | ${f.nome}`.slice(0, 32) }));
      if (env.LOG_CHANNEL_ID)
        extras.push(discordApi('POST', `/channels/${env.LOG_CHANNEL_ID}/messages`, {
          embeds: [{
            color: 0x57f287,
            title: '✅ Nova allowlist',
            fields: [
              { name: 'ID', value: String(r.id), inline: true },
              { name: 'Personagem', value: f.nome, inline: true },
              { name: 'Idade RP / Real', value: `${idadeRp} / ${idadeReal}`, inline: true },
              { name: 'Discord', value: `<@${user.id}>`, inline: true },
              { name: 'Roblox', value: r.username || '—', inline: true },
            ],
            timestamp: new Date().toISOString(),
          }],
        }));
      await withTimeout(Promise.allSettled(extras), 1800);

      return reply(`✅ Liberado, **${f.nome}**! Seu ID é **${r.id}**. Já pode entrar no servidor do Roblox.`);
    }

    return reply('Ação desconhecida.');
  }

  // ---------- roteador ----------
  return async function handle(req) {
    const { pathname } = new URL(req.url);
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

    if (pathname === '/discord') return handleDiscord(req);

    if (pathname === '/join') {
      const sent = Buffer.from(req.headers.get('x-api-key') || '');
      const want = Buffer.from(env.API_KEY || '');
      if (!want.length || sent.length !== want.length || !crypto.timingSafeEqual(sent, want))
        return json({ error: 'unauthorized' }, 401);

      let body;
      try { body = await req.json(); } catch { return json({ error: 'json inválido' }, 400); }
      if (!Number.isInteger(body?.robloxId)) return json({ error: 'robloxId inválido' }, 400);
      return json(await join(body));
    }

    return json({ error: 'not found' }, 404);
  };
}
