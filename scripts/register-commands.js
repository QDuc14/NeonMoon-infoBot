import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder, ContextMenuCommandBuilder, ApplicationCommandType } from 'discord.js';

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID || null;

if (!token || !clientId) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in .env');
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName('settz')
    .setDescription('Save your timezone (IANA, e.g., Asia/Ho_Chi_Minh)')
    .addStringOption(o => o.setName('tz').setDescription('Your IANA timezone').setRequired(true))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('mytime')
    .setDescription('Show your current local time')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('remind')
    .setDescription('Schedule a reminder (YYYY-MM-DD HH:mm) in your timezone')
    .addStringOption(o => o.setName('text').setDescription('What to remind you about').setRequired(true))
    .addStringOption(o => o.setName('when').setDescription('When (YYYY-MM-DD HH:mm)').setRequired(true))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('luna')
    .setDescription('Luna-chan')
    .addStringOption(o => o.setName('message').setDescription('Your message').setRequired(true))
    .toJSON(),
  new ContextMenuCommandBuilder()
    .setName('Ask Luna')
    .setType(ApplicationCommandType.Message)
    .toJSON()
];

const rest = new REST({ version: '10' }).setToken(token);

try {
  if (guildId) {
    console.log(`[register] Registering ${commands.length} commands to guild ${guildId}`);
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log('[register] Done (guild).');
  } else {
    console.log(`[register] Registering ${commands.length} global commands`);
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('[register] Done (global).');
  }
} catch (err) {
  console.error(err);
  process.exit(1);
}
