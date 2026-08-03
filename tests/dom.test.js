const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'flicker.js'), 'utf8');

const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
const jsIds = new Set([...js.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]));

console.log('HTML 中的 id:', [...htmlIds].join(', '));
const missing = [...jsIds].filter(i => !htmlIds.has(i));
console.log('JS 引用但 HTML 缺失:', missing.length ? missing.join(', ') : '(无)');

const handlers = new Set([...html.matchAll(/on\w+="(\w+)\(/g)].map(m => m[1]));
const defined = new Set([...js.matchAll(/^(?:async )?function (\w+)/gm)].map(m => m[1]));
const undef = [...handlers].filter(h => !defined.has(h) && h !== 'event');
console.log('内联事件处理器:', [...handlers].join(', '));
console.log('未定义的处理器:', undef.length ? undef.join(', ') : '(无)');

// CSS 类使用情况：JS 里 classList 操作的类是否在样式表中定义
const cssClasses = new Set([...html.matchAll(/\.([a-zA-Z][\w-]*)\s*[,{]/g)].map(m => m[1]));
const jsClasses = new Set([...js.matchAll(/classList\.\w+\('([^']+)'\)/g)].map(m => m[1]));
const missingCss = [...jsClasses].filter(c => !cssClasses.has(c));
console.log('JS 操作但 CSS 未定义的类:', missingCss.length ? missingCss.join(', ') : '(无)');

process.exit(missing.length + undef.length + missingCss.length === 0 ? 0 : 1);
