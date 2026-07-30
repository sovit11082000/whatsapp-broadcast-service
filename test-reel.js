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
    console.log("🚀 Testing Layout: Centered Dark White Bold Title (Size 25) + MP4 Anim (No Logo)...\n");

    const testImageUrl = 'https://gstatic.com/webp/gallery/1.webp'; 
    const tempImgPath = path.join(__dirname, 'test-input.webp');
    const outputPath = path.join(__dirname, 'output-final-reel.mp4');
    
    const templatePath = path.join(__dirname, 'assets/reel-template.webp');
    const animVideoPath = path.join(__dirname, 'assets/follow-anim.mp4');

    try {
        if (!fs.existsSync(templatePath)) {
            console.error("❌ Error: assets/reel-template.webp nahi mila!");
            return;
        }

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

        // Input 0: Dark Base Canvas (1080x1920)
        command.input('color=c=0x0f172a:s=1080x1920:d=9').inputFormat('lavfi');
        
        // Input 1: Job Image (reel-template.webp)
        command.input(templatePath).inputOptions(['-loop 1']);

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
            // Step 1: Scale Job Image to 99% (1069px) & Center in canvas
            "[1:v]scale=1069:-1:force_original_aspect_ratio=decrease[scaled_job_img]",
            "[0:v][scaled_job_img]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2[bg_with_job]"
        ];

        let lastVideoNode = "[bg_with_job]";

        // Step 2: Center Top Title - "Govt Exam Study"
        // Dark White/Off-White (#E2E8F0), Font Size 25, Transparent Background with Subtle Shadow Box
        filterComplex.push(
            `${lastVideoNode}drawtext=text='Govt Exam Study':fontcolor='#D1D5DB':fontsize=90:x=(1080-tw)/2:y=150:borderw=3:bordercolor='#D1D5DB':box=1:boxcolor=black@0.0:boxborderw=0[v_with_title]`
        );
        lastVideoNode = "[v_with_title]";

        // Step 3: Bottom Subscribe MP4 Animation
        if (hasAnim) {
            filterComplex.push(`[2:v]colorkey=0x000000:0.15:0.1,scale=600:-1[keyed_anim]`);
            filterComplex.push(`${lastVideoNode}[keyed_anim]overlay=(main_w-overlay_w)/2:1500[v_with_anim]`);
            lastVideoNode = "[v_with_anim]";
        }

        command.complexFilter(filterComplex);

        const audioInputIndex = hasAnim ? 3 : 2;

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