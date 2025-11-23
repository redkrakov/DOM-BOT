/**
 * Dom Bot V1
 * index.js - Single-file bot using Baileys
 * Owner (supremo): 5531973272146@s.whatsapp.net
 *
 * Observações:
 * - Session salva em ./session (NUNCA comitar essa pasta).
 * - DB em database.json
 */

import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import pino from "pino";
import fs from "fs";

const OWNER_NUMBER = "5531973272146@s.whatsapp.net"; // dono supremo
const BOT_NAME = "Dom Bot V1";
const SESSION_FOLDER = "./session";
const DB_FILE = "database.json";
const PREFIX = "/";

// --- DB init ---
if (!fs.existsSync(DB_FILE)) {
  const initial = { users: {}, admins: [] };
  fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
}
function loadDB(){ return JSON.parse(fs.readFileSync(DB_FILE)); }
function saveDB(db){ fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

// --- Helpers: economy & admins ---
function ensureUser(jid){
  const db = loadDB();
  if (!db.users[jid]) {
    db.users[jid] = { coins:0, msgs:0, lastDaily:0, joinedAt: Date.now() };
    saveDB(db);
  }
}
function addMsg(jid){
  const db = loadDB(); ensureUser(jid);
  db.users[jid].msgs = (db.users[jid].msgs||0)+1;
  db.users[jid].coins = (db.users[jid].coins||0)+1;
  saveDB(db);
}
function addCoins(jid, amount){
  const db = loadDB(); ensureUser(jid);
  db.users[jid].coins = (db.users[jid].coins||0) + Number(amount);
  saveDB(db);
}
function getCoins(jid){ const db = loadDB(); ensureUser(jid); return db.users[jid].coins||0; }
function stealCoins(fromJid, toJid){
  const db = loadDB(); ensureUser(fromJid); ensureUser(toJid);
  let amount = Math.floor(Math.random()*30)+1;
  if (db.users[toJid].coins < amount) amount = db.users[toJid].coins;
  db.users[toJid].coins -= amount;
  db.users[fromJid].coins += amount;
  saveDB(db);
  return amount;
}
function addAdminToDB(jid){ const db=loadDB(); if(!db.admins.includes(jid)){ db.admins.push(jid); saveDB(db);} }
function delAdminFromDB(jid){ const db=loadDB(); db.admins = db.admins.filter(a=>a!==jid); saveDB(db); }
function listAdminsFromDB(){ return loadDB().admins||[]; }

// --- Start bot ---
async function start(){
  const logger = pino({ level: "silent" });
  const { version } = await fetchLatestBaileysVersion().catch(()=>({version:[2,2314,6]}));
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);

  const sock = makeWASocket({ version, auth: state, printQRInTerminal: false, logger });

  sock.ev.on("connection.update", (upd) => {
    if (upd.qr) {
      console.log(`\n📡 ${BOT_NAME} - Escaneie o QR (WhatsApp -> Dispositivos vinculados)`); qrcode.generate(upd.qr,{small:true});
    }
    if (upd.connection === "open") console.log(`✅ ${BOT_NAME} conectado!`);
    if (upd.connection === "close") {
      const reason = (upd.lastDisconnect && upd.lastDisconnect.error && upd.lastDisconnect.error.output) ?
        upd.lastDisconnect.error.output.statusCode : null;
      console.log("connection closed, reason:", reason);
      if (reason === DisconnectReason.loggedOut) {
        console.log("Sessão desconectada (logged out). Remova a pasta session e re-escaneie.");
      } else {
        // tenta reconectar
        start().catch(()=>{});
      }
    }
  });
  sock.ev.on("creds.update", saveCreds);

  const isGroup = (jid) => jid && jid.endsWith("@g.us");
  async function isGroupAdmin(groupId, jid){
    try {
      const meta = await sock.groupMetadata(groupId);
      const p = meta.participants.find(x=>x.id===jid);
      return !!(p && (p.admin||p.isAdmin||p.isSuperAdmin));
    } catch(e){ return false; }
  }
  async function isBotAdmin(groupId){
    const botJid = sock.user && sock.user.id ? sock.user.id : null;
    return botJid ? await isGroupAdmin(groupId, botJid) : false;
  }
  async function isAuthorizedAdmin(groupId, senderJid){
    if (senderJid === OWNER_NUMBER) return true;
    const dbAdmins = listAdminsFromDB();
    if (dbAdmins.includes(senderJid)) return true;
    const groupAdm = await isGroupAdmin(groupId, senderJid);
    if (groupAdm) return true;
    return false;
  }

  // ========== group participant events (welcome/leave/promote/demote) ==========
  sock.ev.on("group-participants.update", async update => {
    try {
      const groupId = update.id, action = update.action, participants = update.participants||[], actor = update.actor||update.author;
      for (const p of participants){
        ensureUser(p);
        if (action === "add"){
          const text = `👋 Olá @${p.split("@")[0]}! Seja bem-vindo(a) — ${BOT_NAME}\nLeia as regras e respeite o grupo.`;
          await sock.sendMessage(groupId, { text, mentions: [p] });
        } else if (action === "remove"){
          if (actor && actor !== p){
            const text = `🚨 @${p.split("@")[0]} foi *removido(a)* pelo @${actor.split("@")[0]}.`;
            await sock.sendMessage(groupId, { text, mentions: [p, actor] });
          } else {
            const text = `👋 @${p.split("@")[0]} saiu do grupo. Até mais!`;
            await sock.sendMessage(groupId, { text, mentions: [p] });
          }
        } else if (action === "promote"){
          const text = `⬆️ @${p.split("@")[0]} foi promovido(a) a admin.`;
          await sock.sendMessage(groupId, { text, mentions: [p] });
        } else if (action === "demote"){
          const text = `⬇️ @${p.split("@")[0]} deixou de ser admin.`;
          await sock.sendMessage(groupId, { text, mentions: [p] });
        }
      }
    } catch(e){ console.error("group-participants.update error:", e); }
  });

  // ========== messages.upsert (commands + economy) ==========
  sock.ev.on("messages.upsert", async m => {
    try {
      const msg = m.messages[0]; if (!msg || !msg.message) return; if (msg.key && msg.key.fromMe) return;

      const from = msg.key.remoteJid; const sender = msg.key.participant || msg.key.remoteJid;
      const type = Object.keys(msg.message)[0];
      let text = "";
      if (type === "conversation") text = msg.message.conversation||"";
      else if (type === "extendedTextMessage") text = msg.message.extendedTextMessage.text||"";
      else return;

      ensureUser(sender); addMsg(sender);
      if (!text.startsWith(PREFIX)) return;

      const args = text.trim().split(/\s+/); const cmd = args[0].slice(PREFIX.length).toLowerCase();
      const isOwner = sender === OWNER_NUMBER; const dbAdmins = listAdminsFromDB();
      const isDBAdmin = dbAdmins.includes(sender); const groupContext = isGroup(from);
      const authorized = groupContext ? await isAuthorizedAdmin(from, sender) : (isOwner||isDBAdmin);
      const reply = async (txt, mentions) => { if (mentions) await sock.sendMessage(from, { text: txt, mentions }); else await sock.sendMessage(from, { text: txt }); };

      // help
      if (cmd === "help") return reply(`Comandos: /help /coin /rank /daily /steal @user\nAdmins: /kick /ban /promote /demote /mentionall /close /open\nOwner: /addadmin /deladmin /give /gift`);

      // owner-only
      if (cmd === "addadmin" && isOwner){
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
        if (!mentioned || !mentioned[0]) return reply("Marque quem será admin.");
        addAdminToDB(mentioned[0]); return reply(`✅ ${mentioned[0]} agora é admin.`, [mentioned[0]]);
      }
      if (cmd === "deladmin" && isOwner){
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
        if (!mentioned || !mentioned[0]) return reply("Marque quem remover dos admins.");
        delAdminFromDB(mentioned[0]); return reply(`❌ ${mentioned[0]} removido dos admins.`, [mentioned[0]]);
      }
      if (cmd === "give"){
        if (!isOwner) return reply("❌ Apenas o dono pode usar /give.");
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid; const amount = Number(args[2]);
        if (!mentioned || !amount || amount<=0) return reply("Uso: /give @user 100");
        addCoins(mentioned[0], amount); return reply(`🎁 Dono deu ${amount} coins para @${mentioned[0].split("@")[0]}`, [mentioned[0]]);
      }
      if (cmd === "gift"){
        if (!isOwner) return reply("❌ Apenas o dono pode usar /gift.");
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid; if (!mentioned || !mentioned[0]) return reply("Marque alguém.");
        addCoins(mentioned[0], 100); return reply(`🎁 @${mentioned[0].split("@")[0]} recebeu 100 coins!`, [mentioned[0]]);
      }

      // group admin commands
      if (["kick","ban","promote","demote","mentionall","close","open"].includes(cmd)){
        if (!groupContext) return reply("Esse comando só funciona em grupo.");
        if (!authorized) return reply("❌ Você não tem permissão.");
        const botIsAdmin = await isBotAdmin(from);
        if ((cmd==="kick"||cmd==="ban"||cmd==="promote"||cmd==="demote"||cmd==="close"||cmd==="open") && !botIsAdmin) return reply("❌ Eu preciso ser admin do grupo.");
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];

        if (cmd==="kick"||cmd==="ban"){
          if (!mentioned[0]) return reply("Marque quem remover.");
          try { await sock.groupParticipantsUpdate(from, [mentioned[0]], "remove"); return reply(`✅ @${mentioned[0].split("@")[0]} removido.`, [mentioned[0]]); }
          catch(e){ console.error(e); return reply("Erro ao remover."); }
        }
        if (cmd==="promote"){
          if (!mentioned[0]) return reply("Marque quem promover.");
          try{ await sock.groupParticipantsUpdate(from, [mentioned[0]], "promote"); return reply(`⬆️ @${mentioned[0].split("@")[0]} promovido.`, [mentioned[0]]); }
          catch(e){ return reply("Erro ao promover."); }
        }
        if (cmd==="demote"){
          if (!mentioned[0]) return reply("Marque quem demover.");
          try{ await sock.groupParticipantsUpdate(from, [mentioned[0]], "demote"); return reply(`⬇️ @${mentioned[0].split("@")[0]} demovido.`, [mentioned[0]]); }
          catch(e){ return reply("Erro ao demover."); }
        }
        if (cmd==="mentionall"){
          const meta = await sock.groupMetadata(from); const members = meta.participants.map(p=>p.id);
          return sock.sendMessage(from, { text: `📣 Mencionando todos:`, mentions: members });
        }
        if (cmd==="close"){
          try{ await sock.groupSettingUpdate(from, "announcement"); return reply("🔒 Grupo fechado."); } catch(e){ return reply("Erro ao fechar grupo."); }
        }
        if (cmd==="open"){
          try{ await sock.groupSettingUpdate(from, "not_announcement"); return reply("🔓 Grupo aberto."); } catch(e){ return reply("Erro ao abrir grupo."); }
        }
      }

      // economy & common
      if (cmd==="coin"){ return reply(`💰 @${sender.split("@")[0]} tem ${getCoins(sender)} coins.`, [sender]); }
      if (cmd==="rank"){
        const db = loadDB(); const arr = Object.entries(db.users||{}).sort((a,b)=>(b[1].coins||0)-(a[1].coins||0)).slice(0,15);
        const text = arr.map((it,i)=>`${i+1}. @${it[0].split("@")[0]} — ${it[1].coins} coins`).join("\n") || "Sem dados ainda.";
        return reply(`🏆 Ranking:\n${text}`);
      }
      if (cmd==="daily"){
        const db = loadDB(); ensureUser(sender); const user = db.users[sender]; const now = Date.now();
        if (now - (user.lastDaily||0) < 24*60*60*1000) return reply("⏳ Você já coletou o daily nas últimas 24h.");
        user.lastDaily = now; user.coins = (user.coins||0)+50; saveDB(db); return reply("🎉 Você ganhou 50 coins no daily!");
      }
      if (cmd==="steal"){
        if (!isGroup(from)) return reply("Use /steal em grupos marcando o alvo.");
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || []; if (!mentioned[0]) return reply("Marque quem quer roubar.");
        const stolen = stealCoins(sender, mentioned[0]); return reply(`🏴‍☠️ Você roubou ${stolen} coins de @${mentioned[0].split("@")[0]}!`, [mentioned[0]]);
      }

      // default
      return reply("Comando não reconhecido. Use /help");
    } catch(e){ console.error("messages.upsert error:", e); }
  });

  console.log(`${BOT_NAME} rodando. Aguardando QR para parear...`);
}

start().catch(e => console.error("Erro ao iniciar bot:", e));
