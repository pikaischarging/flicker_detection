/* ============================================================
 * 频闪检测工具 - 核心逻辑
 *
 * 检测原理（两路互补）：
 *  1) 时域分析：逐帧取 ROI 平均亮度 -> 波形 + FFT
 *     受相机帧率限制（Nyquist = fps/2），100Hz 频闪会被"折叠"成低频，
 *     只能作为辅助判据。
 *  2) 空域分析（滚动快门条纹）：单帧内逐行平均亮度 -> 行方向 FFT
 *     CMOS 逐行曝光把时间轴映射到了图像的行方向，因此不受帧率
 *     Nyquist 限制，可直接测出 100/120Hz 的调制深度。这是主判据。
 * ============================================================ */

'use strict';

// ---------- 配置 ----------
const CFG = {
    captureSeconds: 4,      // 采集时长
    warmupMs: 700,          // 丢弃开头数据，等自动曝光稳定
    roiRatio: 0.35,         // ROI 占画面宽/高的比例（中心区域）
    targetWidth: 320,       // 降采样宽度（性能）
    targetHeight: 240,
    minBandCycles: 1.5,     // 条纹分析：最少周期数（滤掉光照渐变）
};

// ---------- 状态 ----------
const state = {
    stream: null,
    video: null,
    canvas: null,
    ctx: null,
    running: false,
    // 时域样本
    timeSamples: [],        // { t: ms, lum: 0-255 }
    // 空域样本（每帧一个条纹调制结果）
    bandSamples: [],        // { depth: %, cyclesPerFrame: n }
    frameCount: 0,
    fps: 30,
    watchdog: null,
};

/** 恢复按钮与进度条到可再次检测的状态 */
function resetButton() {
    const btn = document.getElementById('btnStart');
    btn.disabled = false;
    btn.textContent = '重新检测';
    document.getElementById('progressBar').classList.remove('active');
    document.getElementById('progressText').classList.remove('active');
}

/**
 * 采集看门狗。帧回调停止触发时（页面切后台、锁屏、掉流），
 * 到时间后强制收尾：样本够就出结果，不够就报错并复位。
 */
function armWatchdog(timeoutMs) {
    clearTimeout(state.watchdog);
    state.watchdog = setTimeout(() => {
        if (!state.running) return;
        if (state.timeSamples.length >= 16) {
            finishMeasure();
        } else {
            state.running = false;
            resetButton();
            showError('采集中断：没有收到足够的视频帧。\n' +
                '请保持页面在前台、不要锁屏，然后重试。');
        }
    }, timeoutMs);
}

// ============================================================
// 初始化相机
// ============================================================
async function initCamera() {
    state.video = document.getElementById('video');
    state.canvas = document.createElement('canvas');
    state.canvas.width = CFG.targetWidth;
    state.canvas.height = CFG.targetHeight;
    state.ctx = state.canvas.getContext('2d', { willReadFrequently: true });

    // 只用 ideal（软约束），不用 min/max。硬约束一旦不被设备满足，
    // getUserMedia 会直接抛 OverconstrainedError 而不是退让。
    // 逐级降级，保证在各种设备上都能拿到流。
    const attempts = [
        {
            facingMode: { ideal: 'environment' },
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 60 },   // 帧率越高，时域分辨力越好
        },
        { facingMode: { ideal: 'environment' } },
        true,
    ];

    let lastErr = null;
    for (const video of attempts) {
        try {
            state.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
            break;
        } catch (err) {
            lastErr = err;
        }
    }
    if (!state.stream) {
        const detail = lastErr ? `${lastErr.name}${lastErr.message ? ': ' + lastErr.message : ''}` : '未知错误';
        showError('无法访问摄像头（' + detail + '）\n' +
            '请确认已授权摄像头权限，且页面通过 https 或 localhost 访问。');
        throw lastErr || new Error('no stream');
    }

    state.video.srcObject = state.stream;
    await state.video.play().catch(() => {});

    // 尝试锁定曝光 —— 自动曝光是测量不稳定的首要原因。
    // 支持度有限（多数移动浏览器不支持 manual），失败则静默降级。
    await tryLockExposure();

    const track = state.stream.getVideoTracks()[0];
    const settings = track.getSettings();
    state.fps = settings.frameRate || 30;
    updateCameraInfo(settings);
}

async function tryLockExposure() {
    const track = state.stream.getVideoTracks()[0];
    if (!track.getCapabilities) return;

    let caps = {};
    try { caps = track.getCapabilities(); } catch (e) { return; }

    const advanced = [];

    // 关闭自动曝光，固定较短曝光时间以保留频闪调制
    if (caps.exposureMode && caps.exposureMode.includes('manual')) {
        advanced.push({ exposureMode: 'manual' });
        if (caps.exposureTime) {
            // 取能力范围内偏短的曝光时间（约 1/1000s 量级），
            // 曝光时间越长，亮度被平均掉，频闪就测不出来。
            const t = Math.max(caps.exposureTime.min,
                Math.min(caps.exposureTime.max, caps.exposureTime.min * 2));
            advanced.push({ exposureTime: t });
        }
    }
    // 关闭自动白平衡与对焦，减少额外变量
    if (caps.whiteBalanceMode && caps.whiteBalanceMode.includes('manual')) {
        advanced.push({ whiteBalanceMode: 'manual' });
    }
    if (caps.focusMode && caps.focusMode.includes('manual')) {
        advanced.push({ focusMode: 'manual' });
    }

    if (advanced.length === 0) return;
    try {
        await track.applyConstraints({ advanced });
    } catch (e) {
        // 不支持就算了，靠提示用户手动锁定曝光
    }
}

function updateCameraInfo(s) {
    const el = document.getElementById('cameraInfo');
    if (!el) return;
    const parts = [];
    if (s.width && s.height) parts.push(`${s.width}×${s.height}`);
    if (s.frameRate) parts.push(`${Math.round(s.frameRate)}fps`);
    if (s.exposureMode) parts.push(`曝光:${s.exposureMode === 'manual' ? '已锁定' : '自动'}`);
    el.textContent = parts.join(' · ');
}

// ============================================================
// 采集
// ============================================================
async function startMeasure() {
    if (state.running) return;

    const btn = document.getElementById('btnStart');
    btn.disabled = true;
    btn.textContent = '检测中...';

    resetResults();

    try {
        if (!state.stream) await initCamera();
    } catch (e) {
        btn.disabled = false;
        btn.textContent = '开始检测';
        return;
    }

    state.running = true;
    state.timeSamples = [];
    state.bandSamples = [];
    state.frameCount = 0;

    document.getElementById('progressBar').classList.add('active');
    document.getElementById('progressText').classList.add('active');

    const t0 = performance.now();
    const totalMs = CFG.captureSeconds * 1000 + CFG.warmupMs;

    // 看门狗：页面切到后台、autoplay 被拦、设备掉流等情况下，
    // requestVideoFrameCallback / requestAnimationFrame 会停止触发，
    // 采集就会永久挂住。用独立定时器兜底。
    armWatchdog(totalMs + 3000);

    // 优先使用 requestVideoFrameCallback：它给出的是真实帧时间戳，
    // 而 requestAnimationFrame 可能在同一帧重复采样。
    const useVFC = typeof state.video.requestVideoFrameCallback === 'function';

    function onFrame(now, meta) {
        if (!state.running) return;
        const elapsed = performance.now() - t0;

        if (elapsed > CFG.warmupMs) {
            captureFrame(elapsed - CFG.warmupMs);
        }

        const pct = Math.min(100, (elapsed / totalMs) * 100);
        document.getElementById('progressFill').style.width = pct + '%';
        document.getElementById('progressText').textContent =
            elapsed < CFG.warmupMs
                ? '曝光稳定中...'
                : `采集中... ${Math.round(pct)}%`;

        if (elapsed >= totalMs) {
            finishMeasure();
            return;
        }
        if (useVFC) state.video.requestVideoFrameCallback(onFrame);
        else requestAnimationFrame(onFrame);
    }

    if (useVFC) state.video.requestVideoFrameCallback(onFrame);
    else requestAnimationFrame(onFrame);
}

function captureFrame(tMs) {
    const { ctx, canvas } = state;
    const W = canvas.width, H = canvas.height;
    ctx.drawImage(state.video, 0, 0, W, H);

    let data;
    try {
        data = ctx.getImageData(0, 0, W, H).data;
    } catch (e) {
        return; // 跨域等异常，跳过该帧
    }

    state.frameCount++;

    // --- 1) 时域：ROI 平均亮度 ---
    const rw = Math.round(W * CFG.roiRatio);
    const rh = Math.round(H * CFG.roiRatio);
    const x0 = ((W - rw) >> 1), y0 = ((H - rh) >> 1);
    let sum = 0, n = 0;
    for (let y = y0; y < y0 + rh; y++) {
        let idx = (y * W + x0) * 4;
        for (let x = 0; x < rw; x++, idx += 4) {
            // Rec.601 亮度
            sum += 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
            n++;
        }
    }
    state.timeSamples.push({ t: tMs, lum: sum / n });

    // --- 2) 空域：逐行平均亮度 -> 滚动快门条纹 ---
    const rowProfile = new Float64Array(H);
    for (let y = 0; y < H; y++) {
        let s = 0;
        let idx = (y * W) * 4;
        for (let x = 0; x < W; x++, idx += 4) {
            s += 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
        }
        rowProfile[y] = s / W;
    }
    const band = analyzeBanding(rowProfile);
    if (band) state.bandSamples.push(band);
}

// ============================================================
// 空域条纹分析
// ============================================================
/**
 * 分析一帧的行亮度曲线，提取周期性条纹的调制深度。
 * 返回 { depth: 调制百分比, cyclesPerFrame: 每帧周期数 }
 */
function analyzeBanding(profile) {
    const H = profile.length;
    const mean = profile.reduce((a, b) => a + b, 0) / H;
    // 过暗或过曝的帧不可信：暗处噪声大，过曝处调制被削平
    if (mean < 12 || mean > 245) return null;

    // 去趋势（消除上下方向的光照不均），再加 Hann 窗抑制频谱泄漏
    const detrended = detrend(profile);
    const windowed = applyHann(detrended);

    const N = nextPow2(H);
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    re.set(windowed);
    fft(re, im);

    // 找峰值（跳过太低的频率，那是残余渐变）
    const half = N >> 1;
    const minBin = Math.max(1, Math.floor(CFG.minBandCycles * N / H));
    const mags = new Float64Array(half);
    let peakBin = -1, peakMag = 0;
    for (let k = minBin; k < half; k++) {
        mags[k] = Math.hypot(re[k], im[k]);
        if (mags[k] > peakMag) { peakMag = mags[k]; peakBin = k; }
    }
    // 完全没有周期性成分（理想直流光源）：调制深度为 0
    if (peakBin < 0 || peakMag === 0) {
        return { depth: 0, cyclesPerFrame: 0, mean };
    }

    const refined = refinePeak(mags, peakBin);
    // Hann 窗使幅度衰减一半，且单边谱需 ×2 -> 幅度 = mag * 4 / M
    // 注意分母是窗长 H（真实样本数），不是零填充后的 N
    const amplitude = refined.mag * 4 / H;
    // 调制深度 = 交流幅度 / 直流分量
    const depth = (amplitude / mean) * 100;
    const cyclesPerFrame = refined.bin * H / N;

    return { depth, cyclesPerFrame, mean };
}

// ============================================================
// 时域分析
// ============================================================
/**
 * 把不等间隔的帧样本重采样到均匀网格，再做 FFT。
 * 返回频谱与峰值信息，以及闪烁百分比 / 闪烁指数。
 */
function analyzeTemporal(samples) {
    if (samples.length < 16) return null;

    const t0 = samples[0].t;
    const tEnd = samples[samples.length - 1].t;
    const durationMs = tEnd - t0;
    const n = samples.length;
    const effFps = (n - 1) / (durationMs / 1000);

    // 均匀重采样（线性插值）
    const N = nextPow2(n);
    const dt = durationMs / (N - 1);
    const uniform = new Float64Array(N);
    let j = 0;
    for (let i = 0; i < N; i++) {
        const t = t0 + i * dt;
        while (j < n - 2 && samples[j + 1].t < t) j++;
        const a = samples[j], b = samples[Math.min(j + 1, n - 1)];
        const span = b.t - a.t;
        uniform[i] = span > 0 ? a.lum + (b.lum - a.lum) * (t - a.t) / span : a.lum;
    }

    // 闪烁百分比（IES 定义）基于原始波形的峰峰值
    const lums = samples.map(s => s.lum);
    const max = Math.max(...lums), min = Math.min(...lums);
    const ppPercent = (max + min) > 0 ? ((max - min) / (max + min)) * 100 : 0;
    const flickerIndex = computeFlickerIndex(lums);
    const dcMean = lums.reduce((a, b) => a + b, 0) / lums.length;

    // FFT
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    re.set(applyHann(detrend(uniform)));
    fft(re, im);

    const half = N >> 1;
    const freqRes = 1000 / dt / N;  // Hz per bin
    const spectrum = new Float64Array(half);
    let peakBin = 2, peakMag = 0;
    for (let k = 1; k < half; k++) {
        spectrum[k] = Math.hypot(re[k], im[k]) * 4 / N;
        if (k >= 2 && spectrum[k] > peakMag) { peakMag = spectrum[k]; peakBin = k; }
    }
    const refined = refinePeak(spectrum, peakBin);
    const peakFreq = refined.bin * freqRes;

    // 补偿线性插值重采样的幅度衰减。
    // 分段线性重建等效于与三角核卷积，其频响为 sinc²(f·Δ)，
    // Δ 为原始采样间隔。例如 10Hz 信号在 60fps 下会被衰减到 91%。
    const dtOrig = (durationMs / (n - 1)) / 1000;   // 秒
    const interpGain = Math.max(0.25, sinc2(peakFreq * dtOrig));

    // 峰峰值法在采样点稀疏时会低估（采样相位很少正好落在波峰上），
    // FFT 基波法对谐波丰富的波形又会低估，故取两者较大值。
    const fftPercent = dcMean > 0 ? (refined.mag / interpGain / dcMean) * 100 : 0;
    const flickerPercent = Math.max(ppPercent, fftPercent);

    return {
        spectrum,
        freqRes,
        peakFreq,
        peakAmp: refined.mag,
        effFps,
        flickerPercent,
        ppPercent,
        fftPercent,
        flickerIndex,
        waveform: lums,
        nyquist: effFps / 2,
    };
}

/** sinc²(x)，x 为归一化频率；用于插值衰减补偿 */
function sinc2(x) {
    if (x === 0) return 1;
    const s = Math.sin(Math.PI * x) / (Math.PI * x);
    return s * s;
}

/**
 * 闪烁指数：一个周期内亮度曲线高于平均值部分的面积 / 总面积。
 * 这里用整段波形近似（0~1，越小越好）。
 */
function computeFlickerIndex(lums) {
    const n = lums.length;
    if (n === 0) return 0;
    const avg = lums.reduce((a, b) => a + b, 0) / n;
    if (avg <= 0) return 0;
    let above = 0, total = 0;
    for (const v of lums) {
        total += v;
        if (v > avg) above += (v - avg);
    }
    return total > 0 ? above / total : 0;
}

// ============================================================
// 结果综合与评级
// ============================================================
function finishMeasure() {
    state.running = false;
    clearTimeout(state.watchdog);

    resetButton();
    document.getElementById('progressBar').classList.remove('active');
    document.getElementById('progressText').classList.remove('active');

    const temporal = analyzeTemporal(state.timeSamples);
    const banding = summarizeBanding(state.bandSamples);

    if (!temporal) {
        showError('采集到的数据太少，请重试。');
        return;
    }

    // 主判据取条纹分析（不受帧率 Nyquist 限制），
    // 没有有效条纹时退回时域调制深度。
    let percent, source, freqHz = null, confidence, aliasRisk = false;
    if (banding && banding.validRatio > 0.3) {
        percent = banding.depth;
        source = 'banding';
        freqHz = estimateFrequency(banding.cyclesPerFrame, temporal.effFps);
        confidence = banding.validRatio > 0.7 ? 'high' : 'medium';
    } else {
        percent = temporal.flickerPercent;
        source = 'temporal';
        freqHz = Math.round(temporal.peakFreq);
        confidence = 'low';
        aliasRisk = true;
    }

    // 时域调制若明显更大（低频频闪，如调光 PWM 打到几十 Hz），取较大值。
    // 注意要同步更新频率与置信度，否则展示的判据与数值会自相矛盾。
    if (temporal.flickerPercent > percent * 1.5 && temporal.flickerPercent > 10) {
        percent = temporal.flickerPercent;
        source = 'temporal';
        freqHz = Math.round(temporal.peakFreq);
        // 时域路径受帧率 Nyquist 限制，频率可能是混叠值，置信度不给"高"
        confidence = confidence === 'high' ? 'medium' : confidence;
        aliasRisk = true;
    }

    renderWaveform(temporal.waveform);
    renderSpectrum(temporal);
    renderResult({
        percent,
        flickerIndex: temporal.flickerIndex,
        freqHz,
        source,
        confidence,
        aliasRisk,
        effFps: temporal.effFps,
        frames: state.frameCount,
    });
}

function summarizeBanding(samples) {
    if (samples.length === 0) return null;
    const total = Math.max(1, state.frameCount);
    // 取中位数，避免个别晃动帧带来的离群值
    const depths = samples.map(s => s.depth).sort((a, b) => a - b);
    const cycles = samples.map(s => s.cyclesPerFrame).sort((a, b) => a - b);
    return {
        depth: median(depths),
        cyclesPerFrame: median(cycles),
        validRatio: samples.length / total,
        count: samples.length,
    };
}

/**
 * 由每帧条纹周期数估算频闪频率。
 * 近似假设：传感器读出时间 ≈ 一个帧周期，则 频率 ≈ 周期数 × 帧率。
 * 这个假设在多数手机上偏差在 20% 内，因此对 90~130Hz 的结果
 * 直接吸附到 100/120Hz（对应 50/60Hz 市电）。
 */
function estimateFrequency(cyclesPerFrame, fps) {
    if (!cyclesPerFrame || !fps) return null;
    const raw = cyclesPerFrame * fps;
    if (raw > 85 && raw < 115) return 100;
    if (raw >= 115 && raw < 140) return 120;
    return Math.round(raw);
}

const RATINGS = [
    { max: 3.2,      stars: '★★★', label: '优秀', color: '#4ade80',
      desc: '护眼灯级别，长时间读写无忧' },
    { max: 8,        stars: '★★☆', label: '良好', color: '#a3e635',
      desc: '符合 IEEE PAR 1789 低风险线，日常使用没问题' },
    { max: 25,       stars: '★☆☆', label: '一般', color: '#fbbf24',
      desc: '基本合格但非最佳，对光敏感人群可能引起疲劳' },
    { max: Infinity, stars: '☆☆☆', label: '较差', color: '#f87171',
      desc: '频闪明显，长期使用易视觉疲劳，建议更换光源' },
];

function renderResult(r) {
    const rating = RATINGS.find(x => r.percent < x.max);

    document.getElementById('resultRating').textContent =
        `${rating.stars} ${rating.label}`;
    document.getElementById('resultRating').style.color = rating.color;

    document.getElementById('resultValue').textContent =
        `频闪百分比 ≈ ${r.percent.toFixed(1)}%`;

    document.getElementById('resultDesc').textContent = rating.desc;

    const confText = { high: '高', medium: '中', low: '低' }[r.confidence];
    const srcText = r.source === 'banding' ? '滚动快门条纹' : '帧间亮度';
    let freqText = r.freqHz ? `${r.freqHz}Hz` : '未识别';
    // 时域路径受帧率 Nyquist 限制，真实的 100/120Hz 会被折叠成低频
    if (r.freqHz && r.aliasRisk) freqText += '（受帧率限制，可能是混叠值）';
    document.getElementById('resultFreq').innerHTML =
        `主频闪频率：${freqText} &nbsp;·&nbsp; 闪烁指数：${r.flickerIndex.toFixed(3)}<br>` +
        `分析方式：${srcText} &nbsp;·&nbsp; 置信度：${confText} ` +
        `&nbsp;·&nbsp; ${r.frames}帧 @ ${r.effFps.toFixed(0)}fps`;

    const card = document.getElementById('resultCard');
    card.classList.add('active');
    card.style.borderTop = `3px solid ${rating.color}`;

    if (r.confidence === 'low') {
        showHint('未检测到清晰的条纹信号，结果置信度较低。建议：靠近光源、' +
            '关闭其他光源、iOS 长按屏幕锁定曝光后重测。');
    } else {
        showHint('');
    }
}

// ============================================================
// 绘图
// ============================================================
function setupCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    return { ctx, w: rect.width, h: rect.height };
}

function renderWaveform(lums) {
    const canvas = document.getElementById('waveformCanvas');
    canvas.parentElement.classList.add('active');
    const { ctx, w, h } = setupCanvas(canvas);

    ctx.clearRect(0, 0, w, h);
    const pad = 4;
    const max = Math.max(...lums), min = Math.min(...lums);
    const range = Math.max(1, max - min);

    // 平均线
    const avg = lums.reduce((a, b) => a + b, 0) / lums.length;
    const avgY = h - pad - ((avg - min) / range) * (h - pad * 2);
    ctx.strokeStyle = '#444';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, avgY); ctx.lineTo(w, avgY);
    ctx.stroke();
    ctx.setLineDash([]);

    // 波形
    ctx.strokeStyle = '#667eea';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    lums.forEach((v, i) => {
        const x = (i / (lums.length - 1)) * w;
        const y = h - pad - ((v - min) / range) * (h - pad * 2);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();

    // 标注幅度范围
    ctx.fillStyle = '#666';
    ctx.font = '10px sans-serif';
    ctx.fillText(`亮度 ${min.toFixed(0)}~${max.toFixed(0)}`, 4, 11);
}

function renderSpectrum(temporal) {
    const canvas = document.getElementById('fftCanvas');
    canvas.parentElement.classList.add('active');
    const { ctx, w, h } = setupCanvas(canvas);

    ctx.clearRect(0, 0, w, h);

    const spec = temporal.spectrum;
    const maxFreq = temporal.nyquist;
    const bins = Math.min(spec.length, Math.floor(maxFreq / temporal.freqRes));
    let peak = 0;
    for (let k = 2; k < bins; k++) peak = Math.max(peak, spec[k]);
    if (peak <= 0) peak = 1;

    const pad = 14;
    const barW = w / bins;
    for (let k = 2; k < bins; k++) {
        const mag = spec[k] / peak;
        const bh = mag * (h - pad - 4);
        const x = (k / bins) * w;
        ctx.fillStyle = mag > 0.6 ? '#764ba2' : '#667eea';
        ctx.fillRect(x, h - pad - bh, Math.max(1, barW - 0.5), bh);
    }

    // 频率轴
    ctx.fillStyle = '#666';
    ctx.font = '9px sans-serif';
    ctx.fillText('0Hz', 2, h - 3);
    ctx.fillText(`${maxFreq.toFixed(0)}Hz (Nyquist)`, w - 78, h - 3);

    ctx.fillStyle = '#888';
    ctx.fillText(`峰值 ${temporal.peakFreq.toFixed(1)}Hz`, 4, 10);
}

// ============================================================
// UI 辅助
// ============================================================
function resetResults() {
    document.getElementById('resultCard').classList.remove('active');
    document.getElementById('waveformContainer').classList.remove('active');
    document.getElementById('fftContainer').classList.remove('active');
    showError('');
    showHint('');
}

function showError(msg) {
    const el = document.getElementById('errorBox');
    if (!el) { if (msg) alert(msg); return; }
    el.textContent = msg;
    el.style.display = msg ? 'block' : 'none';
}

function showHint(msg) {
    const el = document.getElementById('hintBox');
    if (!el) return;
    el.textContent = msg;
    el.style.display = msg ? 'block' : 'none';
}

function showModal() {
    document.getElementById('modalOverlay').classList.add('active');
}

function hideModal(e) {
    if (e && e.target !== e.currentTarget) return;
    document.getElementById('modalOverlay').classList.remove('active');
}

document.addEventListener('keydown', e => {
    if (e.key === 'Escape') hideModal();
});

/** 结果卡片长按（>500ms）打开标准说明 */
function bindLongPress() {
    const card = document.getElementById('resultCard');
    if (!card) return;
    let timer = null;
    const start = () => {
        clearTimeout(timer);
        timer = setTimeout(showModal, 500);
    };
    const cancel = () => clearTimeout(timer);

    card.addEventListener('touchstart', start, { passive: true });
    card.addEventListener('touchend', cancel);
    card.addEventListener('touchmove', cancel, { passive: true });
    card.addEventListener('mousedown', start);
    card.addEventListener('mouseup', cancel);
    card.addEventListener('mouseleave', cancel);
    // 阻止长按时弹出系统菜单
    card.addEventListener('contextmenu', e => e.preventDefault());
}

// ============================================================
// 数学工具
// ============================================================
function nextPow2(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
}

function median(sorted) {
    const n = sorted.length;
    if (n === 0) return 0;
    return n % 2 ? sorted[(n - 1) >> 1]
                 : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/** 去线性趋势（最小二乘），同时去掉直流 */
function detrend(arr) {
    const n = arr.length;
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) {
        sx += i; sy += arr[i]; sxy += i * arr[i]; sxx += i * i;
    }
    const denom = n * sxx - sx * sx;
    const slope = denom !== 0 ? (n * sxy - sx * sy) / denom : 0;
    const intercept = (sy - slope * sx) / n;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = arr[i] - (slope * i + intercept);
    return out;
}

/** Hann 窗，抑制频谱泄漏 */
function applyHann(arr) {
    const n = arr.length;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        out[i] = arr[i] * 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)));
    }
    return out;
}

/**
 * 抛物线插值细化谱峰。
 * 真实频率很少正好落在 FFT 的整数 bin 上，直接取 bin 会同时低估
 * 频率精度和峰值幅度（频谱泄漏）。用峰值及左右相邻两点拟合抛物线，
 * 可把误差从百分之几降到千分之几。
 */
function refinePeak(mags, k) {
    if (k <= 0 || k >= mags.length - 1) return { bin: k, mag: mags[k] };
    const a = mags[k - 1], b = mags[k], c = mags[k + 1];
    const denom = a - 2 * b + c;
    if (denom === 0) return { bin: k, mag: b };
    const d = 0.5 * (a - c) / denom;
    if (!isFinite(d) || Math.abs(d) > 1) return { bin: k, mag: b };
    return { bin: k + d, mag: b - 0.25 * (a - c) * d };
}

/** 原地基-2 Cooley-Tukey FFT，长度必须是 2 的幂 */
function fft(re, im) {
    const n = re.length;
    if (n <= 1) return;

    // 位反转置换
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            [re[i], re[j]] = [re[j], re[i]];
            [im[i], im[j]] = [im[j], im[i]];
        }
    }

    for (let len = 2; len <= n; len <<= 1) {
        const ang = -2 * Math.PI / len;
        const wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let cr = 1, ci = 0;
            for (let k = 0; k < len / 2; k++) {
                const ur = re[i + k], ui = im[i + k];
                const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
                const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
                re[i + k] = ur + vr;  im[i + k] = ui + vi;
                re[i + k + len / 2] = ur - vr;  im[i + k + len / 2] = ui - vi;
                const ncr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = ncr;
            }
        }
    }
}

// ============================================================
// 启动
// ============================================================
window.addEventListener('DOMContentLoaded', () => {
    bindLongPress();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showError('当前浏览器不支持摄像头访问。请使用 Chrome / Safari 等现代浏览器，' +
            '并通过 https 或 localhost 打开。');
        document.getElementById('btnStart').disabled = true;
        return;
    }
    // 不自动开启摄像头，等用户点击（移动端要求用户手势）
});

window.addEventListener('beforeunload', () => {
    if (state.stream) state.stream.getTracks().forEach(t => t.stop());
});
