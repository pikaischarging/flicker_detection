# 频闪检测工具

用手机摄像头检测灯光频闪的纯前端工具。无后端、无数据存储，所有分析在浏览器本地完成。

## 在线使用

部署后地址：`https://<你的用户名>.github.io/<仓库名>/`

> 摄像头 API 要求 HTTPS。GitHub Pages 默认是 HTTPS，可直接使用。本地测试需用 `localhost`，直接双击打开 `file://` 无法访问摄像头。

## 检测原理

两路互补分析：

| 方法 | 说明 | 作用 |
|------|------|------|
| 滚动快门条纹 | CMOS 逐行曝光把光源明暗变化"印"成画面横向条纹，对行方向做 FFT 求调制深度 | 主判据，不受帧率 Nyquist 限制，可测 100/120Hz |
| 帧间亮度 FFT | 逐帧取画面中心 ROI 平均亮度，重采样后做 FFT | 辅助，用于发现低频 PWM 调光 |

## 评级标准

| 等级 | 频闪百分比 | 说明 |
|------|-----------|------|
| ★★★ 优秀 | < 3.2% | 护眼灯级别 |
| ★★☆ 良好 | 3.2% ~ 8% | IEEE PAR 1789 低风险 |
| ★☆☆ 一般 | 8% ~ 25% | 合格但非最佳 |
| ☆☆☆ 较差 | > 25% | 建议更换 |

参考 IEEE PAR 1789、GB/T 9473-2022。页面内点击「标准说明」或长按结果卡片可查看完整对照表。

## 测量准确性

自动曝光是测量不稳定的首要原因——它会不断补偿亮度变化，把频闪信号削平。工具启动时会尝试通过 `applyConstraints` 锁定曝光，但移动浏览器普遍不支持 `exposureMode: manual`，因此：

- **iOS**：先在相机 App 或页面预览上长按屏幕锁定 AE/AF，再开始检测
- **Android**：Chrome 部分机型支持自动锁定，看页面顶部是否显示「曝光:已锁定」
- 固定距离（20~40cm）、关闭其他光源、保持手机稳定

结果是**相对值**，适合对比不同灯具，跨设备数值不可直接比较。精确测量请用专业频闪仪。

## 部署到 GitHub Pages

### 方式一：Actions 自动部署（已配置）

1. 新建仓库并推送代码：
   ```bash
   git init
   git add .
   git commit -m "feat: 频闪检测工具"
   git branch -M main
   git remote add origin https://github.com/<用户名>/<仓库名>.git
   git push -u origin main
   ```
2. 仓库 Settings → Pages → Build and deployment → Source 选择 **GitHub Actions**
3. 推送后 Actions 自动构建部署，完成后访问 `https://<用户名>.github.io/<仓库名>/`

### 方式二：分支直接部署

Settings → Pages → Source 选 **Deploy from a branch**，分支选 `main`、目录选 `/ (root)`。此时可以删掉 `.github/workflows/deploy.yml`。

## 本地预览

```bash
python -m http.server 8000
# 浏览器打开 http://localhost:8000
```

手机上测试局域网地址时，因为不是 HTTPS 也不是 localhost，摄像头会被拦截。两个办法：Chrome 的 `chrome://flags/#unsafely-treat-insecure-origin-as-secure` 加白名单，或直接部署到 Pages 后用真实域名访问（推荐）。

## 测试

```bash
node tests/algo.test.js      # 算法：FFT、条纹调制深度、闪烁指数、评级边界
node tests/pipeline.test.js  # 链路：合成场景 -> 评级 -> 绘图 -> 看门狗
node tests/dom.test.js       # HTML 与 JS 的 id / 事件 / CSS 类一致性
```

真实浏览器端到端测试（Chrome 虚拟摄像头，需要 `puppeteer-core`）：

```bash
npm install puppeteer-core
node tests/e2e.js
```

E2E 会起本地静态服务，用 `--use-fake-device-for-media-stream` 跑完整采集流程，检查有无 JS 错误、结果是否渲染、长按弹窗是否可用。脚本里的 Chrome 路径按需修改。

## 文件结构

```
├── index.html              页面结构、样式、标准说明弹窗
├── flicker.js              采集与分析逻辑（FFT、评级、绘图）
├── docs/
│   ├── requirements.md     需求文档（功能需求、评级标准、验收标准）
│   └── design.md           设计文档（检测原理、信号处理、模块结构）
├── tests/                  算法 / 链路 / DOM / 端到端测试
├── .nojekyll               跳过 Jekyll 处理
└── .github/workflows/
    └── deploy.yml          Pages 自动部署
```
