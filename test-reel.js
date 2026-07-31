const fs = require('fs');
const path = require('path');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegPath);

const downloadFile = async (url, outputPath) => {
    const writer = fs.createWriteStream(outputPath);
    const response = await axios({ url, method: 'GET', responseType: 'stream' });
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
};

async function testFinalReelLayout() {
    console.log("🚀 Testing Layout: Blur BG + Center Job Poster + Logo Overlay + MP4 Anim...\n");

    const testImageUrl = 'https://gstatic.com/webp/gallery/1.webp'; 
    const tempImgPath = path.join(__dirname, 'test-input.webp');
    const outputPath = path.join(__dirname, 'output-final-reel.mp4');
    
    const logoPath = path.join(__dirname, 'assets/logo.png');
    const animVideoPath = path.join(__dirname, 'assets/follow-anim.mp4');

    try {
        console.log("📥 Downloading test image...");
        await downloadFile(testImageUrl, tempImgPath);

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

        // Input 0: Primary Job Image (For BG Blur & Center Image)
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
        // Step 1: Create 1080x1920 Blurred Background + Overlay Center Scaled Image
        let filterComplex = [
            "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,avgblur=sizeX=30:sizeY=30[bg]",
            "[0:v]scale=1069:-1:force_original_aspect_ratio=decrease[scaled_job_img]",
            "[bg][scaled_job_img]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2[bg_with_job]"
        ];

        let lastVideoNode = "[bg_with_job]";
        let currentInputIndex = 1;

        // Step 2: Overlay Logo at Top Header
        if (hasLogo) {
            // Scale logo to width ~600px maintaining aspect ratio
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

        command.on('end', () => {
            console.log("\n🎉 PERFECT REEL GENERATED!");
            console.log("📁 Video Output:", outputPath);
            
            if (fs.existsSync(tempImgPath)) fs.unlinkSync(tempImgPath);
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