require('dotenv').config();
const express = require('express');
const { initWhatsApp, getSock, isWhatsAppReady } = require('./waClient');

const app = express();
app.use(express.json());

function requireApiKey(req, res, next) {
  if (req.headers['x-api-key'] !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

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

  try {
    const sock = getSock();
    if (imageUrl) {
      await sock.sendMessage(channelId, { image: { url: imageUrl }, caption: text });
    } else {
      await sock.sendMessage(channelId, { text });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Send failed:', err.message);
    res.status(502).json({ error: 'Failed to send message' });
  }
});

app.listen(process.env.PORT || 4600, () => {
  console.log(`WhatsApp Broadcast Service running on port ${process.env.PORT || 4600}`);
  initWhatsApp();
});