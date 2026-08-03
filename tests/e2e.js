/* 真实 Chrome + 虚拟摄像头的端到端验证 */
const puppeteer = require('puppeteer-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || path.join(__dirname, '..');
const PORT = 8123;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
});

(async () => {
    await new Promise(r => server.listen(PORT, r));
    console.log(`server: http://localhost:${PORT}`);

    const browser = await puppeteer.launch({
        executablePath: CHROME,
        headless: 'shell',
        args: [
            '--use-fake-device-for-media-stream',   // 虚拟摄像头（滚动条纹测试图）
            '--use-fake-ui-for-media-stream',       // 自动授权
            '--autoplay-policy=no-user-gesture-required',
            '--no-sandbox',
        ],
    });

    const page = await browser.newPage();
    const errors = [];
    const consoleMsgs = [];
    page.on('console', m => {
        consoleMsgs.push(`[${m.type()}] ${m.text()}`);
        if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('requestfailed', r => errors.push('requestfailed: ' + r.url()));

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' });

    let pass = 0, fail = 0;
    const check = (name, cond, extra = '') => {
        if (cond) { pass++; console.log(`  PASS  ${name} ${extra}`); }
        else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
    };

    // --- 静态渲染检查 ---
    check('标题正确', (await page.title()) === '频闪检测工具');
    check('flicker.js 已加载（函数存在）',
        await page.evaluate(() => typeof startMeasure === 'function' && typeof fft === 'function'));
    check('初始无错误提示',
        await page.evaluate(() => getComputedStyle(document.getElementById('errorBox')).display === 'none'));
    check('结果卡片初始隐藏',
        await page.evaluate(() => getComputedStyle(document.getElementById('resultCard')).display === 'none'));

    // --- 标准说明弹窗 ---
    await page.click('#btnDetail');
    await new Promise(r => setTimeout(r, 200));
    check('弹窗可打开',
        await page.evaluate(() => getComputedStyle(document.getElementById('modalOverlay')).display === 'flex'));
    const modalText = await page.$eval('#modalOverlay', el => el.innerText);
    check('弹窗含评级标准', modalText.includes('3.2%') && modalText.includes('IEEE PAR 1789'));
    check('弹窗含常见光源对照', modalText.includes('电感镇流器') && modalText.includes('护眼灯'));
    check('弹窗含 GB/T 9473', modalText.includes('GB/T 9473-2022'));
    await page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 200));
    check('Esc 可关闭弹窗',
        await page.evaluate(() => getComputedStyle(document.getElementById('modalOverlay')).display === 'none'));

    // --- 完整检测流程（虚拟摄像头）---
    await page.click('#btnStart');
    // 采集 4s + 预热 0.7s，留足余量
    await page.waitForFunction(
        () => document.getElementById('resultCard').classList.contains('active') ||
              getComputedStyle(document.getElementById('errorBox')).display !== 'none',
        { timeout: 25000, polling: 300 }
    );

    const shot = await page.evaluate(() => ({
        err: document.getElementById('errorBox').textContent,
        rating: document.getElementById('resultRating').textContent,
        value: document.getElementById('resultValue').textContent,
        desc: document.getElementById('resultDesc').textContent,
        freq: document.getElementById('resultFreq').innerText,
        camera: document.getElementById('cameraInfo').textContent,
        btn: document.getElementById('btnStart').textContent,
        waveShown: document.getElementById('waveformContainer').classList.contains('active'),
        fftShown: document.getElementById('fftContainer').classList.contains('active'),
        waveHasPixels: (() => {
            const c = document.getElementById('waveformCanvas');
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
            return false;
        })(),
        fftHasPixels: (() => {
            const c = document.getElementById('fftCanvas');
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
            return false;
        })(),
    }));

    console.log('\n  --- 实测输出 ---');
    console.log('  相机:', shot.camera);
    console.log('  评级:', shot.rating, '|', shot.value);
    console.log('  详情:', shot.freq.replace(/\n/g, ' / '));

    check('检测无错误', shot.err === '', shot.err);
    check('产出评级', /优秀|良好|一般|较差/.test(shot.rating), `got="${shot.rating}"`);
    check('产出百分比数值', /频闪百分比 ≈ \d+(\.\d+)?%/.test(shot.value), `got="${shot.value}"`);
    check('显示分析方式与置信度',
        /分析方式：(滚动快门条纹|帧间亮度)/.test(shot.freq) && /置信度：(高|中|低)/.test(shot.freq));
    check('显示帧数与帧率', /\d+帧 @ \d+fps/.test(shot.freq), shot.freq.split('\n').pop());
    check('相机信息已填充', /\d+×\d+/.test(shot.camera), `got="${shot.camera}"`);
    check('波形区域已显示', shot.waveShown);
    check('频谱区域已显示', shot.fftShown);
    check('波形画布有实际绘制', shot.waveHasPixels);
    check('频谱画布有实际绘制', shot.fftHasPixels);
    check('按钮恢复为「重新检测」', shot.btn === '重新检测', `got="${shot.btn}"`);
    // 一致性：走帧间亮度判据时不应标"置信度：高"，且应提示混叠风险
    const usedTemporal = /分析方式：帧间亮度/.test(shot.freq);
    check('判据与置信度自洽',
        !usedTemporal || !/置信度：高/.test(shot.freq),
        `temporal=${usedTemporal} freq="${shot.freq.replace(/\n/g, ' / ')}"`);
    check('帧间亮度判据标注混叠风险',
        !usedTemporal || /混叠/.test(shot.freq) || /未识别/.test(shot.freq));

    // --- 长按结果卡片打开弹窗 ---
    // 卡片可能在折叠下方，需先滚入视口，否则鼠标坐标落在视口外
    await page.$eval('#resultCard', el => el.scrollIntoView({ block: 'center' }));
    await new Promise(r => setTimeout(r, 300));
    const box = await page.$eval('#resultCard', el => {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    await new Promise(r => setTimeout(r, 800));
    await page.mouse.up();
    check('长按结果卡片打开标准说明',
        await page.evaluate(() => getComputedStyle(document.getElementById('modalOverlay')).display === 'flex'),
        `press@(${box.x.toFixed(0)},${box.y.toFixed(0)})`);

    // --- 无 JS 错误 ---
    check('无 JS 运行时错误', errors.length === 0, errors.join(' | '));

    await browser.close();
    server.close();

    console.log(`\n结果: ${pass} passed, ${fail} failed`);
    if (errors.length) console.log('错误明细:\n' + errors.join('\n'));
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('E2E 异常:', e); server.close(); process.exit(1); });
