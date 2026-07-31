require('dotenv').config();
const os = require('os');
const express = require('express');
const QRCode = require('qrcode'); // QR generate karne ke liye
const { initWhatsApp, getSock, isWhatsAppReady, getLatestQr } = require('./waClient');

// Packages for Media Processing & APIs
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const cloudinary = require('cloudinary').v2;
const { google } = require('googleapis'); // 🔴 YouTube API Package

ffmpeg.setFfmpegPath(ffmpegPath);

// Cloudinary Configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// 🔴 YouTube OAuth2 Client Setup
const oauth2Client = new google.auth.OAuth2(
  process.env.YOUTUBE_CLIENT_ID,
  process.env.YOUTUBE_CLIENT_SECRET,
  'https://developers.google.com/oauthplayground'
);

oauth2Client.setCredentials({
  refresh_token: process.env.YOUTUBE_REFRESH_TOKEN
});

const youtube = google.youtube({
  version: 'v3',
  auth: oauth2Client
});

const app = express();
app.use(express.json());

function requireApiKey(req, res, next) {
  if (req.headers['x-api-key'] !== process.env.WHATSAPP_SERVICE_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Helper: Download file to local temp path
const downloadFile = async (url, outputPath) => {
  const writer = fs.createWriteStream(outputPath);
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream'
  });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
};

// Helper: Pick random MP3 file from assets/music/
const getRandomMusicFile = (musicFolderPath) => {
  if (!fs.existsSync(musicFolderPath)) return null;
  const files = fs.readdirSync(musicFolderPath).filter(file => file.endsWith('.mp3'));
  if (files.length === 0) return null;
  const randomIndex = Math.floor(Math.random() * files.length);
  return path.join(musicFolderPath, files[randomIndex]);
};

// 🌐 QR Code Route
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

app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

// --- WhatsApp Route ---
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

// --- Instagram Single Image Route ---
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

app.post('/api/send-all-reels', requireApiKey, async (req, res) => {
  const timestamp = Date.now();
  const tempDir = os.tmpdir();

  const { imageUrl, caption, title, description, audioUrl, hashtags } = req.body;
  if (!imageUrl) {
    return res.status(400).json({ error: 'imageUrl is required' });
  }

  console.log(`🚀 [REEL SERVICE] Request Received for: "${title || 'Job Update'}"`);

  const rawTitle = title || 'Govt Job Update';
  const finalYtTitle = `${rawTitle} #Shorts`.substring(0, 95);
  const finalYtDescription = description || caption || 'Latest Govt Job Updates & Notification.';

  const urlExt = path.extname(imageUrl.split('?')[0]) || '.png';
  const tempImgPath = path.join(tempDir, `input-${timestamp}${urlExt}`);
  const tempOutputPath = path.join(tempDir, `output-${timestamp}.mp4`);
  
  let customAudioPath = null;
  let cloudinaryPublicId = null;

  try {
    await downloadFile(imageUrl, tempImgPath);

    const animVideoPath = path.join(__dirname, 'assets/follow-anim.mp4');
    let hasAnim = fs.existsSync(animVideoPath);

    let selectedAudioPath = null;
    if (audioUrl) {
      customAudioPath = path.join(tempDir, `audio-${timestamp}.mp3`);
      await downloadFile(audioUrl, customAudioPath);
      selectedAudioPath = customAudioPath;
    } else {
      const musicDir = path.join(__dirname, 'assets/music');
      selectedAudioPath = getRandomMusicFile(musicDir);
    }

    await new Promise((resolve, reject) => {
      let command = ffmpeg();
      
      command.input(tempImgPath).inputOptions(['-loop 1']);
      if (hasAnim) command.input(animVideoPath).inputOptions(['-stream_loop -1']);
      if (selectedAudioPath) command.input(selectedAudioPath);

      // Blurred Background + Center Image + Brand Name Text
      let filterComplex = [
        "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,avgblur=sizeX=30:sizeY=30[bg]",
        "[0:v]scale=1069:-1:force_original_aspect_ratio=decrease[scaled_job_img]",
        "[bg][scaled_job_img]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2[bg_with_job]",
        "[bg_with_job]drawtext=text='Govt Exam Study':fontcolor=black:fontsize=95:x=(w-tw)/2:y=150:box=1:boxcolor=white@0.8:boxborderw=15[v_with_title]"
      ];

      let lastVideoNode = "[v_with_title]";

      if (hasAnim) {
        filterComplex.push(`[1:v]colorkey=0x000000:0.15:0.1,scale=600:-1[keyed_anim]`);
        filterComplex.push(`${lastVideoNode}[keyed_anim]overlay=(main_w-overlay_w)/2:1500[v_with_anim]`);
        lastVideoNode = "[v_with_anim]";
      }

      command.complexFilter(filterComplex);

      const audioInputIndex = hasAnim ? 2 : 1;
      if (selectedAudioPath) {
        command.outputOptions(['-map', lastVideoNode, '-map', `${audioInputIndex}:a`, '-c:a', 'aac', '-b:a', '128k', '-shortest']);
      } else {
        command.outputOptions(['-map', lastVideoNode]);
      }

      command
        .outputOptions(['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '9', '-preset', 'ultrafast', '-threads', '2'])
        .output(tempOutputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    const igTask = (async () => {
      try {
        const cloudRes = await cloudinary.uploader.upload(tempOutputPath, {
          resource_type: 'video',
          folder: 'instagram_reels'
        });
        cloudinaryPublicId = cloudRes.public_id;

        const igAccountId = process.env.INSTAGRAM_ACCOUNT_ID;
        const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;

        const containerRes = await axios.post(`https://graph.facebook.com/v21.0/${igAccountId}/media`, {
          media_type: 'REELS',
          video_url: cloudRes.secure_url,
          caption: caption || title || 'Govt Exam Study Updates 🚀',
          access_token: accessToken
        });

        const creationId = containerRes.data.id;
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 5000));
          const statusRes = await axios.get(`https://graph.facebook.com/v21.0/${creationId}?fields=status_code&access_token=${accessToken}`);
          if (statusRes.data.status_code === 'FINISHED') break;
        }

        const publishRes = await axios.post(`https://graph.facebook.com/v21.0/${igAccountId}/media_publish`, {
          creation_id: creationId,
          access_token: accessToken
        });
        return { success: true, postId: publishRes.data.id };
      } catch (err) {
        return { success: false, error: err.response?.data || err.message };
      }
    })();

    const ytTask = (async () => {
      try {
        const parsedTags = hashtags ? hashtags.replace(/#/g, '').split(' ').filter(Boolean) : ['Shorts', 'GovtJobs'];

        const ytResponse = await youtube.videos.insert({
          part: 'snippet,status',
          requestBody: {
            snippet: {
              title: finalYtTitle,
              description: finalYtDescription,
              tags: parsedTags,
              categoryId: '27'
            },
            status: { privacyStatus: 'public', selfDeclaredMadeForKids: false }
          },
          media: { body: fs.createReadStream(tempOutputPath) }
        });
        return { success: true, videoId: ytResponse.data.id };
      } catch (err) {
        return { success: false, error: err.response?.data || err.message };
      }
    })();

    const [igResult, ytResult] = await Promise.all([igTask, ytTask]);

    if (cloudinaryPublicId) {
      try { await cloudinary.uploader.destroy(cloudinaryPublicId, { resource_type: 'video' }); } catch (e) {}
    }

    console.log(`✅ [REEL SERVICE] Process Complete! IG: ${igResult.success}, YT: ${ytResult.success}`);
    res.json({ success: true, instagram: igResult, youtube: ytResult });

  } catch (err) {
    console.error(`❌ [REEL SERVICE] Error:`, err.message);
    res.status(500).json({ error: err.message });
  } finally {
    [tempImgPath, tempOutputPath, customAudioPath].forEach(filePath => {
      if (filePath && fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch (e) {}
      }
    });
  }
});

// --- Facebook Route ---
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

// --- LinkedIn Route ---
app.post('/api/send-linkedin', requireApiKey, async (req, res) => {
  const { text, imageUrl } = req.body;
  const token = process.env.LINKEDIN_ACCESS_TOKEN;
  const authorUrn = process.env.LINKEDIN_PERSON_URN;

  try {
    let contentBlock = {};

    if (imageUrl) {
      const registerRes = await fetch('https://api.linkedin.com/rest/images?action=initializeUpload', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Restli-Protocol-Version': '2.0.0',
          'Linkedin-Version': '202607'
        },
        body: JSON.stringify({
          initializeUploadRequest: { owner: authorUrn }
        })
      });
      const registerData = await registerRes.json();
      const uploadUrl = registerData.value.uploadUrl;
      const imageUrn = registerData.value.image;

      const imgBuffer = await (await fetch(imageUrl)).arrayBuffer();
      await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}` },
        body: Buffer.from(imgBuffer)
      });

      contentBlock = { media: { id: imageUrn } };
    }

    const response = await fetch('https://api.linkedin.com/rest/posts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
        'Linkedin-Version': '202607'
      },
      body: JSON.stringify({
        author: authorUrn,
        commentary: text || "Govt Exam Study Updates 🚀",
        visibility: "PUBLIC",
        distribution: {
          feedDistribution: "MAIN_FEED",
          targetEntities: [],
          thirdPartyDistributionChannels: []
        },
        content: imageUrl ? contentBlock : undefined,
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false
      })
    });

    const data = await response.text();

    if (response.status === 201) {
      const postId = response.headers.get('x-restli-id');
      console.log("✅ LinkedIn post sent successfully:", postId);
      return res.json({ success: true, postId });
    }

    console.log("❌ LinkedIn Response:", response.status, data);
    res.status(response.status).send(data);

  } catch (err) {
    console.error("❌ Error posting to LinkedIn:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT || 4600, () => {
  console.log(`WhatsApp Broadcast Service running on port ${process.env.PORT || 4600}`);
  initWhatsApp();
});