import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import Database from 'better-sqlite3';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const PREFIX = process.env.PREFIX || '!';
const db = new Database('kv.db');

// Initialize table
db.prepare(`
  CREATE TABLE IF NOT EXISTS kv (
    guild_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    author_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (guild_id, key)
  )
`).run();

const setStmt = db.prepare(`
  INSERT INTO kv (guild_id, key, value, author_id, updated_at)
  VALUES (@guild_id, @key, @value, @author_id, @updated_at)
  ON CONFLICT(guild_id, key) DO UPDATE SET
    value=excluded.value,
    author_id=excluded.author_id,
    updated_at=excluded.updated_at
`);
const getStmt = db.prepare(`SELECT value FROM kv WHERE guild_id=? AND key=?`);
const delStmt = db.prepare(`DELETE FROM kv WHERE guild_id=? AND key=?`);
const allStmt = db.prepare(`SELECT key, value FROM kv WHERE guild_id=? ORDER BY key`);

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', (msg) => {
  if (msg.author.bot) return;
  if (!msg.content.startsWith(PREFIX)) return;

  const [cmd, ...rest] = msg.content.slice(PREFIX.length).trim().split(/\s+/);
  const guildId = msg.guild?.id ?? `DM-${msg.author.id}`;

  try {
    if (cmd === 'set') {
      // !set <key> <value...>
      const key = rest.shift();
      if (!key) return msg.reply(`Usage: ${PREFIX}set <key> <value>`);
      const value = rest.join(' ');
      if (!value) return msg.reply(`Provide a value. Example: ${PREFIX}set motto "Ship fast."`);
      setStmt.run({
        guild_id: guildId,
        key,
        value,
        author_id: msg.author.id,
        updated_at: new Date().toISOString()
      });
      return msg.reply(`Saved **${key}** ✅`);
    }

    if (cmd === 'get') {
      // !get <key>
      const key = rest[0];
      if (!key) return msg.reply(`Usage: ${PREFIX}get <key>`);
      const row = getStmt.get(guildId, key);
      return msg.reply(row ? `**${key}** = ${row.value}` : `No value for **${key}**.`);
    }

    if (cmd === 'del') {
      // !del <key>
      const key = rest[0];
      if (!key) return msg.reply(`Usage: ${PREFIX}del <key>`);
      const info = delStmt.run(guildId, key);
      return msg.reply(info.changes ? `Deleted **${key}** 🗑️` : `Nothing to delete for **${key}**.`);
    }

    if (cmd === 'all') {
      // !all [prefixFilter]
      const prefixFilter = rest[0];
      let rows = allStmt.all(guildId);
      if (prefixFilter) rows = rows.filter(r => r.key.startsWith(prefixFilter));
      if (rows.length === 0) return msg.reply('No entries yet.');
      const lines = rows.map(r => `• **${r.key}**: ${r.value}`);
      return msg.reply(lines.join('\n').slice(0, 1900)); // stay under Discord limit
    }

    if (cmd === 'help') {
      return msg.reply(
        `Commands:
${PREFIX}set <key> <value>
${PREFIX}get <key>
${PREFIX}del <key>
${PREFIX}all [keyPrefix]
${PREFIX}help`
      );
    }
  } catch (err) {
    console.error(err);
    msg.reply('Error processing command.');
  }
});

client.login(process.env.DISCORD_TOKEN);