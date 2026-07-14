require('dotenv').config();
const express = require('express');
const QRCode = require('qrcode'); // QR generate karne ke liye
const { initWhatsApp, getSock, isWhatsAppReady, getLatestQr } = require('./waClient');

const app = express();
app.use(express.json());

function requireApiKey(req, res, next) {
  if (req.headers['x-api-key'] !== process.env.WHATSAPP_SERVICE_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// 🌐 NAYA ROUTE: QR Code ko URL par dekhne ke liye
app.get('/qr', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');

  const qr = getLatestQr();
  
  if (isWhatsAppReady()) {
    return res.send("<h3>✅ WhatsApp pehle se hi connected hai bhai!</h3>");
  }
  
  if (!qr) {
    return res.send("<h3>⏳ QR Code load ho raha hai, thodi der me page refresh karo...</h3>");
  }

  try {
    const qrImage = await QRCode.toDataURL(qr);
    res.send(`
      <div style="text-align: center; margin-top: 50px; font-family: Arial;">
        <h2>📱 Apne WhatsApp se scan karo bhai:</h2>
        <img src="${qrImage}" style="width: 300px; border: 1px solid #ccc; padding: 10px;"/>
        <p>Scan karne ke baad server khud connect ho jayega.</p>
      </div>
    `);
  } catch (err) {
    res.status(500).send("QR display error: " + err.message);
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', whatsappConnected: isWhatsAppReady() });
});

app.post('/api/send', requireApiKey, async (req, res) => {
  const { channelId, text, imageUrl } = req.body;

  if (!channelId || !text) {
    return res.status(400).json({ error: 'channelId and text are required' });
  }
  if (!isWhatsAppReady()) {
    return res.status(503).json({ error: 'WhatsApp not connected yet' });
  }

  const sock = getSock();
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (imageUrl) {
        await sock.sendMessage(channelId, { image: { url: imageUrl }, caption: text });
      } else {
        await sock.sendMessage(channelId, { text });
      }
      return res.json({ success: true, attempt });
    } catch (err) {
      lastError = err;
      console.error(`Send attempt ${attempt} failed:`, err.message);
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }

  console.error('All send attempts failed:', lastError?.message);
  res.status(502).json({ error: 'Failed to send message after 3 attempts' });
});

app.listen(process.env.PORT || 4600, () => {
  console.log(`WhatsApp Broadcast Service running on port ${process.env.PORT || 4600}`);
  initWhatsApp();
});