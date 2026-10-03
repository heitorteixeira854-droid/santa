// Roda na função em segundo plano: apaga tudo, tira os apelidos e avisa o admin.
const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runReset({ store, payload, env, fetchImpl = fetch, sleep = sleepDefault }) {
  const { guildId, ids = [], appId, token } = payload;
  const headers = { Authorization: `Bot ${env.DISCORD_TOKEN}`, 'Content-Type': 'application/json' };

  const editOriginal = (content) =>
    fetchImpl(`https://discord.com/api/v10/webhooks/${appId}/${token}/messages/@original`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, components: [] }),
    }).catch(() => {});

  // 1) apaga o banco inteiro (mantendo o modo "allowlist desligada", se estiver assim)
  try {
    const required = await store.get('meta:required', { type: 'json' });
    await store.deleteAll();
    if (required === false) await store.set('meta:required', JSON.stringify(false));
  } catch (e) {
    console.error('Erro ao apagar:', e);
    await editOriginal('❌ Deu erro ao apagar os dados. Nada foi removido do Discord. Tente de novo.');
    return { ok: 0, fail: 0, wiped: false };
  }

  // 2) tira o apelido de cada pessoa (respeita o limite de requisições do Discord)
  let ok = 0, fail = 0;
  for (const id of ids) {
    let done = false;
    for (let attempt = 0; attempt < 5 && !done; attempt++) {
      try {
        const r = await fetchImpl(`https://discord.com/api/v10/guilds/${guildId}/members/${id}`, {
          method: 'PATCH', headers, body: JSON.stringify({ nick: null }),
        });
        if (r.status === 429) {
          const j = await r.json().catch(() => ({}));
          await sleep(((j.retry_after ?? 1) * 1000) + 150);
          continue;
        }
        if (r.ok) ok++; else fail++;
        done = true;
      } catch { await sleep(500); }
    }
    if (!done) fail++;
    await sleep(120);
  }

  // 3) avisa o admin
  let msg = '✅ Tudo apagado. O próximo ID será o **1**.';
  if (ids.length) {
    msg += `\n🏷️ Apelidos removidos: **${ok}** de **${ids.length}**.`;
    if (fail) msg += `\n⚠️ **${fail}** não puderam ser alterados (saíram do servidor, são o dono, ou têm cargo acima do bot).`;
  }
  await editOriginal(msg);
  return { ok, fail, wiped: true };
}
