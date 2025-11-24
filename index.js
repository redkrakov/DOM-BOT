/**
 * Dom Bot V4 - Complete single-file index.js
 * - ESM module (package.json must contain: "type": "module")
 * - Dependencies: @whiskeysockets/baileys, qrcode-terminal, pino
 * - Optional (for animated stickers): canvas, gifencoder
 *
 * Usage:
 *   npm i @whiskeysockets/baileys qrcode-terminal pino
 *   # optional: npm i canvas gifencoder
 *   node index.js
 *
 * Keep session/ and node_modules/ in .gitignore
 */

import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import pino from "pino";
import fs from "fs";
import crypto from "crypto";
import util from "util";
import stream from "stream";
const pipeline = util.promisify(stream.pipeline);

// ---------------- CONFIG ----------------
const BOT_NAME = "Dom Bot V4";
const OWNER_NUMBER = "5531973272146@s.whatsapp.net"; // dono supremo
const MASTER_KEY = "DOMSUPREMO123"; // senha fixa (envie em privado para virar owner)
const SESSION_FOLDER = "./session";
const DB_FILE = "./database.json";
const PREFIX = "/";
const COMMAND_COOLDOWN_MS = 3000;
const FLOOD_WINDOW_MS = 60 * 1000;
const FLOOD_WARN_THRESHOLD = 30;
const FLOOD_BLOCK_THRESHOLD = 70;

// ---------------- DB init ----------------
function ensureDB() {
  if (!fs.existsSync(DB_FILE)) {
    const init = {
      owners: [OWNER_NUMBER],
      admins: [], // jids
      users: {}, // jid -> { coins, msgs, lastDaily, prostitutaWins, joinedAt }
      shop: [
        { id: "vip", name: "VIP 1 dia", price: 500 },
        { id: "pack", name: "Sticker Pack", price: 150 },
      ],
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2));
  }
}
ensureDB();
function loadDB() { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

// ---------------- Helpers ----------------
function sha256(s) { return crypto.createHash("sha256").update(String(s)).digest("hex"); }
function ensureUser(db, jid) {
  if (!db.users[jid]) {
    db.users[jid] = { coins: 50, msgs: 0, lastDaily: 0, prostitutaWins: 0, joinedAt: Date.now() };
    saveDB(db);
  }
}

// ---------------- Rate / Flood ----------------
const lastCmd = new Map(); // jid -> timestamp
const msgWindow = new Map(); // jid -> { start, count }
function isCommandCooldown(jid) {
  const last = lastCmd.get(jid) || 0;
  if (Date.now() - last < COMMAND_COOLDOWN_MS) return true;
  lastCmd.set(jid, Date.now());
  return false;
}
function checkFlood(jid) {
  const now = Date.now();
  let entry = msgWindow.get(jid);
  if (!entry || now - entry.start > FLOOD_WINDOW_MS) entry = { start: now, count: 0 };
  entry.count += 1;
  msgWindow.set(jid, entry);
  if (entry.count > FLOOD_BLOCK_THRESHOLD) return { ok: false, code: "block" };
  if (entry.count > FLOOD_WARN_THRESHOLD) return { ok: false, code: "warn" };
  return { ok: true };
}

// ---------------- Optional libs placeholders ----------------
// We'll attempt to import canvas/gifencoder at runtime inside start()
// to avoid top-level await issues.
let Canvas = null;
let GIFEncoder = null;

// ---------------- Utility: friendly name ----------------
async function friendlyName(sock, groupId, jid) {
  try {
    if (groupId && groupId.endsWith("@g.us")) {
      const meta = await sock.groupMetadata(groupId);
      const p = meta.participants.find(x => x.id === jid);
      if (p) return p.notify || p.id.split("@")[0];
    }
  } catch (e) {}
  return jid.split("@")[0];
}

// ---------------- Animated GIF from text (if libs present) ----------------
async function makeAnimatedGifFromText(text) {
  if (!Canvas || !GIFEncoder) throw new Error("canvas/gifencoder not installed");
  const { createCanvas } = Canvas;
  const width = 512;
  const height = 512;
  const encoder = new GIFEncoder(width, height);
  const tmpGif = `/tmp/dombot_text_${Date.now()}.gif`;
  encoder.start();
  encoder.setRepeat(0);
  encoder.setDelay(80);
  encoder.setQuality(10);
  for (let i = 0; i < 30; i++) {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    const r = Math.floor(128 + 127 * Math.sin(i / 6));
    const g = Math.floor(128 + 127 * Math.sin(i / 7 + 2));
    const b = Math.floor(128 + 127 * Math.sin(i / 8 + 4));
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 36px Sans";
    ctx.textAlign = "center";
    ctx.fillText(text.slice(0, 40), width / 2, height / 2);
    encoder.addFrame(ctx);
  }
  encoder.finish();
  // write stream to file and return buffer
  const rs = encoder.createReadStream();
  const ws = fs.createWriteStream(tmpGif);
  await pipeline(rs, ws);
  const buf = fs.readFileSync(tmpGif);
  try { fs.unlinkSync(tmpGif); } catch (e) {}
  return buf;
}

// ---------------- Download quoted media helper ----------------
async function downloadQuotedMediaSafely(sock, msg) {
  try {
    const ctx = msg.message.extendedTextMessage?.contextInfo;
    if (!ctx || !ctx.quotedMessage) return null;
    const quoted = ctx.quotedMessage;
    // Try to download via Baileys helper using original context
    // We need to reconstruct the "message" object expected by downloadMediaMessage
    // Simpler approach: use sock.downloadMediaMessage with the quoted message object.
    const buffer = await sock.downloadMediaMessage({ message: quoted }, "buffer", {});
    return buffer;
  } catch (e) {
    return null;
  }
}

// ---------------- AUTH message handler ----------------
async function handleAuthMessage(sock, msg) {
  try {
    const sender = msg.key.participant || msg.key.remoteJid;
    const from = msg.key.remoteJid;
    let text = "";
    const types = Object.keys(msg.message || {});
    if (types.includes("conversation")) text = msg.message.conversation || "";
    else if (types.includes("extendedTextMessage")) text = msg.message.extendedTextMessage.text || "";
    text = (text || "").trim();
    if (!text) return;
    if ((!from.endsWith("@g.us") && text === MASTER_KEY) || text.startsWith("/auth ")) {
      const used = text.startsWith("/auth ") ? text.split(/\s+/)[1] : text;
      const db = loadDB();
      if (used === MASTER_KEY) {
        if (!db.owners.includes(sender)) {
          db.owners.push(sender);
          saveDB(db);
        }
        await sock.sendMessage(sender, { text: "🔐 Autenticação bem-sucedida — você agora é owner verificado." });
      } else {
        await sock.sendMessage(sender, { text: "❌ Senha incorreta." });
      }
    }
  } catch (e) {
    console.error("handleAuthMessage error:", e);
  }
}

// ---------------- START BOT ----------------
async function start() {
  // attempt optional imports (canvas/gifencoder) here to avoid top-level await
  try {
    Canvas = await import("canvas").then(m => m);
  } catch (e) { Canvas = null; }
  try {
    GIFEncoder = await import("gifencoder").then(m => m.default || m);
  } catch (e) { GIFEncoder = null; }

  const logger = pino({ level: "silent" });
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 2314, 6] }));
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);
  const sock = makeWASocket({ auth: state, version, logger, printQRInTerminal: false });

  sock.ev.on("creds.update", saveCreds);

  // show QR
  sock.ev.on("connection.update", (upd) => {
    if (upd.qr) {
      console.log(`\n📡 ${BOT_NAME} - Escaneie o QR (WhatsApp -> Dispositivos vinculados)`);
      qrcode.generate(upd.qr, { small: true });
    }
    if (upd.connection === "open") {
      console.log(`✅ ${BOT_NAME} conectado. Owners: ${(loadDB().owners || []).join(", ")}`);
    }
    if (upd.connection === "close") {
      const reason = (upd.lastDisconnect && upd.lastDisconnect.error && upd.lastDisconnect.error.output) ?
        upd.lastDisconnect.error.output.statusCode : upd.lastDisconnect?.error?.message || null;
      console.log("connection closed, reason:", reason);
      if (reason === DisconnectReason.loggedOut) {
        console.log("Sessão desconectada (logged out). Remova 'session/' e re-escaneie o QR.");
      } else {
        setTimeout(() => start().catch(() => {}), 3000);
      }
    }
  });

  // welcome, leave, promote, demote
  sock.ev.on("group-participants.update", async (update) => {
    try {
      const groupId = update.id;
      const action = update.action;
      const participants = update.participants || [];
      const actor = update.actor || update.author || null;
      for (const p of participants) {
        const db = loadDB();
        ensureUser(db, p);
        if (action === "add") {
          const txt = `👋 Olá @${p.split("@")[0]}! Seja bem-vindo(a) — ${BOT_NAME}\nLeia as regras e se comporte.`;
          await sock.sendMessage(groupId, { text: txt, mentions: [p] });
        } else if (action === "remove") {
          if (actor && actor !== p) {
            const txt = `🚨 @${p.split("@")[0]} foi removido(a) do grupo por @${actor.split("@")[0]}.`;
            await sock.sendMessage(groupId, { text: txt, mentions: [p, actor] });
          } else {
            const txt = `👋 @${p.split("@")[0]} saiu do grupo. Até a próxima!`;
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

  // main message handler
  sock.ev.on("messages.upsert", async (m) => {
    try {
      const msg = m.messages[0];
      if (!msg || !msg.message) return;
      if (msg.key && msg.key.fromMe) return;

      const from = msg.key.remoteJid;
      const sender = msg.key.participant || msg.key.remoteJid;
      const isGroup = from && from.endsWith("@g.us");

      // early auth
      await handleAuthMessage(sock, msg);

      // flood control
      const flood = checkFlood(sender);
      if (!flood.ok) {
        if (flood.code === "warn") {
          await sock.sendMessage(from, { text: `⚠️ @${sender.split("@")[0]} — você está enviando muitas mensagens. Diminua o ritmo.`, mentions: [sender] });
        } else {
          return;
        }
      }

      // extract text
      const types = Object.keys(msg.message);
      let text = "";
      if (types.includes("conversation")) text = msg.message.conversation || "";
      else if (types.includes("extendedTextMessage")) text = msg.message.extendedTextMessage.text || "";
      else if (types.includes("imageMessage")) text = msg.message.imageMessage.caption || "";
      else if (types.includes("videoMessage")) text = msg.message.videoMessage.caption || "";

      const dbNow = loadDB();
      ensureUser(dbNow, sender);
      dbNow.users[sender].msgs = (dbNow.users[sender].msgs || 0) + 1;
      saveDB(dbNow);

      // only process commands starting with PREFIX
      if (!text || !text.startsWith(PREFIX)) return;

      // cooldown per user
      if (isCommandCooldown(sender)) {
        await sock.sendMessage(from, { text: `⏳ @${sender.split("@")[0]} — espere ${COMMAND_COOLDOWN_MS/1000}s entre comandos.`, mentions: [sender] });
        return;
      }

      const parts = text.trim().split(/\s+/);
      const cmd = parts[0].slice(PREFIX.length).toLowerCase();
      const args = parts.slice(1);

      // permission checks
      const dbThen = loadDB();
      const owners = dbThen.owners || [];
      const persistedAdmins = dbThen.admins || [];
      const isOwner = owners.includes(sender);
      const isPersistedAdmin = persistedAdmins.includes(sender);

      // group admin detection
      let isGroupAdmin = false;
      if (isGroup) {
        try {
          const meta = await sock.groupMetadata(from);
          const p = meta.participants.find(x => x.id === sender);
          if (p && (p.admin || p.isAdmin || p.isSuperAdmin)) isGroupAdmin = true;
        } catch (e) {}
      }

      const isAuthorized = isOwner || isPersistedAdmin || isGroupAdmin;

      // reply helper
      const reply = async (txt, mentions = null) => {
        if (mentions) return await sock.sendMessage(from, { text: txt, mentions });
        return await sock.sendMessage(from, { text: txt });
      };

      // ---------- HELP ----------
      if (cmd === "help" || cmd === "about") {
        const info = `🛡️ *${BOT_NAME}*\nDono supremo: ${OWNER_NUMBER}\nOwners verificados: ${(owners || []).map(x => x.split("@")[0]).join(", ")}\n\nComandos:\n` +
          `/auth <senha> (privado) — autentica como owner\n/mentionall (responda ou escreva texto) — menciona todo mundo\n/kick @user /ban @user /promote @user /demote @user\n/close /open\n/coin /rank /daily /pay @user <amt> /steal @user\n/sticker (responda imagem OU /sticker <texto>)\n/prostituta\n\n*Senha owner (privada):* ${MASTER_KEY}`;
        return reply(info);
      }

      // ---------- AUTH (private) ----------
      if (cmd === "auth") {
        if (isGroup) return reply("Use /auth apenas em conversa privada com o bot.");
        const pass = args[0];
        if (!pass) return reply("Uso: /auth <senha>");
        if (pass === MASTER_KEY) {
          if (!dbThen.owners.includes(sender)) { dbThen.owners.push(sender); saveDB(dbThen); }
          return reply("🔐 Autenticado como owner verificado.");
        } else return reply("❌ Senha incorreta.");
      }

      // ---------- ADMIN PERSISTED ----------
      if (cmd === "addadmin") {
        if (!isOwner) return reply("❌ Apenas owners podem adicionar admins persistidos.");
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const target = mentioned[0] || msg.message.extendedTextMessage?.contextInfo?.participant;
        if (!target) return reply("Marque quem será admin persistente.");
        if (!dbThen.admins.includes(target)) { dbThen.admins.push(target); saveDB(dbThen); }
        return reply(`✅ @${target.split("@")[0]} adicionado como admin persistente.`, [target]);
      }
      if (cmd === "deladmin") {
        if (!isOwner) return reply("❌ Apenas owners podem remover admins persistidos.");
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const target = mentioned[0];
        if (!target) return reply("Marque quem remover.");
        dbThen.admins = (dbThen.admins || []).filter(x => x !== target); saveDB(dbThen);
        return reply(`❌ @${target.split("@")[0]} removido dos admins persistidos.`, [target]);
      }

      // ---------- MENTIONALL ----------
      if (cmd === "mentionall") {
        if (!isGroup) return reply("Esse comando só funciona em grupos.");
        if (!isAuthorized) return reply("❌ Você não tem permissão.");
        const ctx = msg.message.extendedTextMessage?.contextInfo || null;
        let textToSend = "";
        let mediaBuffer = null;
        if (ctx && ctx.quotedMessage) {
          const quoted = ctx.quotedMessage;
          if (quoted.conversation || quoted.extendedTextMessage?.text) {
            textToSend = quoted.conversation || quoted.extendedTextMessage?.text || "";
          } else {
            mediaBuffer = await downloadQuotedMediaSafely(sock, msg);
          }
        } else if (args.length > 0) {
          textToSend = args.join(" ");
        } else {
          textToSend = `📣 @${(await friendlyName(sock, from, sender))} chamou todo mundo!`;
        }
        let members = [];
        try { const meta = await sock.groupMetadata(from); members = meta.participants.map(p => p.id); } catch (e) {}
        try {
          if (mediaBuffer) {
            await sock.sendMessage(from, { caption: textToSend || undefined, image: mediaBuffer, mentions: members });
          } else {
            await sock.sendMessage(from, { text: textToSend, mentions: members });
          }
        } catch (e) {
          console.error("mentionall error", e);
          return reply("Erro ao mencionar todos.");
        }
        return;
      }

      // ---------- KICK / BAN / PROMOTE / DEMOTE ----------
      if (["kick", "ban", "promote", "demote"].includes(cmd)) {
        if (!isGroup) return reply("Esse comando só funciona em grupos.");
        if (!isAuthorized) return reply("❌ Você não tem permissão.");
        // check bot is admin
        let botAdmin = false;
        try {
          const meta = await sock.groupMetadata(from);
          const botId = (sock.user && sock.user.id) ? sock.user.id : null;
          const botPart = meta.participants.find(p => p.id === botId);
          botAdmin = !!(botPart && (botPart.admin || botPart.isAdmin || botPart.isSuperAdmin));
        } catch (e) { botAdmin = false; }
        if (!botAdmin) return reply("❌ Eu preciso ser admin do grupo para executar essa ação. Promova o bot.");
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const target = mentioned[0] || msg.message.extendedTextMessage?.contextInfo?.participant;
        if (!target) return reply("Marque ou responda a mensagem da pessoa alvo.");
        try {
          if (cmd === "kick" || cmd === "ban") {
            await sock.groupParticipantsUpdate(from, [target], "remove");
            return reply(`✅ @${target.split("@")[0]} removido.`, [target]);
          } else if (cmd === "promote") {
            await sock.groupParticipantsUpdate(from, [target], "promote");
            return reply(`⬆️ @${target.split("@")[0]} promovido.`, [target]);
          } else if (cmd === "demote") {
            await sock.groupParticipantsUpdate(from, [target], "demote");
            return reply(`⬇️ @${target.split("@")[0]} demovido.`, [target]);
          }
        } catch (e) {
          console.error("group action error", e);
          return reply("Erro ao executar ação (verifique permissões).");
        }
      }

      // ---------- CLOSE / OPEN ----------
      if (cmd === "close" || cmd === "open") {
        if (!isGroup) return reply("Esse comando só funciona em grupos.");
        if (!isAuthorized) return reply("❌ Você não tem permissão.");
        // ensure bot is admin
        let botAdmin = false;
        try {
          const meta = await sock.groupMetadata(from);
          const botId = (sock.user && sock.user.id) ? sock.user.id : null;
          const botPart = meta.participants.find(p => p.id === botId);
          botAdmin = !!(botPart && (botPart.admin || botPart.isAdmin || botPart.isSuperAdmin));
        } catch (e) {}
        if (!botAdmin) return reply("❌ Eu preciso ser admin do grupo para mudar configurações.");
        try {
          if (cmd === "close") {
            await sock.groupSettingUpdate(from, "announcement");
            return reply("🔒 Grupo fechado (somente admins podem enviar mensagens).");
          } else {
            await sock.groupSettingUpdate(from, "not_announcement");
            return reply("🔓 Grupo aberto (todos podem enviar mensagens).");
          }
        } catch (e) {
          console.error("group setting error", e);
          return reply("Erro ao alterar configuração do grupo.");
        }
      }

      // ---------- ECONOMY ----------
      if (cmd === "coin") {
        const dbNow2 = loadDB(); ensureUser(dbNow2, sender);
        return reply(`💰 @${sender.split("@")[0]} tem ${dbNow2.users[sender].coins} coins.`, [sender]);
      }

      if (cmd === "rank") {
        const dbNow2 = loadDB();
        const arr = Object.entries(dbNow2.users || {}).sort((a,b)=> (b[1].coins||0)-(a[1].coins||0)).slice(0,15);
        let textRank = arr.map((it,i)=> `${i+1}. ${it[0].split("@")[0]} — ${it[1].coins} coins`).join("\n") || "Sem dados ainda.";
        if (isGroup) {
          try {
            const meta = await sock.groupMetadata(from);
            const map = new Map(meta.participants.map(p=>[p.id, (p.notify||p.id.split("@")[0])]));
            textRank = arr.map((it,i)=> `${i+1}. ${(map.get(it[0])||it[0].split("@")[0])} — ${it[1].coins} coins`).join("\n");
          } catch (e) {}
        }
        return reply(`🏆 Ranking:\n${textRank}`);
      }

      if (cmd === "daily") {
        const dbNow2 = loadDB();
        ensureUser(dbNow2, sender);
        const now = Date.now();
        if (now - (dbNow2.users[sender].lastDaily || 0) < 24*60*60*1000) return reply("⏳ Você já coletou o daily nas últimas 24h.");
        dbNow2.users[sender].lastDaily = now;
        dbNow2.users[sender].coins = (dbNow2.users[sender].coins || 0) + 50;
        saveDB(dbNow2);
        return reply("🎉 Você ganhou 50 coins no daily!");
      }

      if (cmd === "pay") {
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const amount = Number(args[1]) || 0;
        if (!mentioned[0] || amount <= 0) return reply("Uso: /pay @user <amount>");
        const dbNow2 = loadDB(); ensureUser(dbNow2, sender); ensureUser(dbNow2, mentioned[0]);
        if (dbNow2.users[sender].coins < amount) return reply("Saldo insuficiente.");
        dbNow2.users[sender].coins -= amount;
        dbNow2.users[mentioned[0]].coins = (dbNow2.users[mentioned[0]].coins || 0) + amount;
        saveDB(dbNow2);
        return reply(`✅ Transferido ${amount} coins para @${mentioned[0].split("@")[0]}`, [mentioned[0]]);
      }

      if (cmd === "steal") {
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
        if (!mentioned[0]) return reply("Marque alguém para roubar.");
        const target = mentioned[0];
        const dbNow2 = loadDB(); ensureUser(dbNow2, target); ensureUser(dbNow2, sender);
        if (sender === OWNER_NUMBER) {
          // Steal Supremo
          const amt = dbNow2.users[target].coins || 0;
          dbNow2.users[target].coins = 0;
          dbNow2.users[sender].coins = (dbNow2.users[sender].coins || 0) + amt;
          saveDB(dbNow2);
          return reply(`💀 *STEAL SUPREMO!* Você roubou TODAS as coins de @${target.split("@")[0]} (total: ${amt}).`, [target]);
        } else {
          const stealAmt = Math.floor(Math.random()*50)+1;
          const actual = Math.min(stealAmt, dbNow2.users[target].coins || 0);
          dbNow2.users[target].coins = (dbNow2.users[target].coins || 0) - actual;
          dbNow2.users[sender].coins = (dbNow2.users[sender].coins || 0) + actual;
          saveDB(dbNow2);
          return reply(`🏴‍☠️ Você roubou ${actual} coins de @${target.split("@")[0]}!`, [target]);
        }
      }

      // ---------- STICKER ----------
      if (cmd === "sticker") {
        try {
          const ctx = msg.message.extendedTextMessage?.contextInfo || null;
          let generated = null;
          if (ctx && ctx.quotedMessage) {
            const buf = await downloadQuotedMediaSafely(sock, msg);
            if (!buf) return reply("Erro ao baixar mídia citada para criar figurinha.");
            if (Canvas && GIFEncoder) {
              const tmpFile = `/tmp/dombot_img_${Date.now()}.png`;
              fs.writeFileSync(tmpFile, buf);
              const { createCanvas, loadImage } = Canvas;
              const img = await loadImage(tmpFile);
              const w = 512, h = 512;
              const encoder = new GIFEncoder(w, h);
              const tmpGif = `/tmp/dombot_gif_${Date.now()}.gif`;
              encoder.start(); encoder.setRepeat(0); encoder.setDelay(80); encoder.setQuality(10);
              for (let i=0;i<20;i++) {
                const canvas = createCanvas(w,h);
                const ctx2 = canvas.getContext("2d");
                ctx2.drawImage(img,0,0,w,h);
                ctx2.fillStyle = `rgba(${Math.floor(128+127*Math.sin(i/3))},${Math.floor(128+127*Math.sin(i/4))},${Math.floor(128+127*Math.sin(i/5))},0.25)`;
                ctx2.fillRect(0,0,w,h);
                ctx2.fillStyle = "#fff";
                ctx2.font = "bold 28px Sans";
                ctx2.textAlign = "center";
                const cap = (ctx.quotedMessage?.caption || "").slice(0,40) || "";
                ctx2.fillText(cap, w/2, h-40);
                encoder.addFrame(ctx2);
              }
              encoder.finish();
              const rs = encoder.createReadStream(); 
              const ws = fs.createWriteStream(tmpGif);
              await pipeline(rs, ws);
              generated = fs.readFileSync(tmpGif);
              try { fs.unlinkSync(tmpFile); fs.unlinkSync(tmpGif); } catch(e){}
            } else {
              generated = buf;
            }
          } else if (args.length > 0) {
            const textArg = args.join(" ");
            if (Canvas && GIFEncoder) generated = await makeAnimatedGifFromText(textArg);
            else return reply("A função /sticker animado requer libs (canvas, gifencoder). Instale: npm i canvas gifencoder");
          } else {
            return reply("Uso: responda uma imagem com /sticker ou envie /sticker <texto>");
          }
          if (generated) {
            await sock.sendMessage(from, { video: generated, mimetype: "image/gif", fileName: "sticker.gif" }, { quoted: msg });
            return;
          }
        } catch (e) {
          console.error("sticker error", e);
          return reply("Erro ao gerar figurinha. Veja logs do servidor.");
        }
      }

      // ---------- PROSTITUTA ----------
      if (cmd === "prostituta") {
        const gain = Math.floor(Math.random()*500)+50;
        dbNow.users[sender].prostitutaWins = (dbNow.users[sender].prostitutaWins||0)+1;
        dbNow.users[sender].coins = (dbNow.users[sender].coins||0)+gain;
        saveDB(dbNow);
        return reply(`💋 Você trabalhou e ganhou ${gain} coins! Total serviços: ${dbNow.users[sender].prostitutaWins}`);
      }

      // ---------- default ----------
      return reply("Comando não reconhecido. Use /help para ver a lista.");
    } catch (e) {
      console.error("messages.upsert error:", e);
    }
  });

  console.log(`${BOT_NAME} rodando. Aguardando QR para parear...`);
}

// start
start().catch(e => console.error("start error:", e));
