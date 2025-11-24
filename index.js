/**
 * Dom Bot V2 - index.js
 * Features:
 *  - Owner(s) com senha (setpass / auth)
 *  - Admins persistidos (addadmin / deladmin)
 *  - Welcome / leave (detecta actor quando disponível)
 *  - Group admin actions (kick/promote/demote/close/open/mentionall)
 *  - Economia: coins, daily, pay, steal, give/gift (owner-only)
 *  - Cooldown por comando e anti-flood (mensagens/minuto)
 *  - Shop: /shop /buy
 *  - Diversão: /roll
 *  - Persistência em database.json
 *
 * Usage: node index.js
 */

import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import pino from "pino";
import fs from "fs";
import crypto from "crypto";
import path from "path";

const BOT_NAME = "Dom Bot V2";
const SESSION_FOLDER = "./session";
const DB_FILE = "database.json";
const PREFIX = "/";

// Default owner (initial). Format: '5531xxxxxxxx@s.whatsapp.net' (no plus)
const DEFAULT_OWNER = "5531973272146@s.whatsapp.net";

// Ensure DB file exists
if (!fs.existsSync(DB_FILE)) {
  const initial = {
    users: {},
    admins: [],
    owners: [DEFAULT_OWNER],
    ownerHash: null,
    shop: [
      { id: "vip", name: "VIP 1 dia", price: 500 },
      { id: "stickerpack", name: "Sticker Pack", price: 150 }
    ]
  };
  fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
}
function loadDB() { return JSON.parse(fs.readFileSync(DB_FILE)); }
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

// util: sha256
function sha256(s) { return crypto.createHash("sha256").update(String(s)).digest("hex"); }

// user/account helpers
function ensureUser(jid) {
  const db = loadDB();
  if (!db.users[jid]) {
    db.users[jid] = { coins: 0, msgs: 0, lastDaily: 0, joinedAt: Date.now() };
    saveDB(db);
  }
}
function addMsg(jid) {
  const db = loadDB(); ensureUser(jid);
  db.users[jid].msgs = (db.users[jid].msgs || 0) + 1;
  db.users[jid].coins = (db.users[jid].coins || 0) + 1; // 1 coin per message
  saveDB(db);
}
function addCoins(jid, amount) {
  const db = loadDB(); ensureUser(jid);
  db.users[jid].coins = (db.users[jid].coins || 0) + Number(amount);
  saveDB(db);
}
function getCoins(jid) { const db = loadDB(); ensureUser(jid); return db.users[jid].coins || 0; }
function stealCoins(fromJid, toJid) {
  const db = loadDB(); ensureUser(fromJid); ensureUser(toJid);
  let amount = Math.floor(Math.random() * 30) + 1;
  if (db.users[toJid].coins < amount) amount = db.users[toJid].coins;
  db.users[toJid].coins -= amount;
  db.users[fromJid].coins += amount;
  saveDB(db);
  return amount;
}
function addAdminToDB(jid) { const db = loadDB(); if (!db.admins.includes(jid)) { db.admins.push(jid); saveDB(db); } }
function delAdminFromDB(jid) { const db = loadDB(); db.admins = db.admins.filter(a => a !== jid); saveDB(db); }
function listAdminsFromDB() { return loadDB().admins || []; }
function listOwnersFromDB() { return loadDB().owners || []; }
function addOwnerToDB(jid) { const db = loadDB(); if (!db.owners.includes(jid)) { db.owners.push(jid); saveDB(db); } }
function setOwnerHash(hash) { const db = loadDB(); db.ownerHash = hash; saveDB(db); }

// Rate limiting / anti-flood
const commandCooldowns = new Map(); // jid -> lastCmdTs
const MESSAGE_WINDOW = 60 * 1000;
const messageCounts = new Map(); // jid -> { startTs, count }
function checkCooldown(jid, ms = 3000) {
  const now = Date.now(); const last = commandCooldowns.get(jid) || 0;
  if (now - last < ms) return false;
  commandCooldowns.set(jid, now); return true;
}
function checkMessageRate(jid) {
  const now = Date.now();
  const entry = messageCounts.get(jid) || { startTs: now, count: 0 };
  if (now - entry.startTs > MESSAGE_WINDOW) { entry.startTs = now; entry.count = 0; }
  entry.count += 1; messageCounts.set(jid, entry);
  if (entry.count > 70) return { ok: false, code: "block" };
  if (entry.count > 30) return { ok: false, code: "warn" };
  return { ok: true };
}

// display name helper (tries group metadata if available)
async function displayName(sock, groupId, jid) {
  try {
    if (groupId && groupId.endsWith("@g.us")) {
      const meta = await sock.groupMetadata(groupId);
      const p = meta.participants.find(x => x.id === jid);
      if (p) return p.notify || p.id.split("@")[0];
    }
  } catch (e) { /* ignore */ }
  return jid.split("@")[0];
}

// Start bot
async function start() {
  const logger = pino({ level: "silent" });
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 2314, 6] }));
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);

  const sock = makeWASocket({ version, auth: state, printQRInTerminal: false, logger });

  sock.ev.on("connection.update", (upd) => {
    if (upd.qr) {
      console.log(`\n📡 ${BOT_NAME} - Escaneie o QR (WhatsApp -> Dispositivos vinculados)`);
      qrcode.generate(upd.qr, { small: true });
    }
    if (upd.connection === "open") {
      console.log(`✅ ${BOT_NAME} conectado! Owners: ${listOwnersFromDB().join(", ")}`);
    }
    if (upd.connection === "close") {
      const reason = (upd.lastDisconnect && upd.lastDisconnect.error && upd.lastDisconnect.error.output) ? upd.lastDisconnect.error.output.statusCode : null;
      console.log("connection closed, reason:", reason);
      if (reason === DisconnectReason.loggedOut) {
        console.log("Sessão desconectada (logged out). Remova 'session/' e re-escaneie o QR.");
      } else {
        // try reconnect
        start().catch(() => { });
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // helpers to check group admin
  async function isGroupAdmin(groupId, jid) {
    try {
      const meta = await sock.groupMetadata(groupId);
      const p = meta.participants.find(x => x.id === jid);
      return !!(p && (p.admin || p.isAdmin || p.isSuperAdmin));
    } catch (e) { return false; }
  }
  async function isBotAdmin(groupId) {
    const botJid = sock.user && sock.user.id ? sock.user.id : null;
    return botJid ? await isGroupAdmin(groupId, botJid) : false;
  }
  async function isAuthorizedAdmin(groupId, senderJid) {
    if (listOwnersFromDB().includes(senderJid)) return true;
    if (listAdminsFromDB().includes(senderJid)) return true;
    const groupAdm = await isGroupAdmin(groupId, senderJid);
    if (groupAdm) return true;
    return false;
  }

  // group participants: welcome / leave / promote / demote
  sock.ev.on("group-participants.update", async (update) => {
    try {
      const groupId = update.id;
      const action = update.action;
      const participants = update.participants || [];
      const actor = update.actor || update.author;

      for (const p of participants) {
        ensureUser(p);
        if (action === "add") {
          const txt = `👋 Olá @${p.split("@")[0]}! Seja bem-vindo(a) ao grupo.\n\nLeia as regras e seja respeitoso.\n\n— ${BOT_NAME}`;
          await sock.sendMessage(groupId, { text: txt, mentions: [p] });
        } else if (action === "remove") {
          if (actor && actor !== p) {
            const txt = `🚨 @${p.split("@")[0]} foi removido(a) do grupo por @${actor.split("@")[0]}.`;
            await sock.sendMessage(groupId, { text: txt, mentions: [p, actor] });
          } else {
            const txt = `👋 @${p.split("@")[0]} saiu do grupo. Até mais!`;
            await sock.sendMessage(groupId, { text: txt, mentions: [p] });
          }
        } else if (action === "promote") {
          const txt = `⬆️ @${p.split("@")[0]} foi promovido(a) a admin.`;
          await sock.sendMessage(groupId, { text: txt, mentions: [p] });
        } else if (action === "demote") {
          const txt = `⬇️ @${p.split("@")[0]} deixou de ser admin.`;
          await sock.sendMessage(groupId, { text: txt, mentions: [p] });
        }
      }
    } catch (e) {
      console.error("group update error:", e);
    }
  });

  // messages / commands
  sock.ev.on("messages.upsert", async (m) => {
    try {
      const msg = m.messages[0]; if (!msg || !msg.message) return;
      if (msg.key && msg.key.fromMe) return;

      const from = msg.key.remoteJid;
      const sender = msg.key.participant || msg.key.remoteJid;

      // anti-flood
      const rate = checkMessageRate(sender);
      if (!rate.ok) {
        if (rate.code === "warn") {
          await sock.sendMessage(from, { text: `⚠️ @${sender.split("@")[0]} — você está enviando muitas mensagens. Diminua o ritmo.`, mentions: [sender] });
        } else {
          return; // block actions if extreme
        }
      }

      const type = Object.keys(msg.message)[0];
      let text = "";
      if (type === "conversation") text = msg.message.conversation || "";
      else if (type === "extendedTextMessage") text = msg.message.extendedTextMessage.text || "";
      else return;

      ensureUser(sender); addMsg(sender);

      if (!text.startsWith(PREFIX)) return;

      if (!checkCooldown(sender, 3000)) {
        await sock.sendMessage(from, { text: `⏳ @${sender.split("@")[0]} — aguarde alguns segundos entre comandos.`, mentions: [sender] });
        return;
      }

      const args = text.trim().split(/\s+/);
      const cmd = args[0].slice(PREFIX.length).toLowerCase();

      const isOwner = listOwnersFromDB().includes(sender);
      const isDBAdmin = listAdminsFromDB().includes(sender);
      const groupContext = from && from.endsWith("@g.us");
      const authorized = groupContext ? await isAuthorizedAdmin(from, sender) : (isOwner || isDBAdmin);

      const reply = async (txt, mentions) => {
        if (mentions) await sock.sendMessage(from, { text: txt, mentions });
        else await sock.sendMessage(from, { text: txt });
      };

      // HELP / ABOUT
      if (cmd === "help" || cmd === "about") {
        const about = `🛡️ *${BOT_NAME}*\nOwners: ${listOwnersFromDB().map(x => x.split("@")[0]).join(", ")}\n\nComandos:\n` +
          `/help /about\n` +
          `Economia: /coin /rank /daily /pay @user <amount> /steal @user\n` +
          `Lazer: /roll /shop /buy <itemid>\n` +
          `Admin: /kick /ban /promote /demote /mentionall /close /open\n` +
          `Owner: /setpass <senha> (owner) /auth <senha> (privado) /addadmin /deladmin /give /gift\n` +
          `Prefixo: ${PREFIX}`;
        return reply(about);
      }

      // ========== AUTH (owner via password) ==========
      if (cmd === "setpass") {
        if (!isOwner) return reply("❌ Apenas owner pode definir a senha.");
        const pass = args[1];
        if (!pass) return reply("Uso: /setpass <senha>");
        setOwnerHash(sha256(pass));
        return reply("✅ Senha definida. Usuários podem usar /auth <senha> em privado.");
      }
      if (cmd === "auth") {
        // only private
        if (from.endsWith("@g.us")) return reply("Use /auth apenas em conversa privada com o bot.");
        const pass = args[1];
        if (!pass) return reply("Uso: /auth <senha>");
        const db = loadDB();
        if (!db.ownerHash) return reply("A senha ainda não foi definida pelo owner principal.");
        if (sha256(pass) === db.ownerHash) {
          addOwnerToDB(sender);
          return reply("✅ Autenticado como owner verificado!");
        } else return reply("❌ Senha incorreta.");
      }

      // OWNER admin persistence
      if (cmd === "addadmin") {
        if (!isOwner) return reply("❌ Apenas owners podem adicionar admins persistentes.");
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
        if (!mentioned || !mentioned[0]) return reply("Marque quem será admin.");
        addAdminToDB(mentioned[0]);
        return reply(`✅ ${mentioned[0].split("@")[0]} agora é admin persistente.`, mentioned);
      }
      if (cmd === "deladmin") {
        if (!isOwner) return reply("❌ Apenas owners podem remover admins persistentes.");
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
        if (!mentioned || !mentioned[0]) return reply("Marque quem remover.");
        delAdminFromDB(mentioned[0]);
        return reply(`❌ ${mentioned[0].split("@")[0]} removido dos admins.`, mentioned);
      }

      // OWNER give/gift
      if (cmd === "give") {
        if (!isOwner) return reply("❌ Apenas owners podem usar /give.");
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
        const amount = Number(args[2]);
        if (!mentioned || !mentioned[0] || !amount || amount <= 0) return reply("Uso: /give @user <amount>");
        addCoins(mentioned[0], amount);
        return reply(`🎁 Dono deu ${amount} coins para @${mentioned[0].split("@")[0]}`, mentioned);
      }
      if (cmd === "gift") {
        if (!isOwner) return reply("❌ Apenas owners podem usar /gift.");
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
        if (!mentioned || !mentioned[0]) return reply("Marque alguém.");
        addCoins(mentioned[0], 100);
        return reply(`🎁 @${mentioned[0].split("@")[0]} recebeu 100 coins!`, mentioned);
      }

      // GROUP admin commands
      if (["kick", "ban", "promote", "demote", "mentionall", "close", "open"].includes(cmd)) {
        if (!groupContext) return reply("Esse comando só funciona em grupos.");
        if (!authorized) return reply("❌ Você não tem permissão.");
        const botIsAdmin = await isBotAdmin(from);
        if ((["kick", "ban", "promote", "demote", "close", "open"].includes(cmd)) && !botIsAdmin) return reply("❌ Eu preciso ser admin do grupo para essa ação.");
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
        if ((cmd === "kick" || cmd === "ban") && !mentioned[0]) return reply("Marque quem remover.");
        try {
          if (cmd === "kick" || cmd === "ban") {
            await sock.groupParticipantsUpdate(from, [mentioned[0]], "remove");
            return reply(`✅ @${mentioned[0].split("@")[0]} removido.`, [mentioned[0]]);
          }
          if (cmd === "promote") { await sock.groupParticipantsUpdate(from, [mentioned[0]], "promote"); return reply(`⬆️ @${mentioned[0].split("@")[0]} promovido.`, [mentioned[0]]); }
          if (cmd === "demote") { await sock.groupParticipantsUpdate(from, [mentioned[0]], "demote"); return reply(`⬇️ @${mentioned[0].split("@")[0]} demovido.`, [mentioned[0]]); }
          if (cmd === "mentionall") {
            const meta = await sock.groupMetadata(from); const members = meta.participants.map(p => p.id);
            return sock.sendMessage(from, { text: `📣 Mencionando todos:`, mentions: members });
          }
          if (cmd === "close") { await sock.groupSettingUpdate(from, "announcement"); return reply("🔒 Grupo fechado."); }
          if (cmd === "open") { await sock.groupSettingUpdate(from, "not_announcement"); return reply("🔓 Grupo aberto."); }
        } catch (e) { console.error(e); return reply("Erro ao executar ação (verifique permissões)."); }
      }

      // Economy / social
      if (cmd === "coin") { return reply(`💰 @${sender.split("@")[0]} tem ${getCoins(sender)} coins.`, [sender]); }
      if (cmd === "rank") {
        const db = loadDB();
        const arr = Object.entries(db.users || {}).sort((a, b) => (b[1].coins || 0) - (a[1].coins || 0)).slice(0, 15);
        let text = arr.map((it, i) => `${i + 1}. ${it[0].split("@")[0]} — ${it[1].coins} coins`).join("\n") || "Sem dados ainda.";
        if (groupContext) {
          try {
            const meta = await sock.groupMetadata(from);
            const map = new Map(meta.participants.map(p => [p.id, (p.notify || p.id.split("@")[0])]));
            text = arr.map((it, i) => `${i + 1}. ${(map.get(it[0]) || it[0].split("@")[0])} — ${it[1].coins} coins`).join("\n");
          } catch (e) { /* ignore */ }
        }
        return reply(`🏆 Ranking:\n${text}`);
      }
      if (cmd === "daily") {
        const db = loadDB(); ensureUser(sender); const user = db.users[sender]; const now = Date.now();
        if (now - (user.lastDaily || 0) < 24 * 60 * 60 * 1000) return reply("⏳ Você já coletou o daily nas últimas 24h.");
        user.lastDaily = now; user.coins = (user.coins || 0) + 50; saveDB(db);
        return reply("🎉 Você ganhou 50 coins no daily!");
      }
      if (cmd === "pay") {
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || []; const amount = Number(args[2]);
        if (!mentioned[0] || !amount || amount <= 0) return reply("Uso: /pay @user <amount>");
        if (getCoins(sender) < amount) return reply("Saldo insuficiente.");
        addCoins(sender, -amount); addCoins(mentioned[0], amount);
        return reply(`✅ Transferido ${amount} coins para @${mentioned[0].split("@")[0]}`, [mentioned[0]]);
      }
      if (cmd === "steal") {
        if (!groupContext) return reply("Use /steal em grupo marcando o alvo.");
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
        if (!mentioned[0]) return reply("Marque quem quer roubar.");
        const stolen = stealCoins(sender, mentioned[0]);
        const dn = await displayName(sock, from, mentioned[0]);
        return reply(`🏴‍☠️ Você roubou ${stolen} coins de @${dn}!`, [mentioned[0]]);
      }

      // Fun / shop
      if (cmd === "roll") { const r = Math.floor(Math.random() * 6) + 1; return reply(`🎲 Você tirou: ${r}`); }
      if (cmd === "shop") { const db = loadDB(); const items = db.shop.map(it => `${it.id} — ${it.name}: ${it.price} coins`).join("\n"); return reply(`🛒 Loja:\n${items}`); }
      if (cmd === "buy") {
        const itemId = args[1]; if (!itemId) return reply("Uso: /buy <itemid>");
        const db = loadDB(); const item = db.shop.find(i => i.id === itemId);
        if (!item) return reply("Item não encontrado."); if (getCoins(sender) < item.price) return reply("Saldo insuficiente.");
        addCoins(sender, -item.price); return reply(`✅ Você comprou ${item.name} por ${item.price} coins!`);
      }

      // unknown
      return reply("Comando não reconhecido. Use /help");
    } catch (e) {
      console.error("messages.upsert error:", e);
    }
  });

  console.log(`${BOT_NAME} rodando. Aguardando QR para parear...`);
}

start().catch(e => console.error("Erro ao iniciar bot:", e));
        
