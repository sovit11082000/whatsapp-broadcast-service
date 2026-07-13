const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");

let sock = null;
let isReady = false;

async function initWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("./wa-session");
  sock = makeWASocket({ auth: state, printQRInTerminal: true });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      isReady = true;
      console.log("✅ WhatsApp connected!");
    }

    if (connection === "close") {
      isReady = false;
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("❌ WhatsApp disconnected. Reconnect:", shouldReconnect);
      if (shouldReconnect) initWhatsApp();
    }
  });

  return sock;
}

function getSock() {
  return sock;
}

function isWhatsAppReady() {
  return isReady;
}

module.exports = { initWhatsApp, getSock, isWhatsAppReady };