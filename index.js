/**
 * Dom Bot V3 - index.js (único arquivo, completo e atualizado)
 * -------------------------------------------------------------
 * Recursos principais:
 * - Dono supremo fixo (OWNER_NUMBER)
 * - Autenticação privada por senha fixa (MASTER_KEY) que adiciona owners persistidos
 * - Admins persistidos (DB)
 * - Welcome / leave / promote / demote messages
 * - Group actions (kick, ban, promote, demote, mentionall, close, open) com checagem completa:
 *     -> Verifica se quem pediu é owner/admin persistido ou admin do grupo
 *     -> Verifica se o BOT é admin quando necessário
 * - /mentionall: se usado em reply, repost (text/media) + menciona todos; se usado com texto, envia texto + mention
 * - Economia: coins por mensagem, /coin, /rank, /daily, /pay, /steal
 * - Steal Supremo: apenas OWNER supremo pode usar para roubar todas as coins (rouba todas)
 * - /sticker: tenta criar GIF RGB animado a partir do texto ou da imagem respondida (usa canvas+gifencoder quando instalados)
 * - /prostituta: função zoeira com ganho aleatório
 * - Anti-flood & cooldown por usuário
 * - DB simples em JSON (database.json)
 *
 * Requisitos / instalação mínima:
 * - Node.js (recomendado LTS)
 * - npm i @whiskeysockets/baileys qrcode-terminal pino
 * - Para sticker animado: npm i canvas gifencoder (e libs nativas no Termux/VPS)
 *
 * Uso:
 * - node index.js
 * - Escaneie QR via WhatsApp -> Dispositivos vinculados -> Vincular aparelho
 *
 * Observações:
 * - Não commite a pasta session/ nem node_modules/
 * - Se sessão der logout: rm -rf session && node index.js (re-escaneie)
 * -------------------------------------------------------------
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
import { exec as execChild } from "child_process";
import util from "util";
const exec = util.promisify(execChild);

// Optional libraries for sticker generation (animated)
let CanvasModule = null;
let GIFEncoder = null;
try {
  // dynamic import for optional libs — will fail gracefully if not installed
  CanvasModule = await import("canvas").catch(() => null);
  GIFEncoder = (await import("gifencoder")).default.catch ? (await import("gifencoder")).default : (await import("gifencoder")).default || null;
} catch (e) {
  CanvasModule = null;
  GIFEncoder = null;
}

// ---------- CONFIG ----------
const OWNER_NUMBER = "5531973272146@s.whatsapp.net"; // dono supremo (fixo)
const BOT_NAME = "Dom Bot V3";
const MASTER_KEY = "DOMSUPREMO123"; // senha fixa (envie em privado para virar owner persistido)
const DB_FILE = "./database.json";
const SESSION_FOLDER = "./session";
const PREFIX = "/";
const COMMAND_COOLDOWN_MS = 3000; // cooldown por comando
const FLOOD_WINDOW_MS = 60 * 1000; // 1 minuto
const FLOOD_WARN_THRESHOLD = 30;
const FLOOD_BLOCK_THRESHOLD = 70;

// ---------- DB helpers ----------
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify({
    owners: [OWNER_NUMBER],
    admins: [], // jids
    users: {},
    shop: [
      { id: "vip", name: "VIP 1 dia", price: 500 },
      { id: "pack", name: "Sticker Pack", price: 150 }
    ]
  }, null, 2));
}
function loadDB() { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

// user helpers
function ensureUser(db, jid) {
  if (!db.users[jid]) {
    db.users[jid] = {
      coins: 50,
      msgs: 0,
      lastDaily: 0,
      prostitutaWins: 0,
      joinedAt: Date.now(),
    };
  }
}

// economy helpers
function addCoinsTo(db, jid, amount) {
  ensureUser(db, jid);
  db.users[jid].coins = (db.users[jid].coins || 0) + Number(amount);
  saveDB(db);
}
function removeCoinsFrom(db, jid, amount) {
  ensureUser(db, jid);
  db.users[jid].coins = Math.max(0, (db.users[jid].coins || 0) - Number(amount));
  saveDB(db);
}

// ---------- util ----------
function sha256(s) { return crypto.createHash("sha256").update(String(s)).digest("hex"); }

// ---------- rate control ----------
const lastCommandAt = new Map(); // jid -> timestamp
const messageCountsWindow = new Map(); // jid -> { start, count }
function isOnCooldown(jid) {
  const last = lastCommandAt.get(jid) || 0;
  if (Date.now() - last < COMMAND_COOLDOWN_MS) return true;
  lastCommandAt.set(jid, Date.now());
  return false;
}
function checkFlood(jid) {
  const now = Date.now();
  let entry = messageCountsWindow.get(jid);
  if (!entry || now - entry.start > FLOOD_WINDOW_MS) {
    entry = { start: now, count: 0 };
  }
  entry.count += 1;
  messageCountsWindow.set(jid, entry);
  if (entry.count > FLOOD_BLOCK_THRESHOLD) return { ok: false, code: "block" };
  if (entry.count > FLOOD_WARN_THRESHOLD) return { ok: false, code: "warn" };
  return { ok: true };
}

// ---------- display name helper ----------
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

// ---------- sticker anim GIF (text) ----------
async function makeAnimatedGifFromText(text) {
  if (!CanvasModule || !GIFEncoder) throw new Error("canvas/gifencoder not installed");
  const { createCanvas } = CanvasModule;
  const width = 512;
  const height = 512;
  const encoder = new GIFEncoder(width, height);
  // We'll write to temp file using node streams
  const tmpFile = `/tmp/dombot_gif_${Date.now()}.gif`;
  // encoder API uses streams; easier approach: use encoder.createReadStream()
  encoder.start();
  encoder.setRepeat(0);
  encoder.setDelay(80);
  encoder.setQuality(10);
  for (let i = 0; i < 30; i++) {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    const r = Math.floor(128 + 127 * Math.sin(i / 5));
    const g = Math.floor(128 + 127 * Math.sin(i / 6 + 2));
    const b = Math.floor(128 + 127 * Math.sin(i / 7 + 4));
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 36px Sans";
    ctx.textAlign = "center";
    ctx.fillText(text.slice(0, 40), width / 2, height / 2);
    encoder.addFrame(ctx);
  }
  encoder.finish();
  // write out stream to tmpFile
  const rs = encoder.createReadStream();
  const ws = fs.createWriteStream(tmpFile);
  await new Promise((res, rej) => {
    rs.pipe(ws);
    ws.on("finish", res);
    ws.on("error", rej);
  });
  const buf = fs.readFileSync(tmpFile);
  fs.unlinkSync(tmpFile);
  return buf;
}

// ---------- download quoted media helper ----------
async function downloadQuotedMedia(sock, quoted) {
  try {
    // quoted is something like msg.message.extendedTextMessage.contextInfo.quotedMessage
    // Baileys downloadMediaMessage expects the full message object.
    // If quoted is present inside contextInfo with key stanzaId and participant, we can reconstruct a minimal message.
    // However it's more reliable to try sock.downloadMediaMessage(quoted, 'buffer', {}) only when quoted contains media.
    const quotedType = Object.keys(quoted)[0];
    if (quotedType === "imageMessage" || quotedType === "videoMessage" || quotedType === "audioMessage" || quotedType === "documentMessage") {
      // quoted[quotedType] is the media object — download works with that
      // But downloadMediaMessage expects a message object in the original format; we try to use the quoted object directly
      const mediaMessage = quoted;
      // Baileys has helper that can accept message object; using sock.downloadMediaMessage may work:
      const buffer = await sock.downloadMediaMessage({ key: { remoteJid: "", id: "", fromMe: false }, message: mediaMessage }, "buffer", {});
      return buffer; // may work; otherwise error will be thrown
    }
  } catch (e) {
    // fallback null
  }
  return null;
}

// ---------- auth handler ----------
async function handleAuthMessage(sock, m) {
  try {
    const sender = m.key.participant || m.key.remoteJid;
    const from = m.key.remoteJid;
    // extract text robustly
    let text = "";
    const mtypes = Object.keys(m.message || {});
    if (mtypes.includes("conversation")) text = m.message.conversation || "";
    else if (mtypes.includes("extendedTextMessage")) text = m.message.extendedTextMessage.text || "";
    text = (text || "").trim();
    if (!text) return;
    // Accept raw password in private chat OR /auth <pwd>
    if ((!from.endsWith("@g.us") && text === MASTER_KEY) || text.startsWith("/auth ")) {
      const used = text.startsWith("/auth ") ? text.split(/\s+/)[1] : text;
      if (used === MASTER_KEY) {
        const db = loadDB();
        if (!db.owners.includes(sender)) {
          db.owners.push(sender);
          saveDB(db);
        }
        await sock.sendMessage(sender, { text: "🔐 Autenticação bem-sucedida — você é owner verificado." });
      } else {
        await sock.sendMessage(sender, { text: "❌ Senha incorreta." });
      }
    }
  } catch (e) {
    console.error("handleAuthMessage error:", e);
  }
}

// ---------- start ----------
async function start() {
  const logger = pino({ level: "silent" });
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 2314, 6] }));
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);
  const sock = makeWASocket({ version, auth: state, printQRInTerminal: false, logger });
  sock.ev.on("creds.update", saveCreds);

  // show QR in terminal
  sock.ev.on("connection.update", (update) => {
    if (update.qr) {
      console.log(`\n📡 ${BOT_NAME} - Escaneie o QR (WhatsApp -> Dispositivos vinculados)`);
      qrcode.generate(update.qr, { small: true });
    }
    if (update.connection === "open") {
      console.log(`✅ ${BOT_NAME} conectado! Owners: ${(loadDB().owners || []).join(", ")}`);
    }
    if (update.connection === "close") {
      const reason = (update.lastDisconnect && update.lastDisconnect.error && update.lastDisconnect.error.output) ?
        update.lastDisconnect.error.output.statusCode : update.lastDisconnect?.error?.message || null;
      console.log("connection closed, reason:", reason);
      if (reason === DisconnectReason.loggedOut) {
        console.log("Sessão desconectada (logged out). Remova 'session/' e re-escaneie o QR.");
      } else {
        // try restart
        setTimeout(() => start().catch(() => {}), 3000);
      }
    }
  });

  // welcome / leave / promote / demote
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
          const txt = `👋 Olá @${p.split("@")[0]}! Seja bem-vindo(a) ao grupo — ${BOT_NAME}\nLeia as regras e se comporte.`;
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
      console.error("group-participants.update error:", e);
    }
  });

  // core messages handler
  sock.ev.on("messages.upsert", async (m) => {
    try {
      const msg = m.messages[0];
      if (!msg || !msg.message) return;
      if (msg.key && msg.key.fromMe) return;

      const from = msg.key.remoteJid;
      const sender = msg.key.participant || msg.key.remoteJid;
      const isGroup = from && from.endsWith("@g.us");

      // Run auth early (so sending password in PV works)
      await handleAuthMessage(sock, msg);

      // Flood control
      const floodRes = checkFlood(sender);
      if (!floodRes.ok) {
        if (floodRes.code === "warn") {
          await sock.sendMessage(from, { text: `⚠️ @${sender.split("@")[0]} — você está enviando muitas mensagens. Diminua o ritmo.`, mentions: [sender] });
        } else {
          return; // block heavy flooding
        }
      }

      // extract text robustly
      const mtypes = Object.keys(msg.message);
      let text = "";
      if (mtypes.includes("conversation")) text = msg.message.conversation || "";
      else if (mtypes.includes("extendedTextMessage")) text = msg.message.extendedTextMessage.text || "";
      else if (mtypes.includes("imageMessage")) text = msg.message.imageMessage.caption || "";
      else if (mtypes.includes("videoMessage")) text = msg.message.videoMessage.caption || "";

      const db = loadDB();
      ensureUser(db, sender);
      db.users[sender].msgs = (db.users[sender].msgs || 0) + 1;
      saveDB(db);

      // only commands start with prefix
      if (!text || !text.startsWith(PREFIX)) return;

      // cooldown
      if (isOnCooldown(sender)) {
        await sock.sendMessage(from, { text: `⏳ @${sender.split("@")[0]} — aguarde alguns segundos entre comandos.`, mentions: [sender] });
        return;
      }

      // parse
      const parts = text.trim().split(/\s+/);
      const cmd = parts[0].slice(PREFIX.length).toLowerCase();
      const args = parts.slice(1);

      // permission checks
      const dbNow = loadDB();
      const owners = dbNow.owners || [];
      const adminsPersisted = dbNow.admins || [];
      const isOwner = owners.includes(sender);
      const isPersistedAdmin = adminsPersisted.includes(sender);

      // group admin detection (fetch metadata)
      let isGroupAdmin = false;
      if (isGroup) {
        try {
          const meta = await sock.groupMetadata(from);
          const part = meta.participants.find(p => p.id === sender);
          if (part && (part.admin || part.isAdmin || part.isSuperAdmin)) isGroupAdmin = true;
        } catch (e) { /* ignore */ }
      }

      const isAuthorized = isOwner || isPersistedAdmin || isGroupAdmin;

      // convenience reply
      const reply = async (txt, mentions = null) => {
        if (mentions) return await sock.sendMessage(from, { text: txt, mentions });
        return await sock.sendMessage(from, { text: txt });
      };

      // handle commands
      // ---------------- HELP/ABOUT ----------------
      if (cmd === "help" || cmd === "about") {
        const info = `🛡️ *${BOT_NAME}*\nDono supremo: ${OWNER_NUMBER}\nOwners verificados: ${(owners || []).map(x => x.split("@")[0]).join(", ")}\n\nComandos:\n` +
          `/mentionall (responda uma mensagem ou escreva texto)\n/kick @user\n/ban @user\n/promote @user\n/demote @user\n/close /open\n/coin /rank /daily /pay @user <amt> /steal @user\n/sticker (responda imagem ou envie texto em privado)\n/prostituta (zoeira)\n\n*Autenticação:* envie a senha em privado: ${MASTER_KEY} ou use /auth <senha> em privado.`;
        return reply(info);
      }

      // ---------------- AUTH (private) ----------------
      if (cmd === "auth") {
        if (isGroup) return reply("Use /auth apenas em conversa privada com o bot.");
        const pass = args[0];
        if (!pass) return reply("Uso: /auth <senha>");
        if (pass === MASTER_KEY) {
          if (!dbNow.owners.includes(sender)) {
            dbNow.owners.push(sender);
            saveDB(dbNow);
          }
          return reply("🔐 Autenticado como owner verificado.");
        } else return reply("❌ Senha incorreta.");
      }

      // ---------------- ADMIN PERSISTED ----------------
      if (cmd === "addadmin") {
        if (!isOwner) return reply("❌ Apenas owners podem adicionar admins persistidos.");
        // support mentioned or replied
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const target = mentioned[0] || (msg.message?.extendedTextMessage?.contextInfo?.participant);
        if (!target) return reply("Marque quem será admin persistente.");
        if (!dbNow.admins.includes(target)) {
          dbNow.admins.push(target);
          saveDB(dbNow);
        }
        return reply(`✅ @${target.split("@")[0]} adicionado como admin persistente.`, [target]);
      }
      if (cmd === "deladmin") {
        if (!isOwner) return reply("❌ Apenas owners podem remover admins persistidos.");
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const target = mentioned[0];
        if (!target) return reply("Marque quem remover.");
        dbNow.admins = (dbNow.admins || []).filter(x => x !== target);
        saveDB(dbNow);
        return reply(`❌ @${target.split("@")[0]} removido dos admins persistidos.`, [target]);
      }

      // ---------------- MENTIONALL ----------------
      if (cmd === "mentionall") {
        if (!isGroup) return reply("Esse comando só funciona em grupos.");
        if (!isAuthorized) return reply("❌ Você não tem permissão.");
        // If replied to a message, try to forward/repost that content to group and mention all
        const ctxInfo = msg.message.extendedTextMessage?.contextInfo || null;
        let textToSend = "";
        let mediaBuffer = null;
        if (ctxInfo && ctxInfo.quotedMessage) {
          const quoted = ctxInfo.quotedMessage;
          // if quoted contains text
          if (quoted.conversation || quoted.extendedTextMessage?.text) {
            textToSend = quoted.conversation || quoted.extendedTextMessage?.text || "";
          } else {
            // attempt to download media
            try {
              mediaBuffer = await sock.downloadMediaMessage({ message: quoted }, "buffer", {});
            } catch (e) {
              mediaBuffer = null;
            }
          }
        } else if (args.length > 0) {
          textToSend = args.join(" ");
        } else {
          textToSend = `📣 @${sender.split("@")[0]} chamou todo mundo!`;
        }
        // get members
        let members = [];
        try {
          const meta = await sock.groupMetadata(from);
          members = meta.participants.map(p => p.id);
        } catch (e) { members = []; }
        // send media or text with mentions
        try {
          if (mediaBuffer) {
            // try to detect mimetype from buffer (simple fallback to image/gif)
            await sock.sendMessage(from, { caption: textToSend || undefined, image: mediaBuffer, mentions: members });
          } else {
            await sock.sendMessage(from, { text: textToSend, mentions: members });
          }
        } catch (e) {
          console.error("mentionall send error", e);
          return reply("Erro ao mencionar todos.");
        }
        return;
      }

      // ---------------- KICK / BAN / PROMOTE / DEMOTE ----------------
      if (["kick", "ban", "promote", "demote"].includes(cmd)) {
        if (!isGroup) return reply("Esse comando só funciona em grupos.");
        if (!isAuthorized) return reply("❌ Você não tem permissão.");
        // ensure bot is admin for actions except mentionall
        if (["kick", "ban", "promote", "demote"].includes(cmd)) {
          let botIsAdmin = false;
          try {
            const meta = await sock.groupMetadata(from);
            const botId = (sock.
