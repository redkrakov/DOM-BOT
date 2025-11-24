/**
 * Dom Bot V1 - v2
 * Melhorias:
 *  - Autenticação por senha via DM (/auth <senha>) — torna o usuário um owner verificado
 *  - Comandos owner/admin funcionam tanto em grupo quanto em privado (autorização por DB + permissões de grupo)
 *  - Rank exibe nomes simples (quando possível) fazendo fallback para o username do JID
 *  - Cooldown por usuário para comandos (evita flood e possivel bloqueio)
 *  - Anti-flood simples (mensagens por minuto por usuário) com avisos
 *  - Novos comandos de diversão: /roll, /pay, /shop, /buy, /about
 *  - Mensagens de boas-vindas/saída/promote/demote detalhadas
 *  - Apresentação (comando /about)
 *
 * Requisitos: Node.js (recomendado LTS), Termux ou VPS, dependências no package.json
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

const OWNER_NUMBER = "5531973272146@s.whatsapp.net"; // número principal fixo (DDI + número sem +)
const BOT_NAME = "Dom Bot V1";
const SESSION_FOLDER = "./session";
const DB_FILE = "database.json";
const PREFIX = "/";

// ---------- DB init ----------
if (!fs.existsSync(DB_FILE)) {
  const initial = {
    users: {},        // { "jid": { coins,msgs,lastDaily,joinedAt } }
    admins: [],       // jids de admins persistidos
    owners: [OWNER_NUMBER], // donos verificados (pode aumentar via /auth)
    ownerHash: null,  // hash da senha (sha256) definida via /setpass pelo OWNER_NUMBER
    shop: [           // itens simples de exemplo
      { id: "vip", name: "VIP 1 dia", price: 500 },
      { id: "stickerpack", name: "Sticker Pack", price: 150 }
    ]
  };
  fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
}
function loadDB(){ return JSON.parse(fs.readFileSync(DB_FILE)); }
function saveDB(db){ fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

// ---------- Helpers: economy & admins ----------
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
  db.users[jid].coins = (db.users[jid].coins||0)+1; // +1 coin por msg
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
function listOwnersFromDB(){ return loadDB().owners||[]; }
function setOwnerHash(hash){ const db=loadDB(); db.ownerHash = hash; saveDB(db); }

// ---------- In-memory rate control ----------
const commandCooldowns = new Map(); // jid -> timestamp ms of last command
const MESSAGE_WINDOW = 60 * 1000; // 1 minuto
const messageCounts = new Map(); // jid -> { tsWindowStart, count }

// ---------- Util ----------

// sha256 hash
function sha256(s){ return crypto.createHash('sha256').update(String(s)).digest('hex'); }

async function start(){
  const logger = pino({ level: "silent" });
  const { version } = await fetchLatestBaileysVersion().catch(()=>({version:[2,2314,6]}));
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);

  const sock = makeWASocket({ version, auth: state, printQRInTerminal: false, logger });

  // QR / connection events
  sock.ev.on("connection.update", (upd) => {
    if (upd.qr) {
      console.log(`\n📡 ${BOT_NAME} - Escaneie o QR (WhatsApp -> Dispositivos vinculados)`);
      qrcode.generate(upd.qr, { small: true });
    }
    if (upd.connection === "open") {
      console.log(`✅ ${BOT_NAME} conectado!`);
      // apresentação automática ao iniciar
      console.log(`== ${BOT_NAME} inicializado. Owner(s): ${listOwnersFromDB().join(', ')}`);
    }
    if (upd.connection === "close") {
      const reason = (upd.lastDisconnect && upd.lastDisconnect.error && upd.lastDisconnect.error.output) ?
        upd.lastDisconnect.error.output.statusCode : null;
      console.log("connection closed, reason:", reason);
      if (reason === DisconnectReason.loggedOut) {
        console.log("Sessão desconectada (logged out). Remova a pasta session e re-escaneie.");
      } else {
        // tenta reconectar (simples)
        start().catch(()=>{});
      }
    }
  });
  sock.ev.on("creds.update", saveCreds);

  // ---------- helpers de permissão ----------
  const isGroup = jid => jid && jid.endsWith("@g.us");
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
    // owner OR persisted admins OR group admin
    const owners = listOwnersFromDB();
    if (owners.includes(senderJid)) return true;
    const dbAdmins = listAdminsFromDB();
    if (dbAdmins.includes(senderJid)) return true;
    const groupAdm = await isGroupAdmin(groupId, senderJid);
    if (groupAdm) return true;
    return false;
  }

  // ---------- display name helper ----------
  // tenta pegar nome amigável via groupMetadata (se for grupo), ou extrai do jid
  async function displayName(groupId, jid){
    try {
      if (groupId && isGroup(groupId)) {
        const meta = await sock.groupMetadata(groupId);
        const p = meta.participants.find(x=>x.id===jid);
        if (p) {
          // baileys older versions may have 'notify' or 'id'. fallback:
          return (p.notify || p?.id?.split('@')[0] || jid.split('@')[0]);
        }
      }
    } catch(e){}
    // fallback: pegar parte antes do @
    return jid.split('@')[0];
  }

  // ---------- anti-flood checks ----------
  function checkCooldown(jid, cooldownMs = 3000){
    const now = Date.now();
    const last = commandCooldowns.get(jid) || 0;
    if (now - last < cooldownMs) return false;
    commandCooldowns.set(jid, now);
    return true;
  }
  function checkMessageRate(jid){
    const now = Date.now();
    const entry = messageCounts.get(jid) || { tsWindowStart: now, count: 0 };
    if (now - entry.tsWindowStart > MESSAGE_WINDOW) {
      entry.tsWindowStart = now; entry.count = 0;
    }
    entry.count += 1;
    messageCounts.set(jid, entry);
    // thresholds: warn >30/min, block commands >70/min
    if (entry.count > 70) return { ok:false, code: 'block' };
    if (entry.count > 30) return { ok:false, code: 'warn' };
    return { ok:true };
  }

  // ---------- group participant events (welcomes / exits / promote / demote) ----------
  sock.ev.on("group-participants.update", async update => {
    try {
      const groupId = update.id, action = update.action, participants = update.participants||[], actor = update.actor||update.author;
      for (const p of participants){
        ensureUser(p);
        if (action === "add"){
          const text = `👋 Olá @${p.split("@")[0]}! Seja bem-vindo(a) ao grupo.\n\n📌 Regras rápidas: respeite os outros e divirta-se.\n\n— ${BOT_NAME}`;
          await sock.sendMessage(groupId, { text, mentions: [p] });
        } else if (action === "remove"){
          if (actor && actor !== p){
            const text = `🚨 @${p.split("@")[0]} foi removido(a) do grupo por @${actor.split("@")[0]}.`;
            await sock.sendMessage(groupId, { text, mentions: [p, actor] });
          } else {
            const text = `👋 @${p.split("@")[0]} saiu do grupo. Até a próxima!`;
            await sock.sendMessage(groupId, { text, mentions: [p] });
          }
        } else if (action === "promote"){
          const text = `⬆️ @${p.split("@")[0]} foi promovido(a) a admin pelo ${BOT_NAME}.`;
          await sock.sendMessage(groupId, { text, mentions: [p] });
        } else if (action === "demote"){
          const text = `⬇️ @${p.split("@")[0]} deixou de ser admin.`;
          await sock.sendMessage(groupId, { text, mentions: [p] });
        }
      }
    } catch(e){ console.error("group-participants.update error:", e); }
  });

  // ---------- messages and commands ----------
  sock.ev.on("messages.upsert", async m => {
    try {
      const msg = m.messages[0]; if (!msg || !msg.message) return;
      if (msg.key && msg.key.fromMe) return; // ignore own

      const from = msg.key.remoteJid;
      const sender = msg.key.participant || msg.key.remoteJid; // participant in group, remoteJid in private
      // --- simple message flood check ---
      const rate = checkMessageRate(sender);
      if (!rate.ok) {
        if (rate.code === 'warn') {
          await sock.sendMessage(from, { text: `⚠️ @${sender.split('@')[0]} — você está enviando muitas mensagens. Diminua o ritmo para evitar bloqueios.`, mentions:[sender] });
        } else {
          // block commands if necessary by ignoring
          return;
        }
      }

      const type = Object.keys(msg.message)[0];
      let text = "";
      if (type === "conversation") text = msg.message.conversation||"";
      else if (type === "extendedTextMessage") text = msg.message.extendedTextMessage.text||"";
      else return; // ignore other types for commands

      ensureUser(sender); addMsg(sender);

      // only commands start with prefix
      if (!text.startsWith(PREFIX)) return;

      // cooldown per user for commands
      if (!checkCooldown(sender, 3000)) {
        return sock.sendMessage(from, { text: `⏳ @${sender.split('@')[0]} — aguarde alguns segundos entre comandos.`, mentions:[sender] });
      }

      const args = text.trim().split(/\s+/);
      const cmd = args[0].slice(PREFIX.length).toLowerCase();

      // context
      const isOwner = listOwnersFromDB().includes(sender);
      const isDBAdmin = listAdminsFromDB().includes(sender);
      const groupContext = isGroup(from);
      const authorized = groupContext ? await isAuthorizedAdmin(from, sender) : (isOwner || isDBAdmin);

      const reply = async (txt, mentions) => {
        if (mentions) await sock.sendMessage(from, { text: txt, mentions });
        else await sock.sendMessage(from, { text: txt });
      };

      // ---------- CORE COMMANDS ----------

      // help/about
      if (cmd === "help" || cmd === "about"){
        const aboutText = `🛡️ *${BOT_NAME}*\n` +
          `Dono(s) verificados: ${listOwnersFromDB().map(x=>x.split('@')[0]).join(', ')}\n\n` +
          `Comandos principais:\n` +
          `/help | /about - apresentação\n` +
          `/coin - ver saldo\n` +
          `/rank - ranking geral\n` +
          `/daily - coletar daily\n` +
          `/steal @user - tentar roubar\n\n` +
          `Diversão:\n` +
          `/roll - joga um dado (1-6)\n` +
          `/shop - ver itens\n` +
          `/buy <itemid> - comprar item\n\n` +
          `Admins/Owner:\n` +
          `/kick @user /ban @user /promote /demote /mentionall /close /open\n` +
          `Owner-only: /setpass <senha> (define senha), /auth <senha> (autentica via privado), /addadmin /deladmin /give /gift\n\n` +
          `Proteções: cooldown de comandos e anti-flood ativo.`;
        return reply(aboutText);
      }

      // ------- AUTHENTICATION FLOW ----------
      // owner sets password (only existing owner number can), stored hashed
      if (cmd === "setpass") {
        if (!listOwnersFromDB().includes(sender)) return reply("❌ Apenas o owner principal pode definir a senha.");
        const newpass = args[1];
        if (!newpass) return reply("Uso: /setpass <senha>");
        setOwnerHash(sha256(newpass));
        return reply("✅ Senha definida com sucesso. Usuários podem usar /auth <senha> em privado para se autenticar.");
      }
      // auth: user DM's bot with /auth <senha> to become owner (persisted)
      if (cmd === "auth") {
        // must be in private chat (not in group) for security
        if (isGroup(from)) return reply("Use /auth apenas em conversa privada com o bot (não no grupo).");
        const pass = args[1];
        if (!pass) return reply("Uso: /auth <senha>");
        const db = loadDB();
        if (!db.ownerHash) return reply("A senha ainda não foi definida pelo owner principal.");
        if (sha256(pass) === db.ownerHash) {
          // add this sender to owners
          if (!db.owners.includes(sender)) { db.owners.push(sender); saveDB(db); }
          return reply("✅ Autenticado como owner verificado! Agora você tem permissões owner.");
        } else return reply("❌ Senha incorreta.");
      }

      // owner add/remove admins persistant
      if (cmd === "addadmin") {
        if (!isOwner) return reply("❌ Apenas owners podem adicionar admins persistentes.");
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
        if (!mentioned || !mentioned[0]) return reply("Marque quem será admin.");
        addAdminToDB(mentioned[0]); return reply(`✅ ${mentioned[0]} agora é admin persistente.`, mentioned);
      }
      if (cmd === "deladmin") {
        if (!isOwner) return reply("❌ Apenas owners podem remover admins persistentes.");
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
        if (!mentioned || !mentioned[0]) return reply("Marque quem remover.");
        delAdminFromDB(mentioned[0]); return reply(`❌ ${mentioned[0]} removido dos admins.`, mentioned);
      }

      // ---- GROUP / ADMIN actions ----
      if (["kick","ban","promote","demote","mentionall","close","open"].includes(cmd)){
        if (!groupContext) return reply("Esse comando só funciona em grupos.");
        if (!authorized) return reply("❌ Você não tem permissão.");
        const botIsAdmin = await isBotAdmin(from);
        if ((["kick","ban","promote","demote","close","open"].includes(cmd)) && !botIsAdmin) return reply("❌ Eu preciso ser admin do grupo para essa ação.");
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
        if ((cmd==="kick"||cmd==="ban") && !mentioned[0]) return reply("Marque quem remover.");
        try {
          if (cmd==="kick"||cmd==="ban") {
            await sock.groupParticipantsUpdate(from, [mentioned[0]], "remove");
            return reply(`✅ @${mentioned[0].split('@')[0]} removido.`, [mentioned[0]]);
          }
          if (cmd==="promote") { await sock.groupParticipantsUpdate(from, [mentioned[0]], "promote"); return reply(`⬆️ @${mentioned[0].split('@')[0]} promovido.`, [mentioned[0]]); }
          if (cmd==="demote") { await sock.groupParticipantsUpdate(from, [mentioned[0]], "demote"); return reply(`⬇️ @${mentioned[0].split('@')[0]} demovido.`, [mentioned[0]]); }
          if (cmd==="mentionall") {
            const meta = await sock.groupMetadata(from); const members = meta.participants.map(p=>p.id);
            return sock.sendMessage(from, { text: `📣 Mencionando todos:`, mentions: members });
          }
          if (cmd==="close") { await sock.groupSettingUpdate(from, "announcement"); return reply("🔒 Grupo fechado."); }
          if (cmd==="open") { await sock.groupSettingUpdate(from, "not_announcement"); return reply("🔓 Grupo aberto."); }
        } catch(e){ console.error(e); return reply("Erro ao executar ação (verifique permissões)."); }
      }

      // ---- ECONOMY & SOCIAL ----
      if (cmd === "coin") {
        const c = getCoins(sender);
        return reply(`💰 @${sender.split('@')[0]} tem ${c} coins.`, [sender]);
      }
      if (cmd === "rank") {
        const db = loadDB();
        const arr = Object.entries(db.users||{}).sort((a,b)=>(b[1].coins||0)-(a[1].coins||0)).slice(0,15);
        let text = arr.map((it,i)=>{
          // try to show friendly name using group metadata if in group; else show jid short
          const name = (groupContext ? undefined : undefined); // we'll attempt a displayName per jid below
          const jid = it[0];
          return `${i+1}. ${jid.split('@')[0]} — ${it[1].coins} coins`;
        }).join("\n") || "Sem dados ainda.";
        // try to map nicer names if groupContext
        if (groupContext) {
          const meta = await sock.groupMetadata(from);
          const map = new Map(meta.participants.map(p => [p.id, (p.notify || p.id.split('@')[0])]));
          text = arr.map((it,i) => `${i+1}. ${(map.get(it[0])||it[0].split('@')[0])} — ${it[1].coins} coins`).join("\n");
        }
        return reply(`🏆 Ranking:\n${text}`);
      }
      if (cmd === "daily") {
        const db = loadDB(); ensureUser(sender); const user = db.users[sender]; const now = Date.now();
        if (now - (user.lastDaily||0) < 24*60*60*1000) return reply("⏳ Você já coletou o daily nas últimas 24h.");
        user.lastDaily = now; user.coins = (user.coins||0) + 50; saveDB(db);
        return reply("🎉 Você ganhou 50 coins no daily!");
      }
      if (cmd === "steal") {
        if (!groupContext) return reply("Use /steal em grupos marcando o alvo.");
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
        if (!mentioned[0]) return reply("Marque quem quer roubar.");
        const stolen = stealCoins(sender, mentioned[0]);
        const dn = await displayName(from, mentioned[0]);
        return reply(`🏴‍☠️ Você roubou ${stolen} coins de @${dn}!`, [mentioned[0]]);
      }
      // pay / transfer
      if (cmd === "pay") {
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const amount = Number(args[2]);
        if (!mentioned[0] || !amount || amount<=0) return reply("Uso: /pay @user <amount>");
        if (getCoins(sender) < amount) return reply("Saldo insuficiente.");
        addCoins(sender, -amount); addCoins(mentioned[0], amount);
        return reply(`✅ Transferido ${amount} coins para @${mentioned[0].split('@')[0]}`, [mentioned[0]]);
      }

      // ---- FUN / SHOP ----
      if (cmd === "roll") {
        const r = Math.floor(Math.random()*6)+1; return reply(`🎲 Você tirou: ${r}`);
      }
      if (cmd === "shop") {
        const db = loadDB();
        const items = db.shop.map(it=>`${it.id} — ${it.name}: ${it.price} coins`).join("\n");
        return reply(`🛒 Loja disponível:\n${items}`);
      }
      if (cmd === "buy") {
        const itemId = args[1];
        if (!itemId) return reply("Uso: /buy <itemid>");
        const db = loadDB();
        const item = db.shop.find(i=>i.id===itemId);
        if (!item) return reply("Item não encontrado.");
        if (getCoins(sender) < item.price) return reply("Saldo insuficiente.");
        addCoins(sender, -item.price);
        // item effect: example: vip grants nothing programmatic but could be used later
        return reply(`✅ Você comprou ${item.name} por ${item.price} coins!`);
      }

      // ---- owner give/gift ----
      if (cmd === "give") {
        if (!isOwner) return reply("❌ Apenas owners podem usar /give.");
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
        const amount = Number(args[2]);
        if (!mentioned || !amount || amount <= 0) return reply("Uso: /give @user <amount>");
        addCoins(mentioned[0], amount); return reply(`🎁 Dono deu ${amount} coins para @${m  if (!db.users[jid]) {
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
