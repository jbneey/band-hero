// ============================================================
// Band Hero — MVP rhythm game for Telegram Mini Apps
// ============================================================

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const menuEl = document.getElementById('menu');
const folderInput = document.getElementById('folderInput');
const startBtn = document.getElementById('startBtn');
const statusEl = document.getElementById('status');

// ---------- Константы ----------
const LANES = 4;
const LANE_COLORS = ['#22d3ee', '#a78bfa', '#f472b6', '#fb923c'];
const LANE_KEYS = ['a', 's', 'k', 'l']; // для отладки на десктопе
const HIT_WINDOW_MS = 140;             // окно попадания (± мс)
const SCROLL_SPEED = 0.6;              // px / ms (скорость падения нот)
const NOTE_HEIGHT = 20;

// ---------- Состояние ----------
let chart = null;                // распарсенная карта
let audioBuffer = null;          // декодированный AudioBuffer
let audioContext = null;
let sourceNode = null;
let songStartTime = 0;           // audioContext.currentTime в момент старта
let songOffsetMs = 0;            // смещение аудио из карты (мс)
let notes = [];                  // активные ноты: { timeMs, lane, hit, missed }
let score = 0;
let combo = 0;
let maxCombo = 0;
let isPlaying = false;
let animationId = null;

// ---------- Загрузка карты ----------
folderInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;

    statusEl.textContent = 'Чтение файлов...';

    // Преобразуем File[] в формат { fileName, data: Uint8Array }
    const fileEntries = await Promise.all(
        files.map(async (f) => ({
            fileName: f.webkitRelativePath || f.name,
            data: new Uint8Array(await f.arrayBuffer()),
        }))
    );

    try {
        // scan-chart-web сканирует папку и возвращает ScannedChart
        const scanned = ScanChartWeb.scanChartFolder(fileEntries);

        if (!scanned.playable || !scanned.notesData) {
            throw new Error('Карта не содержит играбельных нот.');
        }

        chart = scanned;
        statusEl.textContent = `✅ Загружено: ${chart.name || 'Без названия'} — ${chart.artist || 'Неизвестен'}`;

        // Ищем аудиофайл среди загруженных
        const audioFile = files.find((f) =>
        /\.(mp3|ogg|wav|m4a)$/i.test(f.name)
        );
        if (!audioFile) {
            throw new Error('Аудиофайл не найден. Нужен song.mp3 или song.ogg.');
        }

        statusEl.textContent += '\nДекодирование аудио...';

        // Создаём AudioContext (пока не запущен — только для декодирования)
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }

        const arrayBuffer = await audioFile.arrayBuffer();
        audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

        statusEl.textContent += '\n🎵 Аудио готово! Нажмите «Играть».';
        startBtn.disabled = false;
    } catch (err) {
        console.error(err);
        statusEl.textContent = '❌ Ошибка: ' + err.message;
        startBtn.disabled = true;
    }
});

// ---------- Старт игры ----------
startBtn.addEventListener('click', async () => {
    if (!chart || !audioBuffer) return;

    // КРИТИЧЕСКИ ВАЖНО: разблокировка AudioContext внутри user gesture
    if (audioContext.state === 'suspended') {
        await audioContext.resume();
    }

    menuEl.classList.add('hidden');
    prepareNotes();
    startPlayback();
});

// ---------- Подготовка нот ----------
function prepareNotes() {
    // Берём экспертную сложность гитары (fallback — первая доступная)
    const difficulties = chart.notesData;
    const diffKeys = ['expert', 'hard', 'medium', 'easy'];
    let noteList = null;

    for (const d of diffKeys) {
        if (difficulties[d]?.guitar?.notes?.length) {
            noteList = difficulties[d].guitar.notes;
            break;
        }
    }

    // Если структура отличается — ищем любые ноты
    if (!noteList) {
        const anyDiff = Object.values(difficulties)[0];
        const anyInst = anyDiff && Object.values(anyDiff)[0];
        noteList = anyInst?.notes || [];
    }

    // Преобразуем в удобный формат. scan-chart обычно отдаёт ms как время в мс.
    notes = noteList
    .map((n) => ({
        timeMs: Number(n.timeMs ?? n.time ?? 0),
                 lane: clampLane(n.lane ?? n.fret ?? 0),
                 hit: false,
                 missed: false,
    }))
    .sort((a, b) => a.timeMs - b.timeMs);

    // Смещение аудио из чарта (если есть)
    songOffsetMs = Number(chart.offset ?? chart.notesData?.offset ?? 0) || 0;

    score = 0;
    combo = 0;
    maxCombo = 0;
    document.body.dataset.combo = '0';

    console.log(`Загружено ${notes.length} нот, offset=${songOffsetMs}ms`);
}

function clampLane(v) {
    const n = Number(v);
    if (Number.isNaN(n)) return 0;
    return Math.max(0, Math.min(LANES - 1, Math.floor(n)));
}

// ---------- Воспроизведение ----------
function startPlayback() {
    // Останавливаем предыдущий источник, если был
    if (sourceNode) {
        try { sourceNode.stop(); } catch (_) {}
        sourceNode = null;
    }

    sourceNode = audioContext.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.connect(audioContext.destination);

    // Запускаем с небольшим запасом, чтобы всё успело инициализироваться
    const startAt = audioContext.currentTime + 0.15;
    sourceNode.start(startAt);
    songStartTime = startAt;

    isPlaying = true;
    animationId = requestAnimationFrame(gameLoop);
}

// ---------- Игровой цикл ----------
function gameLoop() {
    if (!isPlaying) return;

    resizeCanvas();
    const songTimeMs = getSongTimeMs();

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawHighway();
    drawNotes(songTimeMs);
    drawHUD(songTimeMs);

    animationId = requestAnimationFrame(gameLoop);
}

function getSongTimeMs() {
    if (!audioContext) return 0;
    return (audioContext.currentTime - songStartTime) * 1000 + songOffsetMs;
}

// ---------- Отрисовка ----------
function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
}

function getHighwayMetrics() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const laneW = Math.min(90, (w - 40) / LANES);
    const highwayW = laneW * LANES;
    const highwayX = (w - highwayW) / 2;
    const hitY = h - 140; // линия попадания
    return { laneW, highwayW, highwayX, hitY, w, h };
}

function drawHighway() {
    const { laneW, highwayW, highwayX, hitY, w, h } = getHighwayMetrics();

    // Фон шоссе
    ctx.fillStyle = 'rgba(20, 20, 30, 0.85)';
    ctx.fillRect(highwayX, 0, highwayW, h);

    // Разделители дорожек
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    for (let i = 1; i < LANES; i++) {
        const x = highwayX + laneW * i;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
    }

    // Линия попадания
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(highwayX, hitY);
    ctx.lineTo(highwayX + highwayW, hitY);
    ctx.stroke();

    // Подсветка дорожек
    for (let i = 0; i < LANES; i++) {
        ctx.fillStyle = LANE_COLORS[i] + '22';
        ctx.fillRect(highwayX + laneW * i, hitY - 6, laneW, 12);
    }
}

function drawNotes(songTimeMs) {
    const { laneW, highwayX, hitY } = getHighwayMetrics();

    for (const note of notes) {
        if (note.hit || note.missed) continue;

        const deltaMs = note.timeMs - songTimeMs;
        // Если нота ещё далеко впереди — не рисуем
        if (deltaMs > (hitY / SCROLL_SPEED) + 50) continue;
        // Если нота уже ушла ниже линии попадания и не была нажата — промах
        if (deltaMs < -HIT_WINDOW_MS - 100) {
            note.missed = true;
            combo = 0;
            continue;
        }

        const y = hitY - deltaMs * SCROLL_SPEED;
        if (y < -NOTE_HEIGHT || y > window.innerHeight + NOTE_HEIGHT) continue;

        const x = highwayX + laneW * note.lane;

        // Тело ноты
        ctx.fillStyle = LANE_COLORS[note.lane];
        roundRect(ctx, x + 6, y - NOTE_HEIGHT / 2, laneW - 12, NOTE_HEIGHT, 6);
        ctx.fill();

        // Блик
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        roundRect(ctx, x + 10, y - NOTE_HEIGHT / 2 + 3, laneW - 20, 5, 3);
        ctx.fill();
    }
}

function drawHUD(songTimeMs) {
    const { w } = getHighwayMetrics();

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 18px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`Счёт: ${score}`, 16, 36);

    ctx.textAlign = 'right';
    ctx.fillText(`Комбо: ${combo}`, w - 16, 36);

    ctx.textAlign = 'center';
    ctx.font = '14px -apple-system, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    const timeSec = Math.max(0, songTimeMs / 1000);
    const totalSec = audioBuffer ? audioBuffer.duration : 0;
    ctx.fillText(
        `${formatTime(timeSec)} / ${formatTime(totalSec)}`,
                 w / 2,
                 36
    );

    // Если песня закончилась
    if (totalSec > 0 && timeSec >= totalSec && isPlaying) {
        isPlaying = false;
        cancelAnimationFrame(animationId);
        showResults();
    }
}

function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

// ---------- Ввод ----------
function handleLanePress(lane) {
    if (!isPlaying) return;

    const songTimeMs = getSongTimeMs();

    // Ищем ближайшую ненажатую ноту в этой дорожке
    let best = null;
    let bestDelta = Infinity;

    for (const note of notes) {
        if (note.hit || note.missed) continue;
        if (note.lane !== lane) continue;

        const delta = Math.abs(note.timeMs - songTimeMs);
        if (delta < bestDelta) {
            bestDelta = delta;
            best = note;
        }
    }

    if (best && bestDelta <= HIT_WINDOW_MS) {
        best.hit = true;
        combo++;
        if (combo > maxCombo) maxCombo = combo;
        score += 50 + Math.min(combo, 20) * 5; // бонус за комбо
    } else {
        // Промах по нажатию
        combo = 0;
    }
}

// Touch-события для мобильных
canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const { laneW, highwayX } = getHighwayMetrics();
    const touch = e.changedTouches[0];
    const x = touch.clientX - highwayX;
    if (x < 0) return;
    const lane = Math.floor(x / laneW);
    if (lane >= 0 && lane < LANES) handleLanePress(lane);
}, { passive: false });

// Клавиатура для отладки на ПК
window.addEventListener('keydown', (e) => {
    const idx = LANE_KEYS.indexOf(e.key.toLowerCase());
    if (idx !== -1) handleLanePress(idx);
});

// ---------- Результаты ----------
function showResults() {
    const hitCount = notes.filter((n) => n.hit).length;
    const total = notes.length;
    const accuracy = total > 0 ? ((hitCount / total) * 100).toFixed(1) : '0.0';

    menuEl.classList.remove('hidden');
    menuEl.innerHTML = `
    <h1>🏁 Песня завершена!</h1>
    <p style="font-size:1.2rem">Счёт: <strong>${score}</strong></p>
    <p>Точность: <strong>${accuracy}%</strong> (${hitCount} / ${total})</p>
    <p>Максимальное комбо: <strong>${maxCombo}</strong></p>
    <button id="restartBtn" style="
    padding:14px 48px;border:none;border-radius:999px;
    background:linear-gradient(135deg,#ff6b9d,#c084fc);
    color:#fff;font-size:1.2rem;font-weight:700;cursor:pointer;
    ">🔄 Играть снова</button>
    `;

    document.getElementById('restartBtn').addEventListener('click', () => {
        menuEl.classList.add('hidden');
        prepareNotes();
        startPlayback();
    });
}

// ---------- Инициализация ----------
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// Сообщаем Telegram, что приложение готово
if (window.Telegram?.WebApp) {
    window.Telegram.WebApp.ready();
    window.Telegram.WebApp.expand();
}
