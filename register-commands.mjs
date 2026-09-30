// Rode UMA vez (e de novo só se mudar o comando): npm run register
const { DISCORD_TOKEN, DISCORD_APP_ID, DISCORD_GUILD_ID } = process.env;

const res = await fetch(
  `https://discord.com/api/v10/applications/${DISCORD_APP_ID}/guilds/${DISCORD_GUILD_ID}/commands`,
  {
    method: 'PUT',
    headers: { Authorization: `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([
      {
        name: 'painelallowlist',
        description: 'Envia o painel de allowlist neste canal',
        default_member_permissions: '8', // só Administrador
        dm_permission: false,
      },
      {
        name: 'removerallow',
        description: 'Remove a allowlist de uma pessoa (por @usuário ou por ID)',
        default_member_permissions: '8',
        dm_permission: false,
        options: [
          { type: 6, name: 'usuario', description: 'Membro do Discord', required: false },
          { type: 4, name: 'id', description: 'ID da allowlist (número)', required: false, min_value: 1 },
        ],
      },
      {
        name: 'resetarids',
        description: 'Apaga TODOS os IDs e allowlists (pede confirmação)',
        default_member_permissions: '8',
        dm_permission: false,
      },
    ]),
  },
);
console.log(res.status, await res.text());
