// 端到端验证：多标签同步、刷新恢复、重复事件幂等、撤销重做、PNG 导出、窄屏与键盘
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.CHROME_PATH;
const BASE = 'http://127.0.0.1:8123/index.html';
let failures = 0;
function check(name, cond, extra = '') {
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (extra ? '  [' + extra + ']' : ''));
  if (!cond) failures++;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  // ---------- 标签页 A：创建对象 ----------
  const A = await browser.newPage();
  A.on('pageerror', e => { console.log('  PAGE-ERROR A:', e.message); failures++; });
  await A.setViewport({ width: 1280, height: 800 });
  await A.goto(BASE, { waitUntil: 'load' });
  await A.waitForFunction('window.__room && window.__room.roomId');
  const roomId = await A.evaluate(() => __room.roomId);
  const url = await A.url();
  check('生成稳定房间号并写入 URL', /^[A-Z0-9]{6}$/.test(roomId) && url.includes('#room=' + roomId), roomId);

  // 用键盘切工具 + 鼠标放置：便签
  await A.keyboard.press('n');
  const svgBox = await (await A.$('#svg')).boundingBox();
  await A.mouse.click(svgBox.x + 300, svgBox.y + 200);          // 放置便签并自动进入编辑
  await A.keyboard.type('本周目标：打通流程');
  await A.keyboard.down('Control'); await A.keyboard.press('Enter'); await A.keyboard.up('Control');
  // 矩形：拖拽绘制
  await A.keyboard.press('r');
  await A.mouse.move(svgBox.x + 600, svgBox.y + 350);
  await A.mouse.down(); await A.mouse.move(svgBox.x + 780, svgBox.y + 460, { steps: 5 }); await A.mouse.up();
  // 连线：拖拽
  await A.keyboard.press('l');
  await A.mouse.move(svgBox.x + 420, svgBox.y + 250);
  await A.mouse.down(); await A.mouse.move(svgBox.x + 600, svgBox.y + 400, { steps: 5 }); await A.mouse.up();
  // 圆形 + 文本：单击放置
  await A.keyboard.press('c'); await A.mouse.click(svgBox.x + 900, svgBox.y + 500);
  await A.keyboard.press('t'); await A.mouse.click(svgBox.x + 200, svgBox.y + 500);
  await A.keyboard.type('hello');
  await A.keyboard.down('Control'); await A.keyboard.press('Enter'); await A.keyboard.up('Control');
  await sleep(200);
  const countA = await A.evaluate(() => Object.keys(__room.state.objects).length);
  check('新增 5 类对象（便签/矩形/连线/圆形/文本）', countA === 5, 'count=' + countA);

  // ---------- 标签页 B：实时同步 ----------
  const B = await browser.newPage();
  B.on('pageerror', e => { console.log('  PAGE-ERROR B:', e.message); failures++; });
  await B.setViewport({ width: 1280, height: 800 });
  await B.goto(url, { waitUntil: 'load' });
  await B.waitForFunction('window.__room && Object.keys(window.__room.state.objects).length === 5');
  const noteInB = await B.evaluate(() => {
    const o = Object.values(__room.state.objects).find(o => o.type === 'note');
    return o && o.text;
  });
  check('多标签同步：B 标签页看到 A 创建的便签', noteInB === '本周目标：打通流程', noteInB);
  const presence = await B.evaluate(() => document.querySelector('#presence').textContent);
  await sleep(2500);
  const presence2 = await B.evaluate(() => document.querySelector('#presence').textContent);
  check('在线标签页计数为 2', (presence2 || presence).includes('2'), presence2);

  // B 中渲染出 SVG 节点
  const rendered = await B.evaluate(() => document.querySelectorAll('#layer [data-oid]').length);
  check('B 标签页 SVG 渲染 5 个对象', rendered === 5, 'rendered=' + rendered);

  // ---------- A 移动对象 → B 同步 ----------
  const noteId = await A.evaluate(() => Object.values(__room.state.objects).find(o => o.type === 'note').id);
  const before = await A.evaluate(id => { const o = __room.state.objects[id]; return { x: o.x, y: o.y }; }, noteId);
  const noteBox = await (await A.$(`[data-oid="${noteId}"] rect`)).boundingBox();
  await A.mouse.move(noteBox.x + 30, noteBox.y + 20);
  await A.mouse.down(); await A.mouse.move(noteBox.x + 130, noteBox.y + 90, { steps: 6 }); await A.mouse.up();
  await sleep(300);
  const movedB = await B.evaluate(id => { const o = __room.state.objects[id]; return { x: o.x, y: o.y }; }, noteId);
  check('移动实时同步到 B', movedB.x === before.x + 100 && movedB.y === before.y + 70, JSON.stringify(movedB));

  // B 编辑文本 → A 同步
  await B.evaluate(id => {
    const o = __room.state.objects[id];
    __room.applyEvent; // noop
    const ev = { kind: 'set', objId: id, patch: { text: 'B 编辑过' } };
    // 通过 UI 路径：直接构造提交（等价于编辑命令）
    const before = { text: o.text };
    window.__testCommit ? null : null;
    // 使用内部 commit 不可达，改为模拟完整事件流：
    const doEv = { ...ev, id: 'b-edit-1', ts: Date.now() };
    __room.applyEvent(doEv);
    localStorage.setItem('sync:' + __room.roomId, JSON.stringify({ ev: doEv, n: 'x1' }));
  }, noteId);
  await sleep(300);
  const textInA = await A.evaluate(id => __room.state.objects[id].text, noteId);
  check('B 编辑经 storage 通道同步到 A', textInA === 'B 编辑过', textInA);

  // ---------- 重复事件幂等 ----------
  const dupResult = await B.evaluate(() => {
    const ev = { id: 'dup-evt-1', kind: 'add', obj: { id: 'dup-obj', type: 'text', x: 50, y: 50, w: 60, h: 30, text: 'dup' } };
    const r1 = __room.applyEvent(ev);
    const n1 = Object.keys(__room.state.objects).length;
    const r2 = __room.applyEvent(ev);          // 同一事件再次到达（BC + storage 双通道场景）
    const n2 = Object.keys(__room.state.objects).length;
    // 重放已应用过的真实事件
    const syncRaw = localStorage.getItem('sync:' + __room.roomId);
    const r3 = syncRaw ? __room.applyEvent(JSON.parse(syncRaw).ev) : 'no-sync-key';
    return { r1, r2, r3, n1, n2 };
  });
  check('重复事件不重复应用', dupResult.r1 === true && dupResult.r2 === false && dupResult.r3 === false && dupResult.n1 === dupResult.n2, JSON.stringify(dupResult));
  // 清理测试对象
  await B.evaluate(() => __room.applyEvent({ id: 'cleanup-1', kind: 'remove', objId: 'dup-obj' }));

  // ---------- 撤销 / 重做 ----------
  const posBeforeUndo = await A.evaluate(id => { const o = __room.state.objects[id]; return { x: o.x, y: o.y }; }, noteId);
  await A.keyboard.down('Control'); await A.keyboard.press('z'); await A.keyboard.up('Control'); // 撤销移动
  await sleep(200);
  const posAfterUndo = await A.evaluate(id => { const o = __room.state.objects[id]; return { x: o.x, y: o.y }; }, noteId);
  check('撤销移动恢复原位', posAfterUndo.x === before.x && posAfterUndo.y === before.y, JSON.stringify(posAfterUndo));
  await sleep(300);
  const posInB = await B.evaluate(id => { const o = __room.state.objects[id]; return { x: o.x, y: o.y }; }, noteId);
  check('撤销作为事件同步到 B', posInB.x === before.x && posInB.y === before.y);
  await A.keyboard.down('Control'); await A.keyboard.down('Shift'); await A.keyboard.press('z'); await A.keyboard.up('Shift'); await A.keyboard.up('Control'); // 重做
  await sleep(200);
  const posAfterRedo = await A.evaluate(id => { const o = __room.state.objects[id]; return { x: o.x, y: o.y }; }, noteId);
  check('重做恢复移动后位置', posAfterRedo.x === posBeforeUndo.x && posAfterRedo.y === posBeforeUndo.y);

  // Delete 键删除 + 撤销删除
  const countBefore = await A.evaluate(() => Object.keys(__room.state.objects).length);
  await A.evaluate(id => { // 选中对象
    document.querySelector(`[data-oid="${id}"]`).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    document.querySelector('#svg').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
  }, noteId);
  await A.keyboard.press('Delete');
  await sleep(200);
  const countAfterDel = await A.evaluate(() => Object.keys(__room.state.objects).length);
  check('Delete 键删除选中对象', countAfterDel === countBefore - 1, countBefore + '->' + countAfterDel);
  await A.keyboard.down('Control'); await A.keyboard.press('z'); await A.keyboard.up('Control');
  await sleep(200);
  const countAfterUndoDel = await A.evaluate(() => Object.keys(__room.state.objects).length);
  check('撤销删除恢复对象', countAfterUndoDel === countBefore);

  // ---------- 刷新恢复 ----------
  await A.reload({ waitUntil: 'load' });
  await A.waitForFunction('window.__room && window.__room.roomId');
  const restored = await A.evaluate(() => ({
    n: Object.keys(__room.state.objects).length,
    note: Object.values(__room.state.objects).find(o => o.type === 'note')?.text,
    room: __room.roomId,
  }));
  check('刷新后房间号与数据恢复', restored.n === countBefore && restored.note === 'B 编辑过' && restored.room === roomId, JSON.stringify(restored));
  const lsRaw = await A.evaluate(id => localStorage.getItem('room:' + id), roomId);
  check('数据写入 localStorage', !!lsRaw && JSON.parse(lsRaw).order.length === countBefore);

  // ---------- PNG 导出 ----------
  const png = await A.evaluate(async () => {
    const blob = await __room.exportPNG();
    const buf = await blob.arrayBuffer();
    return Array.from(new Uint8Array(buf.slice(0, 64)));
  });
  const magic = Buffer.from(png.slice(0, 8)).toString('hex');
  const w = png[16] << 24 | png[17] << 16 | png[18] << 8 | png[19];
  const h = png[20] << 24 | png[21] << 16 | png[22] << 8 | png[23];
  check('导出真实 PNG（魔数 + 尺寸）', magic === '89504e470d0a1a0a' && w > 100 && h > 100, `magic=${magic} ${w}x${h}`);
  const exportInfo = await A.evaluate(() => {
    const { xml, bbox } = __room.buildExportSVG();
    return { hasToolbar: /toolbar|topbar|导出 PNG/.test(xml), bbox, hasContent: xml.includes('B 编辑过') };
  });
  check('导出内容不含工具栏、包含画布内容', !exportInfo.hasToolbar && exportInfo.hasContent, JSON.stringify(exportInfo.bbox));
  // 保存一份完整 PNG 到磁盘供检查
  const fullPng = await A.evaluate(async () => {
    const blob = await __room.exportPNG();
    const buf = await blob.arrayBuffer();
    let bin = ''; const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(bin);
  });
  fs.writeFileSync('/workspace/export-test.png', Buffer.from(fullPng, 'base64'));
  check('PNG 已落盘 export-test.png', fs.statSync('/workspace/export-test.png').size > 5000, fs.statSync('/workspace/export-test.png').size + ' bytes');

  // ---------- 窄屏可用 ----------
  const C = await browser.newPage();
  await C.setViewport({ width: 390, height: 760 });
  await C.goto(url, { waitUntil: 'load' });
  await C.waitForFunction('window.__room && window.__room.roomId');
  const narrow = await C.evaluate(() => {
    const tools = [...document.querySelectorAll('.tool')].every(b => b.getBoundingClientRect().width > 0);
    const n = Object.keys(__room.state.objects).length;
    return { tools, n, noHScroll: document.documentElement.scrollWidth <= 395 };
  });
  check('窄屏(390px)：工具可用、数据同步、无横向页面滚动', narrow.tools && narrow.n === countBefore && narrow.noHScroll, JSON.stringify(narrow));
  // 窄屏下用键盘+鼠标新增一个矩形
  await C.keyboard.press('r');
  const svgC = await (await C.$('#svg')).boundingBox();
  await C.mouse.click(svgC.x + 150, Math.max(svgC.y + 10, 250));
  await sleep(300);
  const countNarrow = await C.evaluate(() => Object.keys(__room.state.objects).length);
  check('窄屏下可新增对象并同步', countNarrow === countBefore + 1, 'count=' + countNarrow);
  const inA = await A.evaluate(() => Object.keys(__room.state.objects).length);
  check('窄屏新增同步回 A', inA === countBefore + 1, 'A count=' + inA);

  await browser.close();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
