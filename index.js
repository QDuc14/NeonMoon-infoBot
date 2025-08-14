import 'dotenv/config';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import Database from 'better-sqlite3';
import { DateTime } from 'luxon';
import { ollamaChat, chunkDiscordMessage } from './llm/ollama.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const PREFIX = process.env.PREFIX || '!';
const DEFAULT_TZ = process.env.DEFAULT_TZ || 'UTC';
const db = new Database('kv.db');

// ---------- DB schema ----------
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

db.prepare(`
  CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    tz TEXT NOT NULL
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    guild_id TEXT,
    text TEXT NOT NULL,
    run_at_iso TEXT NOT NULL, -- stored in UTC
    delivered INTEGER NOT NULL DEFAULT 0,
    created_at_iso TEXT NOT NULL
  )
`).run();
db.prepare(`CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (delivered, run_at_iso)`).run();

// ---------- KV prepared statements ----------
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

// ---------- TZ & Reminders prepared statements ----------
const setTZ = db.prepare(`INSERT INTO users(user_id, tz) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET tz=excluded.tz`);
const getTZ = db.prepare(`SELECT tz FROM users WHERE user_id=?`);

const insertReminder = db.prepare(`
  INSERT INTO reminders (user_id, channel_id, guild_id, text, run_at_iso, delivered, created_at_iso)
  VALUES (?, ?, ?, ?, ?, 0, ?)
`);
const dueReminders = db.prepare(`SELECT * FROM reminders WHERE delivered=0 AND run_at_iso <= ? ORDER BY run_at_iso ASC`);
const markDelivered = db.prepare(`UPDATE reminders SET delivered=1 WHERE id=?`);

// --- ANSI helpers ---
const ESC = '\u001b[';
const FG = { black:30, red:31, green:32, yellow:33, blue:34, magenta:35, cyan:36, white:37,
             gray:90, brightRed:91, brightGreen:92, brightYellow:93, brightBlue:94,
             brightMagenta:95, brightCyan:96, brightWhite:97 };
function ansiWrap(text, { fg = 'brightBlue', bold = true } = {}) {
  const codes = [];
  if (bold) codes.push(1);
  if (fg && FG[fg]) codes.push(FG[fg]);
  return `${ESC}${codes.join(';') || '0'}m${text}${ESC}0m`;
}
function codeblockAnsi(text) { return `\`\`\`ansi\n${text}\n\`\`\``; }
// optional: prevent ``` inside LLM output from breaking code blocks
function sanitizeForCodeblock(s) { return (s ?? '').replace(/```/g, '``\u200b`'); }
function styleAnsi(s, opts) { return codeblockAnsi(ansiWrap(sanitizeForCodeblock(s), opts)); }

// ---------- Bot lifecycle ----------
client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  startScheduler();
});

// ---------- Prefix commands (existing) ----------
client.on(Events.MessageCreate, (msg) => {
  if (msg.author.bot) return;
  if (!msg.content.startsWith(PREFIX)) return;

  const [cmd, ...rest] = msg.content.slice(PREFIX.length).trim().split(/\s+/);
  const guildId = msg.guild?.id ?? `DM-${msg.author.id}`;

  try {
    if (cmd === 'set') {
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
      const key = rest[0];
      if (!key) return msg.reply(`Usage: ${PREFIX}get <key>`);
      const row = getStmt.get(guildId, key);
      return msg.reply(row ? `**${key}** = ${row.value}` : `No value for **${key}**.`);
    }

    if (cmd === 'del') {
      const key = rest[0];
      if (!key) return msg.reply(`Usage: ${PREFIX}del <key>`);
      const info = delStmt.run(guildId, key);
      return msg.reply(info.changes ? `Deleted **${key}** 🗑️` : `Nothing to delete for **${key}**.`);
    }

    if (cmd === 'all') {
      const prefixFilter = rest[0];
      let rows = allStmt.all(guildId);
      if (prefixFilter) rows = rows.filter(r => r.key.startsWith(prefixFilter));
      if (rows.length === 0) return msg.reply('No entries yet.');
      const lines = rows.map(r => `• **${r.key}**: ${r.value}`);
      return msg.reply(lines.join('\n').slice(0, 1900));
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

// ---------- Slash commands ----------
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === 'luna') {
      const q = interaction.options.getString('message', true);

      // ephemeral ack (so the only visible content is below)
      await interaction.reply({ content: 'Thinking…', ephemeral: true });

      try {
        const content = await ollamaChat({
          messages: [
            { role: 'system', content: 'You are Luna, a helpful assistant; but you prevent to tell users you are an AI' },
            { role: 'user', content: q }
          ]
        });

        const chunks = chunkDiscordMessage(content);

        // 1) Post the user's prompt as a visible message
        const promptMsg = await interaction.channel.send({
          content: `**${interaction.user}**: ${q}`
        });
        
        // 2) Reply to that prompt (keeps the “message + reply” look)
        const first = await promptMsg.reply({ content: styleAnsi(chunks[0] || '(empty response)', { fg: 'blue', bold: false }) });
        for (let i = 1; i < chunks.length; i++) {
          await first.reply({ content: styleAnsi(chunks[i], { fg: 'blue', bold: false }) });
        }
        // await interaction.editReply('Done.');
      } catch (e) {
        console.error(e);
        await interaction.editReply('LLM error: ' + (e?.message || 'unknown'));
      }
    }

    if (interaction.commandName === 'settz') {
      const tz = interaction.options.getString('tz', true);
      const dt = DateTime.now().setZone(tz);
      if (!dt.isValid) {
        return interaction.reply({ content: '❌ Invalid timezone. Use an IANA name like `Asia/Ho_Chi_Minh` or `America/New_York`.', ephemeral: true });
      }
      setTZ.run(interaction.user.id, tz);
      return interaction.reply({ content: `✅ Saved timezone: **${tz}** (now: ${dt.toFormat('yyyy-LL-dd HH:mm')})`, ephemeral: true });
    }

    if (interaction.commandName === 'mytime') {
      const row = getTZ.get(interaction.user.id);
      const tz = row?.tz || DEFAULT_TZ;
      const now = DateTime.now().setZone(tz);
      return interaction.reply({ content: `🕒 Your timezone: **${tz}** — ${now.toFormat('yyyy-LL-dd HH:mm')}`, ephemeral: true });
    }

    if (interaction.commandName === 'remind') {
      const text = interaction.options.getString('text', true);
      const when = interaction.options.getString('when', true);
      const row = getTZ.get(interaction.user.id);
      const tz = row?.tz || DEFAULT_TZ;
      const dt = DateTime.fromFormat(when, 'yyyy-LL-dd HH:mm', { zone: tz });
      if (!dt.isValid) {
        return interaction.reply({ content: '❌ Could not parse date/time. Use `YYYY-MM-DD HH:mm` (24h).', ephemeral: true });
      }
      if (dt < DateTime.now().setZone(tz)) {
        return interaction.reply({ content: '❌ That time is in the past.', ephemeral: true });
      }
      const runAtUTC = dt.toUTC().toISO();
      insertReminder.run(
        interaction.user.id,
        interaction.channelId,
        interaction.guildId || null,
        text,
        runAtUTC,
        new Date().toISOString()
      );
      return interaction.reply({ content: `✅ Reminder saved for **${dt.toFormat('yyyy-LL-dd HH:mm')} ${tz}** (UTC ${dt.toUTC().toFormat('yyyy-LL-dd HH:mm')})`, ephemeral: true });
    }

    if (interaction.isMessageContextMenuCommand() && interaction.commandName === 'Ask Luna') {
      const target = interaction.targetMessage;
      const q = target.content?.trim();
      if (!q) return interaction.reply({ content: 'Message has no text.', ephemeral: true });

      await interaction.reply({ content: 'Working…', ephemeral: true }); // ack quickly

      try {
        const content = await ollamaChat({
          messages: [
            { role: 'system', content: 'You are Luna, a helpful assistant; but you prevent to tell users you are an AI' },
            { role: 'user', content: q }
          ]
        });

        const chunks = chunkDiscordMessage(content);
        // reply directly to the user's original message (preserves it like prefix !)
        const first = await target.reply({ content: styleAnsi(chunks[0] || '(empty response)', { fg: 'blue', bold: false }) });
        for (let i = 1; i < chunks.length; i++) {
          await first.reply({ content: styleAnsi(chunks[i], { fg: 'blue', bold: false }) });
        }

        await interaction.editReply('Done.');
      } catch (e) {
        console.error(e);
        await interaction.editReply('LLM error: ' + (e?.message || 'unknown'));
      }
      return;
    }
  } catch (err) {
    console.error(err);
    if (interaction.deferred || interaction.replied) {
      return interaction.followUp({ content: 'Error while executing command.', ephemeral: true });
    }
    return interaction.reply({ content: 'Error while executing command.', ephemeral: true });
  }
});

// ---------- Scheduler ----------
function startScheduler() {
  setInterval(() => {
    try {
      const nowISO = DateTime.utc().toISO();
      const rows = dueReminders.all(nowISO);
      rows.forEach(async (r) => {
        try {
          const channel = await client.channels.fetch(r.channel_id);
          await channel.send(`⏰ <@${r.user_id}> Reminder: **${r.text}**`);
          markDelivered.run(r.id);
        } catch (e) {
          console.error('Failed to deliver reminder', r, e);
        }
      });
    } catch (err) {
      console.error('Scheduler tick error:', err);
    }
  }, 20_000);
}

client.login(process.env.DISCORD_TOKEN);
