// =================================================================
// ==                 YOUTUBE DOWNLOADER - BACKEND                ==
// =================================================================
// == Phase 1: Server Setup, Format Selection, and Download Logic ==
// =================================================================

// -----------------------------------------------------------------
// 1. IMPORT NECESSARY MODULES
// -----------------------------------------------------------------
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const { spawn, exec } = require('child_process'); // Use 'spawn' for long-running processes to get real-time output
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid'); // For generating unique IDs for download jobs
const sanitize = require('sanitize-filename'); // To clean up filenames for downloaded videos

// -----------------------------------------------------------------
// 2. INITIALIZE APP AND SERVER
// -----------------------------------------------------------------
const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*", // IMPORTANT: For development, '*' is fine. For production, restrict to your frontend's domain.
    methods: ["GET", "POST"]
  }
});

// Create a directory for temporary downloads if it doesn't exist
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

// Store ongoing download jobs with their WebSocket connections
const activeDownloads = {};

// -----------------------------------------------------------------
// 3. MIDDLEWARE CONFIGURATION
// -----------------------------------------------------------------
app.use(cors());
app.use(express.json());

// Serve static files from the 'downloads' directory
app.use('/downloads', express.static(DOWNLOAD_DIR, {
  // Optional: configure maxAge for caching static files
  maxAge: '1h'
}));

// -----------------------------------------------------------------
// 4. HELPER FUNCTIONS
// -----------------------------------------------------------------

/**
 * Cleans up temporary download files associated with a job.
 * @param {string} jobId - The ID of the download job.
 */
function cleanupJobFiles(jobId) {
    const jobDownloadPath = path.join(DOWNLOAD_DIR, jobId);
    if (fs.existsSync(jobDownloadPath)) {
        fs.rmSync(jobDownloadPath, { recursive: true, force: true });
        console.log(`Cleaned up files for job: ${jobId}`);
    }
    // Remove the job from activeDownloads after a delay (e.g., to allow download)
    delete activeDownloads[jobId];
}

/**
 * Handles the actual download and merging process.
 * This function will be called asynchronously to prevent blocking the main thread.
 * @param {string} youtubeUrl - The URL of the YouTube video.
 * @param {string} videoFormatId - The format ID for the video stream.
 * @param {string} audioFormatId - The format ID for the audio stream.
 * @param {string} jobId - The unique ID for this download job.
 * @param {string} originalTitle - The original title of the video.
 * @param {object} socket - The Socket.IO socket object to emit progress.
 */
async function processDownload(youtubeUrl, videoFormatId, audioFormatId, jobId, originalTitle, socket) {
    const safeTitle = sanitize(originalTitle || jobId); // Sanitize title for filename
    const jobDownloadPath = path.join(DOWNLOAD_DIR, jobId);
    const finalOutputFileName = `${safeTitle}.mp4`; // Always merge to MP4 for consistency
    let finalOutputPath = path.join(jobDownloadPath, finalOutputFileName); // Changed to `let` for reassignment

    // Create a specific directory for this job's temporary files
    if (!fs.existsSync(jobDownloadPath)) {
        fs.mkdirSync(jobDownloadPath, { recursive: true });
    }

    // Update initial status
    if (activeDownloads[jobId]) {
        activeDownloads[jobId].status = 'preparing';
        socket.emit('downloadStatus', { status: 'preparing', message: 'Preparing download...', progress: 5 });
    } else {
        console.warn(`Job ${jobId} not found in activeDownloads. Client likely disconnected early.`);
        cleanupJobFiles(jobId);
        return;
    }

    try {
        let videoFile = path.join(jobDownloadPath, `${jobId}_video`);
        let audioFile = path.join(jobDownloadPath, `${jobId}_audio`);
        
        // Handle audio-only downloads
        if (!videoFormatId && audioFormatId) {
            videoFile = null; // No video component
            audioFile = path.join(jobDownloadPath, `${jobId}_audio_only.%(ext)s`); // Use %(ext)s for audio only
        }

        // --- Step 1: Download Video Stream (if video format provided) ---
        if (videoFormatId) {
            socket.emit('downloadStatus', { status: 'downloading_video', message: 'Downloading video stream...', progress: 10 });
            const ytDlpVideoCommand = `yt-dlp -f ${videoFormatId} -o "${videoFile}.%(ext)s" "${youtubeUrl}"`;
            console.log(`Downloading video: ${ytDlpVideoCommand}`);
            await new Promise((resolve, reject) => {
                const videoProcess = spawn('yt-dlp', ['-f', videoFormatId, '-o', `${videoFile}.%(ext)s`, youtubeUrl], { cwd: jobDownloadPath });

                videoProcess.stdout.on('data', (data) => {
                    const output = data.toString();
                    // Basic progress parsing (can be more sophisticated)
                    const progressMatch = output.match(/\[download\]\s+(\d+\.\d+)%/);
                    if (progressMatch && activeDownloads[jobId]) {
                        const progress = parseFloat(progressMatch[1]);
                        const scaledProgress = 10 + (progress * 0.4); // Scale to 10-50% for video download
                        activeDownloads[jobId].progress = scaledProgress;
                        socket.emit('downloadStatus', { status: 'downloading_video', message: `Downloading video stream: ${progress.toFixed(1)}%`, progress: scaledProgress });
                    }
                    console.log(`[video-dlp] ${output.trim()}`);
                });

                videoProcess.stderr.on('data', (data) => {
                    console.error(`[video-dlp-err] ${data.toString().trim()}`);
                });

                videoProcess.on('close', (code) => {
                    if (code === 0) {
                        const actualVideoFile = fs.readdirSync(jobDownloadPath).find(f => f.startsWith(`${jobId}_video`));
                        if (actualVideoFile) {
                            videoFile = path.join(jobDownloadPath, actualVideoFile);
                            resolve();
                        } else {
                            reject(new Error("Video file not found after download."));
                        }
                    } else {
                        reject(new Error(`yt-dlp video download failed with code ${code}`));
                    }
                });
            });
            if (activeDownloads[jobId]) {
              activeDownloads[jobId].progress = 50;
              socket.emit('downloadStatus', { status: 'downloading_video_complete', message: 'Video download complete!', progress: 50 });
            }
        }


        // --- Step 2: Download Audio Stream (if audio format provided) ---
        if (audioFormatId) {
            socket.emit('downloadStatus', { status: 'downloading_audio', message: 'Downloading audio stream...', progress: videoFormatId ? 55 : 10 });
            const ytDlpAudioCommand = `yt-dlp -f ${audioFormatId} -o "${audioFile}.%(ext)s" "${youtubeUrl}"`;
            console.log(`Downloading audio: ${ytDlpAudioCommand}`);
            await new Promise((resolve, reject) => {
                const audioProcess = spawn('yt-dlp', ['-f', audioFormatId, '-o', `${audioFile}.%(ext)s`, youtubeUrl], { cwd: jobDownloadPath });

                audioProcess.stdout.on('data', (data) => {
                    const output = data.toString();
                    const progressMatch = output.match(/\[download\]\s+(\d+\.\d+)%/);
                    if (progressMatch && activeDownloads[jobId]) {
                        const progress = parseFloat(progressMatch[1]);
                        const scaledProgress = videoFormatId ? (50 + (progress * 0.25)) : (10 + (progress * 0.8)); // Scale for audio download
                        activeDownloads[jobId].progress = scaledProgress;
                        socket.emit('downloadStatus', { status: 'downloading_audio', message: `Downloading audio stream: ${progress.toFixed(1)}%`, progress: scaledProgress });
                    }
                    console.log(`[audio-dlp] ${output.trim()}`);
                });

                audioProcess.stderr.on('data', (data) => {
                    console.error(`[audio-dlp-err] ${data.toString().trim()}`);
                });

                audioProcess.on('close', (code) => {
                    if (code === 0) {
                        const actualAudioFile = fs.readdirSync(jobDownloadPath).find(f => f.startsWith(`${jobId}_audio`));
                        if (actualAudioFile) {
                            audioFile = path.join(jobDownloadPath, actualAudioFile);
                            resolve();
                        } else {
                            reject(new Error("Audio file not found after download."));
                        }
                    } else {
                        reject(new Error(`yt-dlp audio download failed with code ${code}`));
                    }
                });
            });
            if (activeDownloads[jobId]) {
              activeDownloads[jobId].progress = videoFormatId ? 75 : 90;
              socket.emit('downloadStatus', { status: 'downloading_audio_complete', message: 'Audio download complete!', progress: activeDownloads[jobId].progress });
            }
        }

        // --- Step 3: Merge Video and Audio (if both exist) or rename audio-only ---
        if (videoFile && audioFile && videoFile !== null && audioFile !== null) { // Ensure both are explicitly not null
            socket.emit('downloadStatus', { status: 'merging_files', message: 'Merging video and audio...', progress: 80 });
            console.log(`Merging video: ${videoFile} and audio: ${audioFile} into ${finalOutputPath}`);
            await new Promise((resolve, reject) => {
                const ffmpegProcess = spawn('ffmpeg', ['-i', videoFile, '-i', audioFile, '-c:v', 'copy', '-c:a', 'aac', finalOutputPath], { cwd: jobDownloadPath });

                ffmpegProcess.stderr.on('data', (data) => {
                    const output = data.toString();
                    // Basic progress parsing (FFmpeg progress parsing is complex)
                    const timeMatch = output.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
                    if (timeMatch && activeDownloads[jobId]) {
                        // For a simple progress, we can roughly estimate based on video duration or just show "merging"
                        socket.emit('downloadStatus', { status: 'merging_files', message: `Merging: ${timeMatch[1]}`, progress: 80 + Math.random() * 10 }); // Random small increment
                    }
                    console.error(`[ffmpeg-err] ${output.trim()}`);
                });

                ffmpegProcess.on('close', (code) => {
                    if (code === 0) {
                        resolve();
                    } else {
                        reject(new Error(`FFmpeg merging failed with code ${code}`));
                    }
                });
            });
            // Clean up individual video and audio files
            fs.unlinkSync(videoFile);
            fs.unlinkSync(audioFile);
            console.log("Temporary video and audio files deleted.");
        } else if (audioFile && !videoFormatId) { // Audio-only scenario
            // Rename the downloaded audio file to the final output name
            const finalAudioOutputPath = path.join(jobDownloadPath, `${safeTitle}.${path.extname(audioFile).substring(1)}`);
            fs.renameSync(audioFile, finalAudioOutputPath);
            finalOutputPath = finalAudioOutputPath; // Update final path
            console.log(`Audio-only file renamed to ${finalAudioOutputPath}`);
        } else if (videoFile && !audioFormatId) { // Video-only (no audio specified, though our logic aims for combined)
             const finalVideoOutputPath = path.join(jobDownloadPath, `${safeTitle}.${path.extname(videoFile).substring(1)}`);
             fs.renameSync(videoFile, finalVideoOutputPath);
             finalOutputPath = finalVideoOutputPath;
             console.log(`Video-only file renamed to ${finalVideoOutputPath}`);
        } else {
            throw new Error("No valid video or audio file to process.");
        }


        // --- Step 4: Finalize and Send Download Link ---
        if (activeDownloads[jobId]) {
            const finalDownloadLink = `/downloads/${jobId}/${finalOutputFileName}`; // Relative URL for static serve
            activeDownloads[jobId].status = 'complete';
            activeDownloads[jobId].downloadUrl = finalDownloadLink;
            activeDownloads[jobId].progress = 100;
            socket.emit('downloadStatus', {
                status: 'complete',
                message: 'Download ready!',
                progress: 100,
                downloadUrl: finalDownloadLink
            });
            console.log(`Download job ${jobId} completed. Download URL: ${finalDownloadLink}`);
        }

    } catch (err) {
        console.error(`Error during download process for job ${jobId}: ${err.message}`);
        if (activeDownloads[jobId]) {
            activeDownloads[jobId].status = 'error';
            activeDownloads[jobId].error = err.message;
            socket.emit('downloadStatus', { status: 'error', message: `Error: ${err.message}`, error: err.message, progress: 0 });
        }
    } finally {
        // Schedule cleanup for job files after a reasonable time (e.g., 1 hour)
        // This gives the user time to download the file.
        setTimeout(() => cleanupJobFiles(jobId), 3600 * 1000); // 1 hour
    }
}


// -----------------------------------------------------------------
// 5. API ROUTES
// -----------------------------------------------------------------

// A simple test route to make sure the server is running
app.get('/', (req, res) => {
  res.send('<h1>YouTube Downloader Backend</h1><p>Server is up and running!</p>');
});

/**
 * API Endpoint: /api/getVideoInfo
 * Method: POST
 * Body: { "url": "https://www.youtube.com/watch?v=..." }
 * Description: Fetches available video and audio formats from a YouTube URL.
 */
app.post('/api/getVideoInfo', (req, res) => {
    const youtubeUrl = req.body.url;

    if (!youtubeUrl) {
        return res.status(400).json({ success: false, error: "YouTube URL is required." });
    }

    // Command to execute: yt-dlp to get all formats in JSON format
    // --dump-json outputs the video information in JSON format.
    // -S "res,ext:mp4:m4a" sorts formats by resolution, prioritizing mp4/m4a.
    // --compat-options no-youtube-html5-player-quality prevents issues with YouTube changing quality.
    const command = `yt-dlp --dump-json -S "res,ext:mp4:m4a" "${youtubeUrl}"`;
    console.log(`Executing: ${command}`);

    // Increased maxBuffer for large JSON responses from yt-dlp
    exec(command, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
        if (error) {
            console.error(`exec error for getVideoInfo: ${error.message}`);
            // Explicitly check for yt-dlp specific errors like "no such video"
            if (stderr.includes("no such video") || stderr.includes("private video") || stderr.includes("unavailable")) {
                return res.status(404).json({ success: false, error: "Video not found, private, or unavailable." });
            }
            return res.status(500).json({ success: false, error: `Error fetching video info: ${error.message}` });
        }
        if (stderr) {
            // yt-dlp often outputs warnings to stderr, but still works. Log them.
            console.warn(`yt-dlp stderr (warnings likely): ${stderr}`);
        }

        try {
            const videoInfo = JSON.parse(stdout);
            const formats = videoInfo.formats;

            const availableOptions = [];
            let bestOverallAudioFormat = null;

            // Find the best overall audio stream once
            const audioOnlyFormats = formats.filter(f => f.acodec !== 'none' && f.vcodec === 'none' && f.abr && f.ext !== 'mhtml')
                                       .sort((a, b) => b.abr - a.abr);
            if (audioOnlyFormats.length > 0) {
                bestOverallAudioFormat = audioOnlyFormats[0];
            }


            // Filter for high-quality video-only streams (no audio component)
            // We want formats that clearly specify video and no audio.
            // Also filter out 'storyboard' or 'mhtml' formats that are not actual video.
            const videoOnlyFormatsCandidates = formats.filter(f => 
                f.vcodec !== 'none' && f.acodec === 'none' && f.height && f.ext !== 'mhtml' && f.protocol !== 'm3u8_native'
            );

            // Deduplicate by resolution, prioritizing mp4
            const seenResolutions = new Set();
            const videoOnlyFormatsSorted = [];

            videoOnlyFormatsCandidates.sort((a, b) => {
                // Sort by height descending
                if (b.height !== a.height) return b.height - a.height;
                // Then prefer mp4 over webm
                if (a.ext === 'mp4' && b.ext !== 'mp4') return -1;
                if (a.ext !== 'mp4' && b.ext === 'mp4') return 1;
                // Finally, by FPS descending
                return (b.fps || 0) - (a.fps || 0);
            }).forEach(f => {
                // Only add if this resolution hasn't been added yet for a preferred codec
                if (!seenResolutions.has(f.height)) {
                    videoOnlyFormatsSorted.push(f);
                    seenResolutions.add(f.height);
                }
            });


            videoOnlyFormatsSorted.forEach(vFormat => {
                if (bestOverallAudioFormat) {
                    availableOptions.push({
                        quality: `${vFormat.height}p${vFormat.fps ? ' ' + vFormat.fps + 'fps' : ''}`,
                        resolution: `${vFormat.width}x${vFormat.height}`,
                        videoFormatId: vFormat.format_id,
                        audioFormatId: bestOverallAudioFormat.format_id,
                        fileExtension: 'mp4', // We will merge video + audio into MP4
                        combinedFormatName: `MP4 - ${vFormat.height}p (Video + Audio)`
                    });
                }
            });

            // Add a direct audio download option (highest quality)
            if (bestOverallAudioFormat) {
                availableOptions.push({
                    quality: `Audio Only - ${bestOverallAudioFormat.ext.toUpperCase()} ${bestOverallAudioFormat.abr ? bestOverallAudioFormat.abr.toFixed(0) + 'kbps' : ''}`,
                    resolution: 'audio',
                    videoFormatId: null, // Indicate audio only
                    audioFormatId: bestOverallAudioFormat.format_id,
                    fileExtension: bestOverallAudioFormat.ext,
                    combinedFormatName: `Audio Only - ${bestOverallAudioFormat.ext.toUpperCase()}`
                });
            }

            res.json({
                success: true,
                title: videoInfo.title,
                thumbnail: videoInfo.thumbnail,
                duration: videoInfo.duration_string,
                uploader: videoInfo.uploader,
                videoId: videoInfo.id,
                availableOptions: availableOptions
            });

        } catch (parseError) {
            console.error(`JSON parse error in getVideoInfo: ${parseError.message}`);
            res.status(500).json({ success: false, error: "Failed to parse video information from yt-dlp. Invalid URL or video unavailable." });
        }
    });
});

/**
 * API Endpoint: /api/downloadVideo
 * Method: POST
 * Body: { "youtubeUrl": "...", "videoFormatId": "...", "audioFormatId": "...", "jobId": "...", "title": "..." }
 * Description: Initiates the download and merging process for a selected video format.
 */
app.post('/api/downloadVideo', (req, res) => {
    const { youtubeUrl, videoFormatId, audioFormatId, jobId, title } = req.body;

    if (!youtubeUrl || !jobId || !title) {
        return res.status(400).json({ success: false, error: "Missing required parameters for download." });
    }
    // A format ID is needed for either video or audio
    if (!videoFormatId && !audioFormatId) {
        return res.status(400).json({ success: false, error: "At least a video or audio format ID is required." });
    }

    console.log(`Download initiated for job ID: ${jobId}`);
    console.log(`URL: ${youtubeUrl}, Video Format: ${videoFormatId}, Audio Format: ${audioFormatId}, Title: ${title}`);

    // Store the job details, associating it with the socket ID.
    // This allows us to retrieve job info if the client reconnects or for cleanup.
    activeDownloads[jobId] = {
        status: 'queued',
        progress: 0,
        downloadUrl: null,
        error: null,
        title: title,
        youtubeUrl: youtubeUrl,
        videoFormatId: videoFormatId,
        audioFormatId: audioFormatId,
        timestamp: Date.now(),
        // We will store the actual socket reference once it connects to the room
    };

    // Immediately respond to the client that the job has been accepted.
    // The actual processing will happen in the background.
    res.json({ success: true, message: "Download job queued. Connect via WebSocket for updates.", jobId: jobId });

    // Start the asynchronous download process
    // We pass `null` for the socket here, as the socket.io 'connection' handler
    // will get the socket reference when the frontend joins the room.
    // The `processDownload` function will then retrieve the actual socket
    // from `io.to(jobId)` for emitting updates.
    // For now, we're passing a dummy socket object that can emit, as `io.to(jobId)` might not be immediately available
    // if the client hasn't joined the room yet.
    // A better approach for production would be a dedicated job queue.
    const dummySocket = {
        emit: (event, data) => {
            // Attempt to emit to the room, if connected
            if (io.sockets.adapter.rooms.has(jobId)) {
                io.to(jobId).emit(event, data);
            } else {
                // If not connected, just log or queue for later
                // console.log(`[Socket.IO Queue - ${jobId}] Emitting ${event}:`, data.status, data.message);
                // For now, we assume the client will connect shortly and get the latest status on joinRoom.
            }
        }
    };
    processDownload(youtubeUrl, videoFormatId, audioFormatId, jobId, title, dummySocket);
});


// -----------------------------------------------------------------
// 6. SOCKET.IO CONNECTION HANDLING
// -----------------------------------------------------------------

io.on('connection', (socket) => {
  console.log(`A user connected with socket ID: ${socket.id}`);

  // A client will emit a 'joinRoom' event to associate with a specific download job
  socket.on('joinRoom', (jobId) => {
    socket.join(jobId);
    console.log(`Socket ${socket.id} joined room ${jobId}`);

    // If there's an existing job, send its current status
    // This is important for users who navigate directly to a download page
    // or refresh the page while a download is in progress.
    if (activeDownloads[jobId]) {
        socket.emit('downloadStatus', activeDownloads[jobId]);
    } else {
        // If the job isn't active, it might be an old/invalid ID or already completed/cleaned up
        socket.emit('downloadStatus', { status: 'error', message: 'Job not found or expired.', progress: 0 });
    }
  });

  socket.on('disconnect', () => {
    console.log(`User with socket ID: ${socket.id} disconnected`);
    // No specific action needed here for now, as `processDownload` handles cleanup.
    // In a more complex system, you might mark jobs as "awaiting reconnect" or similar.
  });
});


// -----------------------------------------------------------------
// 7. START THE SERVER
// -----------------------------------------------------------------
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

