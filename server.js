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
  const { channelId, text } = req.body;

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
      await sock.sendMessage(channelId, { text });
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

app.post('/api/send-instagram', requireApiKey, async (req, res) => {
  const { imageUrl, caption } = req.body;

  if (!imageUrl || !caption) {
    return res.status(400).json({ error: 'imageUrl and caption are required' });
  }

  try {
    const igAccountId = process.env.INSTAGRAM_ACCOUNT_ID;
    const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;

    const containerRes = await fetch(
      `https://graph.facebook.com/v21.0/${igAccountId}/media`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_url: imageUrl, caption, access_token: accessToken }),
      }
    );
    const containerData = await containerRes.json();

    if (!containerData.id) {
      console.error('Instagram container error:', containerData);
      return res.status(502).json({ error: 'Failed to create media container', details: containerData });
    }

    // Container ready hone ka wait karo (poll status)
    let statusOk = false;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const statusRes = await fetch(
        `https://graph.facebook.com/v21.0/${containerData.id}?fields=status_code&access_token=${accessToken}`
      );
      const statusData = await statusRes.json();
      if (statusData.status_code === 'FINISHED') {
        statusOk = true;
        break;
      }
      if (statusData.status_code === 'ERROR') {
        return res.status(502).json({ error: 'Media processing failed', details: statusData });
      }
    }

    if (!statusOk) {
      return res.status(504).json({ error: 'Media not ready after waiting, try again' });
    }

    const publishRes = await fetch(
      `https://graph.facebook.com/v21.0/${igAccountId}/media_publish`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ creation_id: containerData.id, access_token: accessToken }),
      }
    );
    const publishData = await publishRes.json();

    if (!publishData.id) {
      console.error('Instagram publish error:', publishData);
      return res.status(502).json({ error: 'Failed to publish', details: publishData });
    }

    console.log('✅ Instagram post published:', publishData.id);
    res.json({ success: true, postId: publishData.id });
  } catch (err) {
    console.error('Instagram send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/send-facebook', requireApiKey, async (req, res) => {
  const { message, link } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }

  try {
    const pageId = process.env.FACEBOOK_PAGE_ID;
    const accessToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;

    const body = { message, access_token: accessToken };
    if (link) body.link = link;

    const fbRes = await fetch(
      `https://graph.facebook.com/v21.0/${pageId}/feed`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    const fbData = await fbRes.json();

    if (!fbData.id) {
      console.error('Facebook post error:', fbData);
      return res.status(502).json({ error: 'Failed to post to Facebook', details: fbData });
    }

    console.log('✅ Facebook post published:', fbData.id);
    res.json({ success: true, postId: fbData.id });
  } catch (err) {
    console.error('Facebook send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT || 4600, () => {
  console.log(`WhatsApp Broadcast Service running on port ${process.env.PORT || 4600}`);
  initWhatsApp();
});