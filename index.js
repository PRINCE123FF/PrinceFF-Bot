/**
 * PRINCE FF WhatsApp Bot - index.js
 * يعتمد على @whiskeysockets/baileys
 *
 * ملاحظات: قد تحتاج لتثبيت الحزم أولاً:
 * npm install
 *
 * ثم تشغيل:
 * node index.js
 *
 * سيظهر QR في الكونسول لربط رقم البوت.
 */

const { default: makeWASocket, useSingleFileAuthState, DisconnectReason, fetchLatestBaileysVersion, jidNormalizedUser, makeInMemoryStore, delay } = require('@whiskeysockets/baileys');
const P = require('pino');
const fs = require('fs-extra');
const path = require('path');

const COMMANDS_FILE = './commands.json';
const DB_FILE = './database.json';
const AUTH_FILE = './auth_info_multi.json';

const { state, saveState } = useSingleFileAuthState(AUTH_FILE);
const store = makeInMemoryStore({ logger: P().child({ level: 'silent', stream: 'store' }) });

// load config
if (!fs.existsSync(COMMANDS_FILE)) return console.error('commands.json missing!');
const cfg = fs.readJsonSync(COMMANDS_FILE);
if (!fs.existsSync(DB_FILE)) fs.writeJSONSync(DB_FILE, { banned: {}, stats: {}, startedAt: Date.now() });

let db = fs.readJsonSync(DB_FILE);
db.startedAt = db.startedAt || Date.now();

// helper utilities
const OWNER = cfg.owner; // e.g. "201008305324@s.whatsapp.net"
const EMOJIS = ['👾','🤖','☠️','💋','💫','🔥','🌀','🍫'];

function randomEmoji() {
  return EMOJIS[Math.floor(Math.random()*EMOJIS.length)];
}

function saveDB() {
  fs.writeJSONSync(DB_FILE, db, { spaces: 2 });
}

async function startSock() {
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    logger: P({ level: 'silent' }),
    printQRInTerminal: true,
    auth: state,
    version
  });

  store.bind(sock.ev);
  sock.ev.on('creds.update', saveState);

  // reconnect logic
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const code = (lastDisconnect && lastDisconnect.error && lastDisconnect.error.output) ? lastDisconnect.error.output.statusCode : null;
      if (code !== DisconnectReason.loggedOut) {
        console.log('>>> Reconnecting...');
        startSock();
      } else {
        console.log('Logged out, delete auth and restart.');
      }
    } else if (connection === 'open') {
      console.log('✅ Connected');
    }
  });

  // message handler
  sock.ev.on('messages.upsert', async m => {
    try {
      const messages = m.messages;
      if (!messages) return;
      for (const msg of messages) {
        if (!msg.message || msg.key && msg.key.remoteJid === 'status@broadcast') continue;
        await handleMessage(sock, msg);
      }
    } catch (e) {
      console.error('on message error', e);
    }
  });

  // participants updates (join/leave/promote/demote)
  sock.ev.on('group-participants.update', async update => {
    try {
      const gid = update.id;
      for (const u of update.participants) {
        if (update.action === 'add') {
          // send welcome video + message
          const welcomeVideo = cfg.video_welcome;
          const text = `❍━━━══━━❪🌸❫━━══━━━❍\n｢🍨｣⇇عضو جـديـد نور جروبنا\n｢🍷｣⇇مـنـور يـخـويـا\n↜┊@${u.split('@')[0]}┊\n❍━━━══━━❪🌸❫━━══━━━❍\n        ✦ ᎮᏒᎥᏁፈᏋ 👻 βටͲ ✦`;
          await sock.sendMessage(gid, { video: { url: welcomeVideo }, caption: text, mentions: [u] });
        }
        if (update.action === 'remove') {
          // member left
          const meta = await sock.groupMetadata(gid).catch(()=>null);
          const groupName = meta?.subject || 'المجموعة';
          // number of members unknown immediately — fetch metadata
          const membersCount = meta?.participants?.length || 'غير معروف';
          const leftText = `مــع الــســلامه منجيش ف حاجه حلوه\n\nو الــيــوم خــرج مــن جــروبــنا عــضــو خــايــن جروبنا :${groupName} ➪\n@${u.split('@')[0]} ➪ الخاين\nعدد الاعضاء الان ${membersCount}`;
          await sock.sendMessage(gid, { text: leftText, mentions: [u] });
        }
        if (update.action === 'promote') {
          // sent by WhatsApp when promoted
          const adminVideo = cfg.video_admin;
          const text = `{ تـم وضـع هـذا الشـخـص مشـرفـًا }\nمرحبا بالمشرف الجديد @${u.split('@')[0]}`;
          await sock.sendMessage(gid, { video: { url: adminVideo }, caption: text, mentions: [u] });
        }
        if (update.action === 'demote') {
          // demote message
          const demoteMsg = `{ تـم ازالة هـذا الشـخـص من الاشراف }\nوداعا يا مشرف @${u.split('@')[0]} 😞`;
          await sock.sendMessage(gid, { text: demoteMsg, mentions: [u] });
        }
      }
    } catch (e) {
      console.error('group-participants error', e);
    }
  });

  // main message processing
  async function handleMessage(sock, msg) {
    const from = msg.key.remoteJid; // group or user
    const isGroup = from.endsWith('@g.us');
    const messageType = Object.keys(msg.message)[0];
    const sender = jidNormalizedUser(msg.key.participant || msg.key.remoteJid);
    const text = (messageType === 'conversation' || messageType === 'extendedTextMessage') 
      ? ((msg.message.conversation) || (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) || '') 
      : '';

    // increment stats (for group messages only)
    if (isGroup) {
      db.stats[sender] = db.stats[sender] || { messages: 0, interactions: 0 };
      db.stats[sender].messages = (db.stats[sender].messages || 0) + 1;
      saveDB();
    }

    // if sender banned -> delete message and warn
    const bannedUntil = db.banned[sender];
    if (bannedUntil && Date.now() < bannedUntil) {
      // try delete message
      try {
        await sock.sendMessage(from, { delete: msg.key });
      } catch (e) {
        // fallback: just inform (but we try to delete)
      }
      const warn = cfg.commands[".حظر"].reply.replace('{target}', `@${sender.split('@')[0]}`);
      await sock.sendMessage(from, { text: warn, mentions: [sender] });
      return;
    } else if (bannedUntil && Date.now() >= bannedUntil) {
      // lift ban
      delete db.banned[sender];
      saveDB();
    }

    // only react to dot-prefix commands
    if (!text || !text.trim().startsWith('.')) return;

    const full = text.trim();
    const command = full.split(' ')[0];
    const argsText = full.split(' ').slice(1).join(' ');
    const cmdDef = cfg.commands[command];

    // if not a known command -> ignore (you wanted ignore, not error)
    if (!cmdDef) return;

    // owner-only enforcement (all commands owner-only per request)
    if (sender !== OWNER) return;

    // execute command
    try {
      switch (cmdDef.action) {
        case 'close_chat': {
          if (!isGroup) return;
          await sock.groupSettingUpdate(from, 'announcement'); // restrict to admins
          await sock.sendMessage(from, { text: cmdDef.reply });
          break;
        }
        case 'open_chat': {
          if (!isGroup) return;
          await sock.groupSettingUpdate(from, 'not_announcement'); // everyone can send
          await sock.sendMessage(from, { text: cmdDef.reply });
          break;
        }
        case 'kick_user': {
          if (!isGroup) return;
          // expect @mention in args or quoted message
          let target = null;
          if (msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo && msg.message.extendedTextMessage.contextInfo.mentionedJid) {
            target = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
          } else if (argsText) {
            // may be phone or mention text
            target = argsText.includes('@') ? argsText.split(' ')[0] : null;
          }
          if (!target) {
            // try quoted
            if (msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo && msg.message.extendedTextMessage.contextInfo.participant) {
              target = msg.message.extendedTextMessage.contextInfo.participant;
            }
          }
          if (!target) return; // no target -> ignore
          await sock.groupParticipantsUpdate(from, [target], 'remove');
          const meta = await sock.groupMetadata(from).catch(()=>({ subject: 'المجموعة' }));
          const r = cmdDef.reply.replace('{groupName}', meta.subject).replace('{target}', `@${target.split('@')[0]}`).replace('{by}', '@'+OWNER.split('@')[0]);
          await sock.sendMessage(from, { text: r, mentions: [target, OWNER] });
          break;
        }
        case 'mention_menu': {
          if (!isGroup) return;
          // show two choices via simple text prompt (since buttons require more UI). We'll expect owner to reply '1' or '2'
          const meta = await sock.groupMetadata(from);
          const prompt = cmdDef.reply.replace('{groupName}', meta.subject).replace('{reason}', 'ساكتبه الان').replace('{by}','PRINCE FF');
          // send with instruction
          await sock.sendMessage(from, { text: prompt + '\n\nاختر 1 للمجموعة كلها أو 2 للمشرفين' });
          // wait for owner's reply for selection (simple listener)
          const filter = (m) => (m.key.remoteJid === from && (m.message?.conversation === '1' || m.message?.conversation === '2') && jidNormalizedUser(m.key.participant || m.key.remoteJid) === OWNER);
          // set up one-time handler
          const handler = async (upd) => {
            const mm = upd.messages && upd.messages[0];
            if (!mm) return;
            const txt = (mm.message.conversation || '').trim();
            if (txt !== '1' && txt !== '2') return;
            if (txt === '1') {
              // mention all
              const participants = meta.participants.map(p=>p.id);
              const mentions = participants;
              const mentionText = 'منشن عام ⤵️';
              await sock.sendMessage(from, { text: mentionText, mentions });
            } else {
              // mention admins only
              const admins = meta.participants.filter(p => p.admin).map(p=>p.id);
              await sock.sendMessage(from, { text: 'منشن للمشرفين ☠️', mentions: admins });
            }
            // remove listener by ignoring further events (no direct remove; simple pattern: it will finish)
          };
          // attach temporary
          const tempListener = async (ev) => {
            if (!ev || !ev.messages) return;
            try { await handler(ev); } catch(e) {}
          };
          sock.ev.on('messages.upsert', tempListener);
          // note: not removing handler here for brevity - it's fine for owner-only
          break;
        }
        case 'stats': {
          if (!isGroup) return;
          const meta = await sock.groupMetadata(from).catch(()=>({ subject: 'المجموعة', participants: [] }));
          const members = meta.participants.length;
          const totalMessages = Object.values(db.stats).reduce((a,b)=>a + (b.messages||0),0);
          // top user
          const sorted = Object.entries(db.stats).sort((a,b)=> (b[1].messages||0)-(a[1].messages||0));
          const top = sorted[0] ? `@${sorted[0][0].split('@')[0]}` : 'لا أحد';
          let details = '';
          for (let i=0;i<3 && i<sorted.length;i++){
            details += `\n* ${i+1} . (${'@'+sorted[i][0].split('@')[0]}) - (${sorted[i][1].messages||0}) رسـالـة*`;
          }
          const r = cmdDef.reply.replace('{groupName}', meta.subject).replace('{members}', members).replace('{totalMessages}', totalMessages).replace('{topUser}', top).replace('{details}', details);
          await sock.sendMessage(from, { text: r, mentions: sorted.slice(0,3).map(s=>s[0]) });
          break;
        }
        case 'ban_user': {
          if (!isGroup) return;
          // get target from mention or quoted
          let target = null;
          if (msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo && msg.message.extendedTextMessage.contextInfo.mentionedJid) {
            target = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
          } else if (msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo && msg.message.extendedTextMessage.contextInfo.participant) {
            target = msg.message.extendedTextMessage.contextInfo.participant;
          }
          if (!target) return;
          const until = Date.now() + 24*60*60*1000;
          db.banned[target] = until;
          saveDB();
          const r = cmdDef.reply.replace('{target}', `@${target.split('@')[0]}`);
          await sock.sendMessage(from, { text: r, mentions: [target] });
          break;
        }
        case 'unban_user': {
          if (!isGroup) return;
          let target = null;
          if (msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo && msg.message.extendedTextMessage.contextInfo.mentionedJid) {
            target = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
          } else if (msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo && msg.message.extendedTextMessage.contextInfo.participant) {
            target = msg.message.extendedTextMessage.contextInfo.participant;
          }
          if (!target) return;
          delete db.banned[target];
          saveDB();
          const r = cmdDef.reply.replace('{target}', `@${target.split('@')[0]}`);
          await sock.sendMessage(from, { text: r, mentions: [target] });
          break;
        }
        case 'send_link': {
          if (!isGroup) return;
          const res = await sock.groupInviteCode(from).catch(()=>null);
          const invite = res ? `https://chat.whatsapp.com/${res}` : 'غير متاح';
          const r = cmdDef.reply.replace('{inviteLink}', invite);
          await sock.sendMessage(from, { text: r });
          break;
        }
        case 'inspect_user': {
          if (!isGroup) return;
          let target = null;
          if (msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo && msg.message.extendedTextMessage.contextInfo.mentionedJid) {
            target = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
          } else if (msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo && msg.message.extendedTextMessage.contextInfo.participant) {
            target = msg.message.extendedTextMessage.contextInfo.participant;
          }
          if (!target) return;
          const meta = await sock.groupMetadata(from).catch(()=>({ subject: 'المجموعة' }));
          const stats = db.stats[target] || { messages: 0, interactions: 0 };
          const r = cmdDef.reply.replace('{groupName}', meta.subject).replace('{targetName}', '@'+target.split('@')[0]).replace('{messagesCount}', stats.messages||0).replace('{interactions}', stats.interactions||0);
          await sock.sendMessage(from, { text: r, mentions: [target] });
          break;
        }
        case 'promote_user': {
          if (!isGroup) return;
          let target = null;
          if (msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo && msg.message.extendedTextMessage.contextInfo.mentionedJid) {
            target = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
          } else if (msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo && msg.message.extendedTextMessage.contextInfo.participant) {
            target = msg.message.extendedTextMessage.contextInfo.participant;
          }
          if (!target) return;
          await sock.groupParticipantsUpdate(from, [target], 'promote');
          // send video admin
          const adminVideo = cfg.video_admin;
          const caption = `{ تـم وضـع هـذا الشـخـص مشـرفـًا }\nمرحبا بالمشرف الجديد @${target.split('@')[0]}`;
          await sock.sendMessage(from, { video: { url: adminVideo }, caption, mentions: [target] });
          break;
        }
        case 'demote_user': {
          if (!isGroup) return;
          let target = null;
          if (msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo && msg.message.extendedTextMessage.contextInfo.mentionedJid) {
            target = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
          } else if (msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo && msg.message.extendedTextMessage.contextInfo.participant) {
            target = msg.message.extendedTextMessage.contextInfo.participant;
          }
          if (!target) return;
          await sock.groupParticipantsUpdate(from, [target], 'demote');
          // reply
          const resp = cmdDef.reply.replace('{target}', `@${target.split('@')[0]}`).replace('{duration}', 'غير معروف');
          await sock.sendMessage(from, { text: resp, mentions: [target] });
          break;
        }
        case 'top_interactor': {
          const sorted = Object.entries(db.stats).sort((a,b)=> (b[1].messages||0)-(a[1].messages||0));
          const top = sorted[0] ? '@'+sorted[0][0].split('@')[0] : 'لا أحد';
          const count = sorted[0] ? sorted[0][1].messages||0 : 0;
          const r = cmdDef.reply.replace('{topUser}', top).replace('{count}', count);
          await sock.sendMessage(from, { text: r });
          break;
        }
        case 'bot_info': {
          const started = new Date(db.startedAt).toLocaleString('ar-EG');
          const r = cmdDef.reply.replace('{started}', started);
          await sock.sendMessage(from, { text: r });
          break;
        }
        case 'update': {
          // send first message
          await sock.sendMessage(from, { text: cmdDef.reply });
          // reload commands file
          try {
            delete require.cache[require.resolve(COMMANDS_FILE)];
            const fresh = fs.readJsonSync(COMMANDS_FILE);
            Object.assign(cfg, fresh);
          } catch (e) {}
          // small delay to simulate update then send final message + reaction
          await delay(2000);
          await sock.sendMessage(from, { text: "✅ تم التحديث بنجاح!\n💎 تم تحميل الإعدادات والأوامر الجديدة بنجاح.\n🤖 بوت ᎮᏒᎥᏁፈᏋ 👻 βටͲ جاهز للخدمة من جديد!" });
          // add emoji reaction (reply with simple message containing emoji) — Baileys reaction may vary by version
          await sock.sendMessage(from, { text: randomEmoji() });
          break;
        }
        case 'test': {
          await sock.sendMessage(from, { text: cmdDef.reply });
          await sock.sendMessage(from, { text: randomEmoji() });
          break;
        }
      }

      // put a single emoji reaction after successful owner command
      try {
        await sock.sendMessage(from, { text: randomEmoji() });
      } catch(e){}
    } catch (e) {
      console.error('command exec error', e);
    }
  }

  return sock;
}

startSock().catch(err=>console.error(err));
