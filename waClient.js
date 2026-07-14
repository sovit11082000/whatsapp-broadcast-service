const { default: makeWASocket, DisconnectReason, initAuthCreds, BufferJSON, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const mongoose = require("mongoose");

let sock = null;
let isReady = false;
let latestQr = null;
let isConnecting = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

const SessionSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  value: { type: String, required: true }
});
const SessionModel = mongoose.models.WhatsAppSession || mongoose.model("WhatsAppSession", SessionSchema);

async function initWhatsApp() {
  if (isConnecting) {
    console.log("⏳ Already connecting, skipping duplicate call...");
    return;
  }
  isConnecting = true;

  try {
    if (mongoose.connection.readyState !== 1) {
      console.log("⏳ Connecting to MongoDB for WhatsApp Session...");
      await mongoose.connect(process.env.MONGODB_URI);
    }

    const sessionId = "render_wa_session";

    const document = await SessionModel.findOne({ id: sessionId });
    let creds = document ? JSON.parse(document.value, BufferJSON.reviver) : initAuthCreds();

    const state = {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            const keyDoc = await SessionModel.findOne({ id: `${sessionId}:${type}:${id}` });
            if (keyDoc) {
              data[id] = JSON.parse(keyDoc.value, BufferJSON.reviver);
            }
          }
          return data;
        },
        set: async (data) => {
          for (const type in data) {
            for (const id in data[type]) {
              const value = data[type][id];
              const keyId = `${sessionId}:${type}:${id}`;
              if (value) {
                await SessionModel.findOneAndUpdate(
                  { id: keyId },
                  { value: JSON.stringify(value, BufferJSON.replacer) },
                  { upsert: true }
                );
              } else {
                await SessionModel.deleteOne({ id: keyId });
              }
            }
          }
        }
      }
    };

    // Purana socket poori tarah band karo, agar tha
    if (sock) {
      try {
        sock.ev.removeAllListeners();
        sock.end(undefined);
      } catch (e) {
        // ignore cleanup errors
      }
      sock = null;
    }

    const { version } = await fetchLatestBaileysVersion();
    console.log("📦 Using Baileys/WA version:", version);

    sock = makeWASocket({
      auth: state,
      version,
      printQRInTerminal: false,
      connectTimeoutMs: 60000,
    });

    sock.ev.on("creds.update", async () => {
      await SessionModel.findOneAndUpdate(
        { id: sessionId },
        { value: JSON.stringify(state.creds, BufferJSON.replacer) },
        { upsert: true }
      );
    });

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        latestQr = qr;
        console.log("✨ QR Code ready! /qr route par dekho.");
      }

      if (connection === "open") {
      isReady = true;
      isConnecting = false;
      reconnectAttempts = 0;
      latestQr = null;
      console.log("✅ WhatsApp successfully connected and saved in MongoDB!");

      // Channel session ko "warm up" karo taaki send karte waqt fresh crypto handshake na lage
      try {
        if (process.env.WHATSAPP_CHANNEL_ID) {
          await sock.newsletterMetadata("jid", process.env.WHATSAPP_CHANNEL_ID);
          console.log("🔥 Channel session warmed up");
        }
      } catch (e) {
        console.log("Warm-up skipped:", e.message);
      }
    }

      if (connection === "close") {
        isReady = false;
        isConnecting = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(`❌ Disconnected (Reason: ${statusCode}). Reconnect: ${shouldReconnect}`);

        if (shouldReconnect) {
          reconnectAttempts++;
          if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
            console.log("🛑 Max reconnect attempts reached. Waiting 2 minutes before trying again.");
            reconnectAttempts = 0;
            setTimeout(() => initWhatsApp(), 120000);
            return;
          }
          const delay = Math.min(5000 * reconnectAttempts, 30000);
          console.log(`⏳ Reconnecting in ${delay / 1000} seconds... (attempt ${reconnectAttempts})`);
          setTimeout(() => initWhatsApp(), delay);
        } else {
          latestQr = null;
          console.log("🔒 Completely logged out. Cleaning DB...");
          await SessionModel.deleteMany({ id: new RegExp(`^${sessionId}`) });
          setTimeout(() => initWhatsApp(), 3000);
        }
      }
    });
  } catch (err) {
    isConnecting = false;
    console.error("❌ initWhatsApp error:", err.message);
    setTimeout(() => initWhatsApp(), 10000);
  }
}

function getSock() { return sock; }
function isWhatsAppReady() { return isReady; }
function getLatestQr() { return latestQr; }

module.exports = { initWhatsApp, getSock, isWhatsAppReady, getLatestQr };