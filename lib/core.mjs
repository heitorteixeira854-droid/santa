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
    if (p?.verified) return { status: 'ok', id: p.allowId };
    // allowlist desligada (modo aberto): todo mundo entra, sem gerar código nem ID
    if ((await get('meta:required')) === false) return { status: 'open' };
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

  const nickOn = env.SET_NICKNAME === 'true';

  // muda (ou remove, com nick=null) o apelido; devolve true/false
  async function setNick(guildId, userId, nick) {
    try {
      const r = await discordApi('PATCH', `/guilds/${guildId}/members/${userId}`, { nick });
      return !!r.ok;
    } catch { return false; }
  }

  // IDs de Discord de todo mundo liberado (estão no nome das chaves "discord:<id>")
  async function listDiscordIds() {
    const ids = [];
    for await (const page of store.list({ prefix: 'discord:', paginate: true })) {
      for (const b of page.blobs) ids.push(b.key.slice('discord:'.length));
    }
    return ids;
  }

  // troca o ID de uma pessoa já liberada
  async function changeId(robloxId, newId) {
    const p = await get(`player:${robloxId}`);
    if (!p?.verified) return { err: 'Essa pessoa não está liberada.' };
    if (p.allowId === newId) return { err: `Essa pessoa já tem o ID ${newId}.` };
    if (!(await create(`id:${newId}`, robloxId))) return { err: `O ID ${newId} já está em uso por outra pessoa.` };
    await put(`player:${robloxId}`, { ...p, allowId: newId });
    await store.delete(`id:${p.allowId}`);
    return { p, oldId: p.allowId };
  }

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

    const isAdmin = () => (BigInt(i.member?.permissions ?? 0) & 8n) === 8n;

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

    const options = () => Object.fromEntries((i.data.options || []).map((o) => [o.name, o.value]));
    const NICK_WARN = ' ⚠️ Não consegui mexer no apelido (o cargo do bot precisa estar acima do cargo da pessoa, e o dono do servidor nunca pode ser alterado).';

    // /removerallow -> remove UMA pessoa (por @usuario ou por ID) e tira o apelido
    if (i.type === 2 && i.data.name === 'removerallow') {
      if (!isAdmin()) return reply('❌ Só administradores podem usar este comando.');
      const opt = options();
      let robloxId = null;
      if (opt.usuario) robloxId = await get(`discord:${opt.usuario}`);
      else if (opt.id != null) robloxId = await get(`id:${opt.id}`);
      else return reply('❌ Informe o @usuario ou o ID.');
      if (robloxId == null) return reply('❌ Não encontrei essa pessoa na allowlist.');

      const p = await get(`player:${robloxId}`);
      const keys = [`player:${robloxId}`, `claim:${robloxId}`];
      if (p?.code) keys.push(`code:${p.code}`);
      if (p?.allowId != null) keys.push(`id:${p.allowId}`);
      if (p?.discordId) keys.push(`discord:${p.discordId}`);
      await Promise.all(keys.map((k) => store.delete(k)));

      const roleDel = env.VERIFIED_ROLE_ID && p?.discordId
        ? Promise.resolve(discordApi('DELETE', `/guilds/${i.guild_id}/members/${p.discordId}/roles/${env.VERIFIED_ROLE_ID}`)).catch(() => {})
        : null;
      const nickDel = nickOn && p?.discordId ? setNick(i.guild_id, p.discordId, null) : null;
      const [, nickOk] = (await withTimeout(Promise.all([roleDel, nickDel]), 1800)) ?? [];

      let msg = `✅ Removido: **${p?.nome || p?.username || robloxId}** (ID ${p?.allowId ?? '—'}). Na próxima vez que entrar no jogo, receberá um novo código.`;
      if (nickOn) msg += nickOk === true ? ' Apelido removido.' : NICK_WARN;
      return reply(msg);
    }

    // /alterarid -> troca o ID de uma pessoa (banco + apelido)
    if (i.type === 2 && i.data.name === 'alterarid') {
      if (!isAdmin()) return reply('❌ Só administradores podem usar este comando.');
      const opt = options();
      const newId = opt.novo_id;
      if (!Number.isInteger(newId) || newId < 1) return reply('❌ O novo ID precisa ser um número maior que 0.');
      let robloxId = null;
      if (opt.usuario) robloxId = await get(`discord:${opt.usuario}`);
      else if (opt.id_atual != null) robloxId = await get(`id:${opt.id_atual}`);
      else return reply('❌ Informe o @usuario ou o id_atual da pessoa.');
      if (robloxId == null) return reply('❌ Não encontrei essa pessoa na allowlist.');

      const r = await changeId(robloxId, newId);
      if (r.err) return reply(`❌ ${r.err}`);
      const { p, oldId } = r;

      const nickSet = nickOn && p.discordId ? setNick(i.guild_id, p.discordId, `${newId} | ${p.nome}`.slice(0, 32)) : null;
      const logMsg = env.LOG_CHANNEL_ID
        ? Promise.resolve(discordApi('POST', `/channels/${env.LOG_CHANNEL_ID}/messages`, {
            embeds: [{
              color: 0xfee75c,
              title: '🔁 ID alterado',
              fields: [
                { name: 'Personagem', value: p.nome || p.username || String(robloxId), inline: true },
                { name: 'ID', value: `${oldId} → ${newId}`, inline: true },
                { name: 'Discord', value: p.discordId ? `<@${p.discordId}>` : '—', inline: true },
                { name: 'Alterado por', value: `<@${user.id}>`, inline: true },
              ],
              timestamp: new Date().toISOString(),
            }],
          })).catch(() => {})
        : null;
      const [nickOk] = (await withTimeout(Promise.all([nickSet, logMsg]), 1800)) ?? [];

      let msg = `✅ ID de **${p.nome || p.username}** alterado: **${oldId}** → **${newId}**.`;
      if (nickOn) msg += nickOk === true ? ' Apelido atualizado.' : NICK_WARN;
      msg += ' No jogo, vale na próxima vez que a pessoa entrar.';
      return reply(msg);
    }

    // /allowlist -> liga/desliga a exigência de allowlist (ex.: para gravar trailer)
    if (i.type === 2 && i.data.name === 'allowlist') {
      if (!isAdmin()) return reply('❌ Só administradores podem usar este comando.');
      const estado = options().estado;
      const ligada = (await get('meta:required')) !== false;
      if (estado === 'status') {
        return reply(ligada
          ? '🔒 Allowlist **ATIVADA**: só entra quem está liberado.'
          : '🔓 Allowlist **DESATIVADA**: o servidor está aberto, qualquer pessoa entra.');
      }
      const quer = estado === 'ligar';
      if (quer === ligada) return reply(ligada ? '🔒 A allowlist já está **ativada**.' : '🔓 A allowlist já está **desativada**.');
      await put('meta:required', quer);

      if (env.LOG_CHANNEL_ID) {
        await withTimeout(Promise.resolve(discordApi('POST', `/channels/${env.LOG_CHANNEL_ID}/messages`, {
          embeds: [{
            color: quer ? 0x57f287 : 0xed4245,
            title: quer ? '🔒 Allowlist ATIVADA' : '🔓 Allowlist DESATIVADA',
            description: `Alterado por <@${user.id}>.`,
            timestamp: new Date().toISOString(),
          }],
        })).catch(() => {}), 1800);
      }
      return reply(quer
        ? '🔒 Allowlist **ativada**. Quem não estiver liberado será barrado ao entrar. (Quem já está dentro do jogo só é barrado se sair e entrar de novo.)'
        : '🔓 Allowlist **desativada**. Qualquer pessoa pode entrar no jogo agora. Lembre de usar `/allowlist estado:Ligar` quando terminar!');
    }

    // /resetarids -> pede confirmação antes de apagar TUDO
    if (i.type === 2 && i.data.name === 'resetarids') {
      if (!isAdmin()) return reply('❌ Só administradores podem usar este comando.');
      return json({
        type: 4,
        data: {
          flags: EPHEMERAL,
          content: '⚠️ **Isso apaga TODOS os IDs e allowlists' + (nickOn ? ' e remove o apelido de todo mundo que foi liberado' : '') + '.** Todos os jogadores precisarão refazer o processo e o próximo ID será o **1**. Tem certeza?',
          components: [{ type: 1, components: [
            { type: 2, style: 4, label: 'Sim, apagar tudo', emoji: { name: '🗑️' }, custom_id: 'reset_confirm' },
          ] }],
        },
      });
    }
    if (i.type === 3 && i.data.custom_id === 'reset_confirm') {
      if (!isAdmin()) return reply('❌ Só administradores podem fazer isso.');
      // guarda a lista de quem tem apelido ANTES de apagar, e deixa o resto para a função em segundo plano
      const ids = nickOn ? await listDiscordIds() : [];
      let started = false;
      try {
        const r = await fetchImpl(`${new URL(req.url).origin}/.netlify/functions/reset-background`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': env.API_KEY },
          body: JSON.stringify({ guildId: i.guild_id, ids, appId: i.application_id, token: i.token }),
        });
        started = r.ok || r.status === 202;
      } catch { /* cai no aviso abaixo */ }
      return json({
        type: 7,
        data: {
          components: [],
          content: started
            ? '⏳ Apagando tudo' + (ids.length ? ` e removendo o apelido de **${ids.length}** pessoa(s)` : '') + '... Esta mensagem será atualizada quando terminar.'
            : '❌ Não consegui iniciar o reset. Nada foi apagado. Tente de novo.',
        },
      });
    }

    // clicou no botão -> abre o formulário
    if (i.type === 3 && i.data.custom_id === 'allowlist_abrir') {
      if ((await get('meta:required')) === false) {
        return reply('🔓 A allowlist está **desativada** no momento: o servidor está aberto, é só entrar no jogo!');
      }
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
