/* 端到端：用最小 DOM 桩驱动 finishMeasure()，验证分析 -> 评级 -> 绘图链路 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const SRC = path.join(__dirname, '..', 'flicker.js');

// ---- 最小 DOM 桩 ----
const drawCalls = [];
function fakeCtx() {
    const noop = () => {};
    return new Proxy({
        canvas: null,
        scale: noop, clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop,
        stroke: noop, fillRect: noop, fillText: (t) => drawCalls.push(String(t)),
        setLineDash: noop, drawImage: noop,
        getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    }, {
        get: (t, p) => (p in t ? t[p] : undefined),
        set: (t, p, v) => { t[p] = v; return true; },
    });
}
const elements = {};
function makeEl(id) {
    return {
        id,
        _cls: new Set(),
        style: {},
        textContent: '',
        innerHTML: '',
        disabled: false,
        classList: {
            add: c => elements[id]._cls.add(c),
            remove: c => elements[id]._cls.delete(c),
            contains: c => elements[id]._cls.has(c),
        },
        parentElement: { classList: { add: () => {}, remove: () => {} } },
        getBoundingClientRect: () => ({ width: 300, height: 120 }),
        getContext: () => fakeCtx(),
        addEventListener: () => {},
    };
}
for (const id of ['video', 'cameraInfo', 'btnStart', 'errorBox', 'hintBox',
    'progressBar', 'progressFill', 'progressText', 'waveformContainer',
    'waveformCanvas', 'fftContainer', 'fftCanvas', 'resultCard', 'resultRating',
    'resultValue', 'resultDesc', 'resultFreq', 'modalOverlay']) {
    elements[id] = makeEl(id);
}

const sandbox = {
    console,
    performance: { now: () => Date.now() },
    requestAnimationFrame: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    alert: m => { throw new Error('unexpected alert: ' + m); },
    window: { addEventListener: () => {}, devicePixelRatio: 2 },
    document: { addEventListener: () => {}, getElementById: id => elements[id] || null },
    navigator: { mediaDevices: { getUserMedia: () => {} } },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox);

const state = vm.runInContext('state', sandbox);

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
    if (cond) { pass++; console.log(`  PASS  ${name} ${extra}`); }
    else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
}

/**
 * 构造一次"虚拟测量"：
 *  - bandDepth: 滚动快门条纹调制深度（%）
 *  - cycles: 每帧条纹周期数
 *  - tempAmp: 帧间亮度调制幅度（灰阶）
 */
function simulate({ bandDepth, cycles, tempAmp = 0.5, fps = 30, seconds = 4, validFrames = 1 }) {
    const nFrames = Math.round(fps * seconds);
    state.frameCount = nFrames;
    state.timeSamples = [];
    state.bandSamples = [];
    for (let i = 0; i < nFrames; i++) {
        const t = i * 1000 / fps;
        state.timeSamples.push({ t, lum: 128 + tempAmp * Math.sin(2 * Math.PI * 2 * t / 1000) });
    }
    const nValid = Math.round(nFrames * validFrames);
    for (let i = 0; i < nValid; i++) {
        state.bandSamples.push({ depth: bandDepth, cyclesPerFrame: cycles, mean: 128 });
    }
    state.running = true;
    drawCalls.length = 0;
    vm.runInContext('finishMeasure()', sandbox);
}

// ---- 场景 1：办公室日光灯（电子镇流器，100Hz，调制 ~20%）----
simulate({ bandDepth: 20, cycles: 3.33, fps: 30 });
check('日光灯 评级为一般', elements.resultRating.textContent.includes('一般'),
    `got="${elements.resultRating.textContent}"`);
check('日光灯 显示 20%', /19\.|20\.|20%/.test(elements.resultValue.textContent),
    `got="${elements.resultValue.textContent}"`);
check('日光灯 识别 100Hz', elements.resultFreq.innerHTML.includes('100Hz'),
    `got="${elements.resultFreq.innerHTML.split('<br>')[0]}"`);
check('日光灯 使用条纹判据', elements.resultFreq.innerHTML.includes('滚动快门条纹'));
check('日光灯 置信度为高', elements.resultFreq.innerHTML.includes('置信度：高'));
check('结果卡片已显示', elements.resultCard.classList.contains('active'));
check('波形与频谱已绘制', drawCalls.some(t => t.includes('亮度')) && drawCalls.some(t => t.includes('峰值')),
    `draws=${drawCalls.length}`);

// ---- 场景 2：护眼灯（几乎无频闪）----
simulate({ bandDepth: 1.8, cycles: 4, fps: 60, tempAmp: 0.2 });
check('护眼灯 评级为优秀', elements.resultRating.textContent.includes('优秀'),
    `got="${elements.resultRating.textContent}"`);
check('护眼灯 颜色为绿', elements.resultRating.style.color === '#4ade80',
    `got=${elements.resultRating.style.color}`);

// ---- 场景 3：老式电感镇流器（严重频闪）----
simulate({ bandDepth: 62, cycles: 3.33, fps: 30 });
check('电感镇流器 评级为较差', elements.resultRating.textContent.includes('较差'),
    `got="${elements.resultRating.textContent}"`);
check('电感镇流器 建议更换', elements.resultDesc.textContent.includes('建议更换'));

// ---- 场景 4：条纹信号不足 -> 退回时域，置信度低并给出提示 ----
simulate({ bandDepth: 5, cycles: 3.33, fps: 30, tempAmp: 1, validFrames: 0.1 });
check('无有效条纹 退回帧间亮度', elements.resultFreq.innerHTML.includes('帧间亮度'),
    `got="${elements.resultFreq.innerHTML.split('<br>')[1]}"`);
check('无有效条纹 置信度为低', elements.resultFreq.innerHTML.includes('置信度：低'));
check('无有效条纹 显示提示', elements.hintBox.textContent.includes('置信度较低'),
    `hint="${elements.hintBox.textContent.slice(0, 20)}"`);

// ---- 场景 5：低频 PWM 调光（时域调制远大于条纹）----
simulate({ bandDepth: 4, cycles: 4, fps: 60, tempAmp: 30 });
check('低频PWM 取时域较大值', elements.resultFreq.innerHTML.includes('帧间亮度'),
    `got="${elements.resultValue.textContent}"`);
check('低频PWM 评级不低于一般',
    /一般|较差/.test(elements.resultRating.textContent),
    `got="${elements.resultRating.textContent}"`);

// ---- 场景 6：数据过少应报错而非崩溃 ----
state.frameCount = 3;
state.timeSamples = [{ t: 0, lum: 100 }, { t: 33, lum: 101 }];
state.bandSamples = [];
state.running = true;
vm.runInContext('finishMeasure()', sandbox);
check('数据过少 给出错误提示', elements.errorBox.textContent.includes('数据太少'),
    `got="${elements.errorBox.textContent}"`);

// ---- 场景 7：按钮状态复位 ----
check('按钮已恢复可用', elements.btnStart.disabled === false);
check('按钮文案为重新检测', elements.btnStart.textContent === '重新检测',
    `got="${elements.btnStart.textContent}"`);
check('进度条已隐藏', !elements.progressBar.classList.contains('active'));

// ---- 场景 8：看门狗 ----
// 帧回调停止触发时，看门狗应强制收尾而不是永久挂起
{
    // 样本足够 -> 直接出结果
    simulate({ bandDepth: 10, cycles: 3.33, fps: 30 });   // 先备好样本
    state.running = true;
    elements.resultCard.classList.remove('active');
    let cb = null;
    vm.runInContext('armWatchdog(1000)', Object.assign(sandbox, {
        setTimeout: (f) => { cb = f; return 1; },
        clearTimeout: () => {},
    }));
    cb();
    check('看门狗 样本足够时出结果',
        elements.resultCard.classList.contains('active') && !state.running);

    // 样本不足 -> 报错并复位
    state.timeSamples = [{ t: 0, lum: 100 }];
    state.running = true;
    elements.errorBox.textContent = '';
    elements.btnStart.disabled = true;
    vm.runInContext('armWatchdog(1000)', sandbox);
    cb();
    check('看门狗 样本不足时报错', elements.errorBox.textContent.includes('采集中断'),
        `got="${elements.errorBox.textContent.split('\n')[0]}"`);
    check('看门狗 报错后按钮复位', elements.btnStart.disabled === false && !state.running);
}

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
