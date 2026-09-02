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

const app = express();
app.use(express.json());

function requireApiKey(req, res, next) {
  if (req.headers['x-api-key'] !== process.env.WHATSAPP_SERVICE_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

async function downloadFile(url, targetPath) {
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
    timeout: 20000, // 20 seconds timeout limit
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  });

  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(targetPath);
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

// Helper: Pick random MP3 file from assets/music/
const getRandomMusicFile = (musicFolderPath) => {
  if (!fs.existsSync(musicFolderPath)) return null;
  const files = fs.readdirSync(musicFolderPath).filter(file => file.endsWith('.mp3'));
  if (files.length === 0) return null;
  const randomIndex = Math.floor(Math.random() * files.length);
  return path.join(musicFolderPath, files[randomIndex]);
};

// 🔒 Simple lock so two heavy reel-generation jobs never run at the same time
// (running two in parallel is what blows past 512MB on Render's free tier)
let isReelJobRunning = false;

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

// --- YouTube Multi-Key Pool Helper ---
function getYouTubeCredentialsPool() {
  if (process.env.YOUTUBE_ACCOUNTS_POOL) {
    try {
      const pool = JSON.parse(process.env.YOUTUBE_ACCOUNTS_POOL);
      if (Array.isArray(pool) && pool.length > 0) return pool;
    } catch (e) {
      console.error('❌ [YouTube Pool] Failed to parse YOUTUBE_ACCOUNTS_POOL JSON from .env:', e.message);
    }
  }

  if (process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET && process.env.YOUTUBE_REFRESH_TOKEN) {
    return [{
      clientId: process.env.YOUTUBE_CLIENT_ID,
      clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
      refreshToken: process.env.YOUTUBE_REFRESH_TOKEN
    }];
  }

  return [];
}

let activeYouTubeKeyIndex = 0;

app.post('/api/send-all-reels', requireApiKey, async (req, res) => {
  // 🔒 Reject if another heavy job is already running (prevents RAM stacking)
  if (isReelJobRunning) {
    return res.status(409).json({ error: 'Another reel job is already running. Try again shortly.' });
  }
  isReelJobRunning = true;

  const timestamp = Date.now();
  const tempDir = os.tmpdir();

  const { imageUrl, caption, title, description, audioUrl, hashtags } = req.body;
  if (!imageUrl) {
    isReelJobRunning = false;
    return res.status(400).json({ error: 'imageUrl is required' });
  }

  console.log(`🚀 [REEL SERVICE] Request Received for: "${title || 'Job Update'}"`);

  let rawTitle = title || 'Govt Job Update';
  rawTitle = rawTitle
    .replace(/\|?\s*new update/gi, '')
    .replace(/\|?\s*new/gi, '')
    .trim();
  const finalYtTitle = `${rawTitle} #Shorts`.substring(0, 95);
  const finalYtDescription = description || caption || 'Latest Govt Job Updates & Notification.';

  const urlExt = path.extname(imageUrl.split('?')[0]) || '.png';
  const tempImgPath = path.join(tempDir, `input-${timestamp}${urlExt}`);
  const tempOutputPath = path.join(tempDir, `output-${timestamp}.mp4`);

  let customAudioPath = null;
  let cloudinaryPublicId = null;

  try {
    await downloadFile(imageUrl, tempImgPath);

    const logoPath = path.join(__dirname, 'assets/logo.png');
    const hasLogo = fs.existsSync(logoPath);

    const animVideoPath = path.join(__dirname, 'assets/follow-anim.mp4');
    const hasAnim = fs.existsSync(animVideoPath);

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

      if (hasLogo) command.input(logoPath).inputOptions(['-loop 1']);
      if (hasAnim) command.input(animVideoPath).inputOptions(['-stream_loop -1']);
      if (selectedAudioPath) command.input(selectedAudioPath);

      // Low-RAM Filter Complex (Scaling blur down to saving RAM)
      let filterComplex = [
        "[0:v]scale=360:640:force_original_aspect_ratio=increase,crop=360:640,avgblur=sizeX=8:sizeY=8,scale=720:1280[bg]",
        "[0:v]scale=713:-1:force_original_aspect_ratio=decrease[scaled_job_img]",
        "[bg][scaled_job_img]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2[bg_with_job]"
      ];

      let lastVideoNode = "[bg_with_job]";
      let currentInputIndex = 1;

      if (hasLogo) {
        filterComplex.push(`[${currentInputIndex}:v]scale=600:-1[scaled_logo]`);
        filterComplex.push(`${lastVideoNode}[scaled_logo]overlay=(main_w-overlay_w)/2:120[v_with_logo]`);
        lastVideoNode = "[v_with_logo]";
        currentInputIndex++;
      }

      if (hasAnim) {
        filterComplex.push(`[${currentInputIndex}:v]colorkey=0x000000:0.15:0.1,scale=600:-1[keyed_anim]`);
        filterComplex.push(`${lastVideoNode}[keyed_anim]overlay=(main_w-overlay_w)/2:1500[v_with_anim]`);
        lastVideoNode = "[v_with_anim]";
        currentInputIndex++;
      }

      command.complexFilter(filterComplex);

      const audioInputIndex = currentInputIndex;
      if (selectedAudioPath) {
        command.outputOptions(['-map', lastVideoNode, '-map', `${audioInputIndex}:a`, '-c:a', 'aac', '-b:a', '128k', '-shortest']);
      } else {
        command.outputOptions(['-map', lastVideoNode]);
      }

      // Memory Control Options (-threads 1 & low buffer)
      command
        .outputOptions([
          '-c:v', 'libx264',
          '-pix_fmt', 'yuv420p',
          '-t', '9',
          '-preset', 'ultrafast',
          '-threads', '1',
          '-max_muxing_queue_size', '1024'
        ])
        .output(tempOutputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // NOTE: These three uploads now run ONE AFTER ANOTHER (not Promise.all)
    // so only one video buffer/stream is in memory at a time. This is slower
    // overall but avoids stacking 3x memory usage on the free 512MB instance.

    // 1. Instagram Reels Task
    async function runInstagramTask() {
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
        const errMsg = err.response?.data || err.message;
        console.error('❌ [Instagram Reel Error Details]:', JSON.stringify(errMsg, null, 2));
        return { success: false, error: errMsg };
      }
    }

    // 2. YouTube Shorts Task
    async function runYoutubeTask() {
      const parsedTags = hashtags ? hashtags.replace(/#/g, '').split(' ').filter(Boolean) : ['Shorts', 'GovtJobs'];

      if (!fs.existsSync(tempOutputPath)) {
        return { success: false, error: "Rendered output file path par nahi mili!" };
      }

      const pool = getYouTubeCredentialsPool();
      if (!pool.length) {
        console.error("❌ [YouTube Error]: No YouTube API credentials configured in .env");
        return { success: false, error: "No YouTube credentials found in .env" };
      }

      let lastError = null;

      for (let attempt = 0; attempt < pool.length; attempt++) {
        const targetIndex = (activeYouTubeKeyIndex + attempt) % pool.length;
        const creds = pool[targetIndex];

        console.log(`🔄 [YouTube Upload] Trying Account #${targetIndex + 1} of ${pool.length}...`);

        try {
          const oauth2Client = new google.auth.OAuth2(
            creds.clientId,
            creds.clientSecret,
            'https://developers.google.com/oauthplayground'
          );

          oauth2Client.setCredentials({ refresh_token: creds.refreshToken });
          const ytInstance = google.youtube({ version: 'v3', auth: oauth2Client });

          const ytResponse = await ytInstance.videos.insert({
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

          console.log(`✅ [YouTube Shorts Success] Uploaded using Account #${targetIndex + 1}! Video ID: ${ytResponse.data.id}`);
          activeYouTubeKeyIndex = targetIndex;
          return { success: true, videoId: ytResponse.data.id, accountIndex: targetIndex + 1 };
        } catch (err) {
          lastError = err.response?.data || err.message;
          const isQuota =
            err?.response?.data?.error?.errors?.some(e => e.reason === 'quotaExceeded') ||
            err?.response?.data?.error?.code === 403 ||
            err?.message?.includes('quota') ||
            err?.response?.data?.error === 'invalid_grant';

          console.warn(`⚠️ [YouTube Warning] Account #${targetIndex + 1} Failed:`, lastError);

          if ((isQuota || true) && pool.length > 1) {
            continue;
          }
        }
      }

      console.error("❌ [YouTube Error Details]: All accounts in pool failed.", lastError);
      return { success: false, error: lastError };
    }

    // 3. Facebook Reel Task
    async function runFacebookReelTask() {
      try {
        const systemUserToken = process.env.INSTAGRAM_ACCESS_TOKEN;
        if (!systemUserToken) return { success: false, error: 'INSTAGRAM_ACCESS_TOKEN missing in .env' };

        // Page token aur ID dynamically fetch karo
        const accountsRes = await axios.get(
          `https://graph.facebook.com/v22.0/me/accounts?access_token=${systemUserToken}`
        );
        const pages = accountsRes.data.data;
        if (!pages || pages.length === 0) {
          return { success: false, error: 'No FB Pages found for System User' };
        }

        const targetPageId = process.env.FB_PAGE_ID || process.env.FACEBOOK_PAGE_ID;
        const targetPage = targetPageId
          ? pages.find(p => p.id === targetPageId) || pages[0]
          : pages[0];

        console.log(`📌 Using Facebook Page: "${targetPage.name}" (ID: ${targetPage.id})`);

        const pageToken = targetPage.access_token;
        const pageId = targetPage.id;

        // Step A: Initialize Reel Upload
        const initRes = await axios.post(
          `https://graph.facebook.com/v22.0/${pageId}/video_reels`,
          {
            upload_phase: 'start',
            access_token: pageToken
          }
        );

        const videoId = initRes.data.video_id;
        const uploadUrl = initRes.data.upload_url;

        // Step B: Upload Video via STREAM (not readFileSync) to avoid loading
        // the whole video into a Buffer in RAM
        const { size: videoSize } = fs.statSync(tempOutputPath);
        const videoStream = fs.createReadStream(tempOutputPath);
        await axios.post(uploadUrl, videoStream, {
          headers: {
            'Authorization': `OAuth ${pageToken}`,
            'offset': '0',
            'file_size': videoSize.toString(),
            'Content-Type': 'application/octet-stream',
            'Content-Length': videoSize.toString()
          },
          maxBodyLength: Infinity,
          maxContentLength: Infinity
        });

        // Step C: Publish Reel
        await axios.post(
          `https://graph.facebook.com/v22.0/${pageId}/video_reels`,
          {
            upload_phase: 'finish',
            access_token: pageToken,
            video_id: videoId,
            video_state: 'PUBLISHED',
            description: caption || title || 'Govt Exam Study Updates 🚀'
          }
        );

        console.log(`✅ [Facebook Reel Success] Published to Page "${targetPage.name}"! Video ID: ${videoId}`);
        return { success: true, videoId: videoId, pageName: targetPage.name };

      } catch (err) {
        const errDetails = err.response?.data || err.message;
        console.error('❌ [Facebook Reel Error]:', errDetails);
        return { success: false, error: errDetails };
      }
    }

    // Sequentially run all three (one at a time) to keep peak memory low
    const igResult = await runInstagramTask();
    const ytResult = await runYoutubeTask();
    const fbResult = await runFacebookReelTask();

    if (cloudinaryPublicId) {
      try { await cloudinary.uploader.destroy(cloudinaryPublicId, { resource_type: 'video' }); } catch (e) {}
    }

    console.log(`✅ [REEL SERVICE] Process Complete! IG: ${igResult.success}, YT: ${ytResult.success}, FB: ${fbResult.success}`);
    res.json({ success: true, instagram: igResult, youtube: ytResult, facebook: fbResult });

  } catch (err) {
    console.error(`❌ [REEL SERVICE] Error:`, err.message);
    res.status(500).json({ error: err.message });
  } finally {
    [tempImgPath, tempOutputPath, customAudioPath].forEach(filePath => {
      if (filePath && fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch (e) {}
      }
    });
    isReelJobRunning = false;
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

    console.error("❌ LinkedIn Response:", response.status, data);
    res.status(response.status).send(data);

  } catch (err) {
    console.error("❌ Error posting to LinkedIn:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- Facebook Page Route (Auto-detects Page & Token) ---
app.post('/api/send-facebook', requireApiKey, async (req, res) => {
  const { imageUrl, message, link } = req.body;
  const systemUserToken = process.env.INSTAGRAM_ACCESS_TOKEN;

  if (!systemUserToken) {
    return res.status(400).json({ error: 'INSTAGRAM_ACCESS_TOKEN is missing in .env' });
  }

  try {
    // 1. System User se linked Pages aur unke Access Tokens fetch karo
    const accountsRes = await axios.get(
      `https://graph.facebook.com/v22.0/me/accounts?access_token=${systemUserToken}`
    );

    const pages = accountsRes.data.data;
    if (!pages || pages.length === 0) {
      return res.status(404).json({
        error: 'No Facebook Pages found associated with this System User. Check Assigned Assets in Business Suite.'
      });
    }

    // Configured Page ID match karo, ya pehla available page le lo
    const targetPageId = process.env.FB_PAGE_ID || process.env.FACEBOOK_PAGE_ID;
    const targetPage = targetPageId
      ? pages.find(p => p.id === targetPageId) || pages[0]
      : pages[0];

    const pageAccessToken = targetPage.access_token;
    const activePageId = targetPage.id;

    // 2. Page par post publish karo
    let fbEndpoint = `https://graph.facebook.com/v22.0/${activePageId}/feed`;
    let payload = {
      message: message || "Govt Exam Study Updates 🚀",
      access_token: pageAccessToken
    };

    if (imageUrl) {
      fbEndpoint = `https://graph.facebook.com/v22.0/${activePageId}/photos`;
      payload = {
        url: imageUrl,
        caption: message || "Govt Exam Study Updates 🚀",
        access_token: pageAccessToken
      };
    } else if (link) {
      payload.link = link;
    }

    const postRes = await axios.post(fbEndpoint, payload);
    console.log('✅ Facebook Page post published successfully:', postRes.data.id || postRes.data.post_id);
    res.json({
      success: true,
      pageName: targetPage.name,
      pageId: activePageId,
      postId: postRes.data.id || postRes.data.post_id
    });

  } catch (err) {
    const errorData = err.response?.data || err.message;
    console.error('❌ Facebook Page post error:', errorData);
    res.status(500).json({ error: errorData });
  }
});

// --- Quora Formatter & Telegram Dispatch Route ---
app.post('/api/send-quora-dispatch', requireApiKey, async (req, res) => {
  const { title, summary, eligibility, applyUrl } = req.body;

  if (!title) {
    return res.status(400).json({ error: 'title is required' });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
  const quoraSpaceUrl = process.env.QUORA_SPACE_URL || 'https://www.quora.com';

  if (!botToken || !chatId) {
    return res.status(400).json({
      error: 'TELEGRAM_BOT_TOKEN or TELEGRAM_ADMIN_CHAT_ID missing in .env'
    });
  }

  // Quora Copy-Paste Content
  const quoraPostText = `📢 ${title}\n\n` +
    `📌 Key Details & Eligibility:\n${eligibility || 'Check official guidelines for eligibility.'}\n\n` +
    `📝 Brief Summary:\n${summary || 'Latest government recruitment update.'}\n\n` +
    `🔗 Apply Online & Official Notification:\n${applyUrl || 'https://www.sarkariresultlive.site'}`;

  // Telegram Display Message using HTML (No parse crashes)
  const tgMessage = `🚀 <b>New Post Ready for Quora Space!</b>\n\n<pre>${quoraPostText}</pre>`;

  try {
    const tgPayload = {
      chat_id: chatId,
      text: tgMessage,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🌐 Open Quora Space', url: quoraSpaceUrl }]
        ]
      }
    };

    const response = await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, tgPayload);
    console.log('✅ Quora dispatch card successfully sent to Admin Telegram!');

    return res.json({
      success: true,
      messageId: response.data.result.message_id,
      formattedText: quoraPostText
    });
  } catch (err) {
    const errorDetails = err.response?.data || err.message;
    console.error('❌ Telegram Dispatch Error:', errorDetails);
    return res.status(500).json({ error: 'Failed to send Telegram card', details: errorDetails });
  }
});

app.listen(process.env.PORT || 4600, () => {
  console.log(`WhatsApp Broadcast Service running on port ${process.env.PORT || 4600}`);
  initWhatsApp();
});