const fs = require('fs');
const fetch = require('node-fetch');
const path = require('path');
const { exec } = require('child_process');
const { transliterate } = require('transliteration');

const logStream = fs.createWriteStream(path.join(__dirname, 'log.txt'), { flags: 'a' });

function log(message) {
    console.log(message);
    logStream.write(message + '\n');
}

function sanitizeFolderName(name) {
    return name.replace(/[<>:"\/\\|?*]+/g, '').trim();
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
    });
}

async function getChannelPlaylists(channelId, apiKey) {
    const url = `https://www.googleapis.com/youtube/v3/playlists?part=snippet&channelId=${channelId}&maxResults=50&key=${apiKey}`;
    const response = await fetch(url);
    
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
    const response = await fetch(url);
    
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
    const command = `"${path.join(__dirname, 'yt-dlp.exe')}" --get-duration "https://www.youtube.com/watch?v=${videoId}"`;
    const duration = await execPromise(command);
    return duration.trim(); // Убираем лишние пробелы
}

async function downloadVideo(video, playlistDir, downloadHistory, channelId, playlistId) {
    const videoDir = path.join(playlistDir, sanitizeFolderName(video.title));
    fs.mkdirSync(videoDir, { recursive: true });
    
    const outputTemplate = path.join(videoDir, '%(title)s.%(ext)s');
    const command = `"${path.join(__dirname, 'yt-dlp.exe')}" -o "${outputTemplate}" "https://www.youtube.com/watch?v=${video.videoId}"`;
    
    log(`Скачивание видео: ${video.title}...`);
    await execPromise(command);
    log(`✅ Видео "${video.title}" успешно загружено в "${videoDir}"`);

    // Получаем длительность видео
    const duration = await getVideoDuration(video.videoId);
    video.duration = duration; // Сохраняем длительность

    // Сохраняем информацию о загруженном видео
    let playlistHistory = downloadHistory[channelId].playlists.find(p => p.id === playlistId);

    if (!playlistHistory) {
        playlistHistory = { id: playlistId, videos: [] };
        downloadHistory[channelId].playlists.push(playlistHistory);
    }

    playlistHistory.videos.push(video); // Добавляем видео в историю

    // Записываем обновленную историю в файл
    fs.writeFileSync('download_history.json', JSON.stringify(downloadHistory, null, 2));
}

async function downloadChannelPlaylists(channelId, apiKey) {
    const channelDir = path.join(__dirname, sanitizeFolderName(`Channel_${channelId}`));
    fs.mkdirSync(channelDir, { recursive: true });

    const playlists = await getChannelPlaylists(channelId, apiKey);
    log(`📂 Найдено плейлистов: ${playlists.length} на канале "${channelId}"`);

    let downloadHistory = {};

    if (fs.existsSync('download_history.json')) {
        downloadHistory = JSON.parse(fs.readFileSync('download_history.json', 'utf-8'));
    } else {
        downloadHistory[channelId] = { playlists: [] };
    }

    for (const playlist of playlists) {
        const playlistDir = path.join(channelDir, sanitizeFolderName(playlist.title));
        fs.mkdirSync(playlistDir, { recursive: true });

        const videos = await getPlaylistItems(playlist.id, apiKey);
        log(`🔸 Плейлист "${playlist.title}" содержит ${videos.length} видео.`);

        // Обновление истории загрузок для текущего плейлиста
        let playlistHistory = downloadHistory[channelId].playlists.find(p => p.id === playlist.id);

        if (!playlistHistory) {
            playlistHistory = { id: playlist.id, videos: [] };
            downloadHistory[channelId].playlists.push(playlistHistory);
        }

        for (const video of videos) {
            if (playlistHistory.videos.some(v => v.videoId === video.videoId)) {
                log(`📦 Видео "${video.title}" уже было скачано.`);
                continue;
            }
            
            try {
                await downloadVideo(video, playlistDir, downloadHistory, channelId, playlist.id);
            } catch (error) {
                log(`❌ Ошибка при скачивании видео "${video.title}": ${error}`);
            }
        }

        const jsonFileName = path.join(playlistDir, `${sanitizeFolderName(playlist.title)}.json`);
        fs.writeFileSync(jsonFileName, JSON.stringify(videos, null, 2));
    }

    log(`🎉 Завершена загрузка всех плейлистов канала "${channelId}"`);
}

const apiKey = 'AIzaSyC6oqKsdbVds4TsVipbV8PrUNvHCxm8l44'; // API-ключ
const channelId = process.argv[2]; // ID канала передается как аргумент

if (!channelId) {
    console.error("Пожалуйста, укажите ID канала в качестве аргумента.");
    process.exit(1);
}

downloadChannelPlaylists(channelId, apiKey).catch(error => {
    log(`Произошла ошибка: ${error.message}`);
}).finally(() => {
    logStream.end();
});