/* 数值验证：在 Node 中用桩对象加载 flicker.js，对合成信号检验算法 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const SRC = path.join(__dirname, '..', 'flicker.js');

const sandbox = {
    console,
    performance: { now: () => Date.now() },
    requestAnimationFrame: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    alert: () => {},
    window: { addEventListener: () => {}, devicePixelRatio: 1 },
    document: { addEventListener: () => {}, getElementById: () => null },
    navigator: { mediaDevices: {} },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox);

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
    if (cond) { pass++; console.log(`  PASS  ${name} ${extra}`); }
    else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

// ---------- 1. FFT 正确性 ----------
{
    const N = 256, k0 = 10, A = 3;
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = A * Math.sin(2 * Math.PI * k0 * i / N);
    sandbox.fft(re, im);
    let peakBin = -1, peakMag = 0;
    for (let k = 1; k < N / 2; k++) {
        const m = Math.hypot(re[k], im[k]);
        if (m > peakMag) { peakMag = m; peakBin = k; }
    }
    check('FFT 峰值 bin', peakBin === k0, `expect=${k0} got=${peakBin}`);
    // 未加窗单频：|X[k0]| = A*N/2
    check('FFT 峰值幅度', near(peakMag, A * N / 2, A * N / 2 * 0.01),
        `expect=${A * N / 2} got=${peakMag.toFixed(1)}`);
}

// ---------- 2. detrend 去线性趋势 ----------
{
    const n = 100;
    const arr = new Float64Array(n);
    for (let i = 0; i < n; i++) arr[i] = 50 + 0.7 * i;   // 纯线性
    const out = sandbox.detrend(arr);
    const maxAbs = Math.max(...Array.from(out).map(Math.abs));
    check('detrend 消除线性趋势', maxAbs < 1e-9, `residual=${maxAbs.toExponential(2)}`);
}

// ---------- 3. 条纹分析：调制深度与周期数 ----------
function bandingCase(mean, amp, cycles, H = 240) {
    const p = new Float64Array(H);
    for (let y = 0; y < H; y++) p[y] = mean + amp * Math.sin(2 * Math.PI * cycles * y / H);
    return sandbox.analyzeBanding(p);
}
{
    // 深度 = amp/mean，30% 情形
    const r = bandingCase(128, 38.4, 4);
    check('条纹 调制深度 30%', r && near(r.depth, 30, 1), `got=${r && r.depth.toFixed(2)}%`);
    check('条纹 周期数 4', r && near(r.cyclesPerFrame, 4, 0.15),
        `got=${r && r.cyclesPerFrame.toFixed(3)}`);

    // 深度 2%（护眼灯级别）
    const r2 = bandingCase(120, 2.4, 6);
    check('条纹 调制深度 2%', r2 && near(r2.depth, 2, 0.15), `got=${r2 && r2.depth.toFixed(3)}%`);

    // 无频闪：平坦 + 线性渐变，去趋势后无周期成分，应判为 0
    const flat = new Float64Array(240);
    for (let y = 0; y < 240; y++) flat[y] = 100 + 0.05 * y;
    const r3 = sandbox.analyzeBanding(flat);
    check('条纹 无调制时深度为0', r3 && r3.depth < 0.01, `got=${r3 && r3.depth}`);

    // 过暗 / 过曝帧应被拒绝
    const dark = new Float64Array(240).fill(5);
    const bright = new Float64Array(240).fill(250);
    check('条纹 过暗帧被拒绝', sandbox.analyzeBanding(dark) === null);
    check('条纹 过曝帧被拒绝', sandbox.analyzeBanding(bright) === null);
}

// ---------- 4. 时域分析：频率识别 ----------
{
    // 60fps 采样 4 秒，信号 10Hz（低于 Nyquist 30Hz），调制 ±20/128
    const fps = 60, dur = 4000;
    const samples = [];
    for (let t = 0; t <= dur; t += 1000 / fps) {
        samples.push({ t, lum: 128 + 20 * Math.sin(2 * Math.PI * 10 * t / 1000) });
    }
    const r = sandbox.analyzeTemporal(samples);
    check('时域 峰值频率 10Hz', r && near(r.peakFreq, 10, 0.3),
        `got=${r && r.peakFreq.toFixed(3)}Hz`);
    // 真实调制 A/M = 20/128 = 15.6%；峰峰值法因 6 点/周期采样会低估，
    // FFT 基波法应给出准确值
    check('时域 闪烁百分比 15.6%', r && near(r.flickerPercent, 15.6, 0.8),
        `got=${r && r.flickerPercent.toFixed(2)}% (pp=${r && r.ppPercent.toFixed(2)} fft=${r && r.fftPercent.toFixed(2)})`);
    check('时域 有效帧率≈60', r && near(r.effFps, 60, 2), `got=${r && r.effFps.toFixed(1)}`);
    // 正弦波闪烁指数理论值 = A/(πM) = 20/(π·128) ≈ 0.0497
    check('时域 闪烁指数≈0.0497', r && near(r.flickerIndex, 0.0497, 0.008),
        `got=${r && r.flickerIndex.toFixed(4)}`);

    // 直流无闪
    const dc = [];
    for (let t = 0; t <= dur; t += 1000 / fps) dc.push({ t, lum: 130 });
    const rdc = sandbox.analyzeTemporal(dc);
    check('时域 直流无闪 0%', rdc && rdc.flickerPercent === 0, `got=${rdc && rdc.flickerPercent}`);
}

// ---------- 5. 频率估算吸附 ----------
{
    const f = sandbox.estimateFrequency;
    check('频率估算 3.4周期@30fps -> 100Hz', f(3.4, 30) === 100, `got=${f(3.4, 30)}`);
    check('频率估算 2.05周期@60fps -> 120Hz', f(2.05, 60) === 120, `got=${f(2.05, 60)}`);
    check('频率估算 超范围保留原值', f(10, 30) === 300, `got=${f(10, 30)}`);
}

// ---------- 6. 评级边界 ----------
{
    // const 声明不会挂到 vm 的全局对象上，用表达式求值取出
    const R = vm.runInContext('RATINGS', sandbox);
    const rate = p => R.find(x => p < x.max).label;
    check('评级 1% -> 优秀', rate(1) === '优秀', `got=${rate(1)}`);
    check('评级 3.2% -> 良好（边界）', rate(3.2) === '良好', `got=${rate(3.2)}`);
    check('评级 8% -> 一般（边界）', rate(8) === '一般', `got=${rate(8)}`);
    check('评级 25% -> 较差（边界）', rate(25) === '较差', `got=${rate(25)}`);
    check('评级 70% -> 较差', rate(70) === '较差', `got=${rate(70)}`);
}

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
