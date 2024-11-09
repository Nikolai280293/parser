const fs = require('fs');
const fetch = require('node-fetch');
const path = require('path');
const { exec } = require('child_process');
const { transliterate } = require('transliteration');
const { SocksProxyAgent } = require('socks-proxy-agent');

const proxyUrl = 'socks5://<username>:<password>@<proxy_host>:<proxy_port>';
const proxyAgent = new SocksProxyAgent(proxyUrl);

const logPath = path.join(__dirname, 'log.txt');
const logStream = fs.createWriteStream(logPath, { flags: 'a' });

function log(message) {
    console.log(message);
    logStream.write(message + '\n');

    const stats = fs.statSync(logPath);
    if (stats.size > 1 * 1024 * 1024 * 1024) {
        logStream.close();
        fs.writeFileSync(logPath, '');
    }
}

function sanitizeFolderName(name) {
    return transliterate(name)
        .replace(/[<>:"/\\|?*.,\s]+/g, '_')
        .replace(/_+/g, '_')
        .trim();
}

function execPromise(command) {
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                reject(`Ошибка: ${error.message}`);
            } else if (stderr) {
                reject(`Ошибка: ${stderr}`);
            } else {
                resolve(stdout);
            }
        });
    }).catch(err => log(`Ошибка выполнения команды: ${err}`));
}

async function getChannelPlaylists(channelId, apiKey) {
    const url = `https://www.googleapis.com/youtube/v3/playlists?part=snippet&channelId=${channelId}&maxResults=50&key=${apiKey}`;
    const response = await fetch(url, { agent: proxyAgent });

    if (!response.ok) {
        throw new Error(`Ошибка сети: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    if (!data.items.length) {
        throw new Error(`Не найдено плейлистов для канала "${channelId}".`);
    }

    return data.items.map(item => ({
        id: item.id,
        title: item.snippet.title
    }));
}

async function getPlaylistItems(playlistId, apiKey) {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${playlistId}&key=${apiKey}`;
    const response = await fetch(url, { agent: proxyAgent });

    if (!response.ok) {
        throw new Error(`Ошибка сети: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    return data.items.map(item => ({
        title: item.snippet.title,
        description: item.snippet.description,
        publishedAt: item.snippet.publishedAt,
        videoId: item.snippet.resourceId.videoId,
        thumbnails: item.snippet.thumbnails,
    }));
}

async function getVideoDuration(videoId) {
    const command = `yt-dlp --get-duration "https://www.youtube.com/watch?v=${videoId}"`;
    const duration = await execPromise(command);
    return duration.trim();
}

async function checkTotalSize(baseDir) {
    let totalSize = 0;

    function calculateFolderSize(folder) {
        const files = fs.readdirSync(folder);
        for (const file of files) {
            const filePath = path.join(folder, file);
            const stats = fs.statSync(filePath);
            if (stats.isDirectory()) {
                calculateFolderSize(filePath);
            } else {
                totalSize += stats.size;
            }
        }
    }

    calculateFolderSize(baseDir);

    return totalSize / (1024 * 1024 * 1024);
}

async function downloadVideoWithProgress(video, playlistDir, downloadHistory, channelId, playlistId, playlistTitle, baseDir) {
    const totalSize = await checkTotalSize(baseDir);
    log(`🔸 Загружено: ${totalSize.toFixed(2)} GB в папке DownloadedChannels.`);

    if (totalSize >= 3) {
        log(`⛔ Превышен общий лимит в 3 ГБ. Загрузка остановлена.`);
        return;
    }

    const originalTitle = video.title;
    const sanitizedTitle = sanitizeFolderName(originalTitle);
    const transliteratedTitle = transliterate(sanitizedTitle);

    const videoDir = path.join(playlistDir, transliteratedTitle);
    fs.mkdirSync(videoDir, { recursive: true });

    const outputTemplate = path.join(videoDir, `${transliteratedTitle}.%(ext)s`);
    const command = `yt-dlp -f best -o "${outputTemplate}" "https://www.youtube.com/watch?v=${video.videoId}"`;

    log(`Скачивание видео: ${originalTitle}...`);
    const child = exec(command);

    child.stdout.on('data', (data) => {
        const output = data.toString();
        if (output.includes('download')) {
            log(output.trim());
        }
    });

    await new Promise((resolve, reject) => {
        child.on('close', (code) => {
            if (code !== 0) {
                reject(`Ошибка при скачивании видео: ${originalTitle}`);
            } else {
                resolve();
            }
        });
    });

    log(`✅ Видео "${originalTitle}" успешно загружено в "${videoDir}"`);

    const duration = await getVideoDuration(video.videoId);
    video.duration = duration;
    video.originalTitle = originalTitle;
    video.transliteratedTitle = transliteratedTitle;
    video.titlePlaylist = playlistTitle;

    let playlistHistory = downloadHistory[channelId].playlists.find(p => p.id === playlistId);

    if (!playlistHistory) {
        playlistHistory = { id: playlistId, videos: [] };
        downloadHistory[channelId].playlists.push(playlistHistory);
    }

    playlistHistory.videos.push(video);

    fs.writeFileSync('download_history.json', JSON.stringify(downloadHistory, null, 2));
}

async function downloadChannelsByRounds(channelIds, apiKey, baseDir) {
    const channelsData = [];

    for (const channelId of channelIds) {
        const playlists = await getChannelPlaylists(channelId, apiKey);
        channelsData.push({ channelId, playlists });
    }

    let downloadHistory = {};

    if (fs.existsSync('download_history.json')) {
        downloadHistory = JSON.parse(fs.readFileSync('download_history.json', 'utf-8'));
    }

    let playlistIndex = 0;
    let totalSize = await checkTotalSize(baseDir);

    while (totalSize < 3) {
        for (const channelData of channelsData) {
            const { channelId, playlists } = channelData;

            if (playlistIndex >= playlists.length) continue;

            const playlist = playlists[playlistIndex];
            const playlistDir = path.join(baseDir, sanitizeFolderName(`Channel_${channelId}`), sanitizeFolderName(playlist.title));
            fs.mkdirSync(playlistDir, { recursive: true });

            const videos = await getPlaylistItems(playlist.id, apiKey);
            log(`🔸 Плейлист "${playlist.title}" содержит ${videos.length} видео.`);

            for (const video of videos) {
                if (downloadHistory[channelId] && downloadHistory[channelId].playlists.some(p => p.id === playlist.id && p.videos.some(v => v.videoId === video.videoId))) {
                    log(`📦 Видео "${video.title}" уже было скачано.`);
                    continue;
                }

                totalSize = await checkTotalSize(baseDir);
                if (totalSize >= 3) {
                    log(`⛔ Превышен общий лимит в 3 ГБ. Загрузка остановлена.`);
                    return;
                }

                if (!downloadHistory[channelId]) {
                    downloadHistory[channelId] = { playlists: [] };
                }

                try {
                    await downloadVideoWithProgress(video, playlistDir, downloadHistory, channelId, playlist.id, playlist.title, baseDir);
                } catch (error) {
                    log(`❌ Ошибка при скачивании видео "${video.title}": ${error}`);
                }
            }

            const jsonFileName = path.join(playlistDir, `${playlist.title}.json`);
            fs.writeFileSync(jsonFileName, JSON.stringify(videos, null, 2));
        }

        playlistIndex++;
    }

    log(`🎉 Завершена загрузка всех плейлистов для всех каналов`);
}

const apiKey = 'вашКлюч';
const channelIds = process.argv.slice(2);
const baseDir = path.join(__dirname, 'DownloadedChannels');

if (!channelIds.length) {
    console.error("Пожалуйста, укажите ID каналов как аргументы.");
    process.exit(1);
}

downloadChannelsByRounds(channelIds, apiKey, baseDir);