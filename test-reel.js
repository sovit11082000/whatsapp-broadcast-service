const fs = require('fs');
const path = require('path');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegPath);

// --- CREDENTIALS & POST DETAILS ---
const INSTAGRAM_ACCOUNT_ID = '17841448348401608';
const ACCESS_TOKEN = 'YOUR_ACCESS_TOKEN_HERE'; // Yahan apna Token paste karo

const POST_IMAGE_URL = 'https://res.cloudinary.com/exgupwgz/image/upload/v1788078529/govtexam_posts/ntl4nknyveebxkndc5pk.webp';
const POST_LINK = 'https://www.sarkariresultlive.site/gujarat-police-lokrakshak-cadre-recruitment-2026-27';

const CAPTION = `🚨 Gujarat Police Lokrakshak Cadre Recruitment 2026-27

📢 Total Vacancies: 3,000 Posts (UPC, APC, SRPF)
🎓 Qualification: 12th Pass (Higher Secondary)
🏃‍♂️ Physical Test (PET): Dec 2026 / Jan 2027
📝 Written Exam: March / April 2027

🔗 Full Details & Apply Online:
${POST_LINK}

#GujaratPolice #Lokrakshak #SarkariResult #GovtJobs2026 #PoliceBharti`;

// --- HELPER: FILE DOWNLOAD ---
const downloadFile = async (url, outputPath) => {
    const writer = fs.createWriteStream(outputPath);
    const response = await axios({ url, method: 'GET', responseType: 'stream' });
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
};

// --- HELPER: PUBLISH TO INSTAGRAM REELS (CLOUDINARY / HOSTED URL) ---
async function uploadReelToInstagram(videoUrl) {
    try {
        console.log("\n🚀 Uploading Reel to Instagram...");

        // 1. Create Media Container for Reel
        const containerRes = await axios.post(
            `https://graph.facebook.com/v20.0/${INSTAGRAM_ACCOUNT_ID}/media`,
            {
                media_type: 'REELS',
                video_url: videoUrl,
                caption: CAPTION,
                access_token: ACCESS_TOKEN
            }
        );

        const creationId = containerRes.data.id;
        console.log("✅ Reel Container Created ID:", creationId);

        // 2. Wait for Instagram to process the video (Poll Status)
        let isReady = false;
        let attempts = 0;
        while (!isReady && attempts < 10) {
            await new Promise((resolve) => setTimeout(resolve, 5000));
            const statusRes = await axios.get(
                `https://graph.facebook.com/v20.0/${creationId}?fields=status_code&access_token=${ACCESS_TOKEN}`
            );
            const status = statusRes.data.status_code;
            console.log(`⏳ Video processing status: ${status}...`);

            if (status === 'FINISHED') {
                isReady = true;
            } else if (status === 'ERROR') {
                throw new Error("Instagram failed to process the video");
            }
            attempts++;
        }

        // 3. Publish Reel
        const publishRes = await axios.post(
            `https://graph.facebook.com/v20.0/${INSTAGRAM_ACCOUNT_ID}/media_publish`,
            {
                creation_id: creationId,
                access_token: ACCESS_TOKEN
            }
        );

        console.log("🎉 REEL SUCCESSFULLY PUBLISHED TO INSTAGRAM!");
        console.log("📌 Post ID:", publishRes.data.id);

    } catch (err) {
        console.error("❌ Instagram Reels Upload Error:", err.response?.data || err.message);
    }
}

// --- MAIN GENERATOR FUNCTION ---
async function testFinalReelLayout() {
    console.log("🚀 Starting Reel Creation for Gujarat Police Lokrakshak 2026-27...\n");

    const tempImgPath = path.join(__dirname, 'test-input.webp');
    const outputPath = path.join(__dirname, 'output-final-reel.mp4');
    
    const logoPath = path.join(__dirname, 'assets/logo.png');
    const animVideoPath = path.join(__dirname, 'assets/follow-anim.mp4');

    try {
        console.log("📥 Downloading Post Image from Cloudinary...");
        await downloadFile(POST_IMAGE_URL, tempImgPath);

        // Music Selection
        const musicDir = path.join(__dirname, 'assets/music');
        let selectedAudioPath = null;
        if (fs.existsSync(musicDir)) {
            const files = fs.readdirSync(musicDir).filter(f => f.endsWith('.mp3'));
            if (files.length > 0) selectedAudioPath = path.join(musicDir, files[0]);
        }

        if (selectedAudioPath) console.log("🎵 Music attached:", path.basename(selectedAudioPath));

        console.log("🎬 Constructing FFmpeg Command...");
        let command = ffmpeg();

        // Input 0: Primary Job Image
        command.input(tempImgPath).inputOptions(['-loop 1']);

        // Input 1: Top Header Logo PNG (If available)
        let hasLogo = fs.existsSync(logoPath);
        if (hasLogo) {
            console.log("🎨 Logo found: assets/logo.png");
            command.input(logoPath).inputOptions(['-loop 1']);
        }

        // Input 2: Subscribe MP4 Animation Video
        let hasAnim = fs.existsSync(animVideoPath);
        if (hasAnim) {
            console.log("✨ Subscribe Animation found: assets/follow-anim.mp4");
            command.input(animVideoPath).inputOptions(['-stream_loop -1']); 
        }

        if (selectedAudioPath) {
            command.input(selectedAudioPath);
        }

        // --- FILTER COMPLEX ---
        let filterComplex = [
            "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,avgblur=sizeX=30:sizeY=30[bg]",
            "[0:v]scale=1069:-1:force_original_aspect_ratio=decrease[scaled_job_img]",
            "[bg][scaled_job_img]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2[bg_with_job]"
        ];

        let lastVideoNode = "[bg_with_job]";
        let currentInputIndex = 1;

        // Step 2: Overlay Logo at Top Header
        if (hasLogo) {
            filterComplex.push(`[${currentInputIndex}:v]scale=600:-1[scaled_logo]`);
            filterComplex.push(`${lastVideoNode}[scaled_logo]overlay=(main_w-overlay_w)/2:120[v_with_logo]`);
            lastVideoNode = "[v_with_logo]";
            currentInputIndex++;
        }

        // Step 3: Bottom Subscribe MP4 Animation
        if (hasAnim) {
            filterComplex.push(`[${currentInputIndex}:v]colorkey=0x000000:0.15:0.1,scale=600:-1[keyed_anim]`);
            filterComplex.push(`${lastVideoNode}[keyed_anim]overlay=(main_w-overlay_w)/2:1500[v_with_anim]`);
            lastVideoNode = "[v_with_anim]";
            currentInputIndex++;
        }

        command.complexFilter(filterComplex);

        const audioInputIndex = currentInputIndex;

        if (selectedAudioPath) {
            command.outputOptions([
                '-map', lastVideoNode,
                '-map', `${audioInputIndex}:a`,
                '-c:a', 'aac',
                '-b:a', '128k',
                '-shortest'
            ]);
        } else {
            command.outputOptions([
                '-map', lastVideoNode
            ]);
        }

        command.outputOptions([
            '-c:v', 'libx264',
            '-pix_fmt', 'yuv420p',
            '-t', '9',
            '-preset', 'ultrafast'
        ]);

        command.output(outputPath);

        command.on('start', (cmd) => console.log("\n🔧 Executing FFmpeg Command:\n", cmd, "\n"));

        command.on('end', async () => {
            console.log("\n🎉 PERFECT REEL GENERATED LOCALLY!");
            console.log("📁 Video Output:", outputPath);
            
            if (fs.existsSync(tempImgPath)) fs.unlinkSync(tempImgPath);

            // NOTE: Instagram API requires a publicly accessible HTTPS video URL (e.g. Cloudinary/S3).
            // Agar aap local video ko pehle Cloudinary par upload karte hain, toh uska URL yahan pass karein:
            // await uploadReelToInstagram(uploadedCloudinaryVideoUrl);
        });

        command.on('error', (err) => {
            console.error("\n❌ FFmpeg Error:", err.message);
            if (fs.existsSync(tempImgPath)) fs.unlinkSync(tempImgPath);
        });

        command.run();

    } catch (err) {
        console.error("❌ Test Script Error:", err.message);
    }
}

testFinalReelLayout();