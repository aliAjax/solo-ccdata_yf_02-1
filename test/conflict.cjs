// 并发撤销冲突测试：双标签先后移动同一对象，较早标签的过期撤销不得覆盖较新位置；
// 正常单标签撤销链不受影响；过期的"撤销添加"不得删除他人已移动的对象。
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME_PATH;
const BASE = 'http://127.0.0.1:8123/index.html';
let failures = 0;
function check(name, cond, extra = '') {
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (extra ? '  [' + extra + ']' : ''));
  if (!cond) failures++;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const posOf = (page, id) => page.evaluate(id => {
  const o = __room.state.objects[id];
  return o ? { x: o.x, y: o.y } : null;
}, id);
async function dragObj(page, id, dx, dy) {
  const h = await page.$(`[data-oid="${id}"] rect, [data-oid="${id}"] ellipse, [data-oid="${id}"] line`);
  const box = await h.boundingBox();
  await page.mouse.move(box.x + 12, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + 12 + dx, box.y + 12 + dy, { steps: 5 });
  await page.mouse.up();
  await sleep(250);
}
const eq = (a, b) => a && b && a.x === b.x && a.y === b.y;

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const A = await browser.newPage();
  A.on('pageerror', e => { console.log('  PAGE-ERROR A:', e.message); failures++; });
  const B = await browser.newPage();
  B.on('pageerror', e => { console.log('  PAGE-ERROR B:', e.message); failures++; });
  await A.setViewport({ width: 1280, height: 800 });
  await B.setViewport({ width: 1280, height: 800 });

  // A 创建便签
  await A.goto(BASE, { waitUntil: 'load' });
  await A.waitForFunction('window.__room && window.__room.roomId');
  const url = await A.url();
  await A.keyboard.press('n');
  const svgA = await (await A.$('#svg')).boundingBox();
  await A.mouse.click(svgA.x + 300, svgA.y + 200);
  await A.keyboard.type('冲突测试');
  await A.keyboard.down('Control'); await A.keyboard.press('Enter'); await A.keyboard.up('Control');
  await sleep(200);
  const noteId = await A.evaluate(() => Object.values(__room.state.objects).find(o => o.type === 'note').id);
  const pos0 = await posOf(A, noteId);

  // B 进入同一房间
  await B.goto(url, { waitUntil: 'load' });
  await B.waitForFunction(`window.__room && window.__room.state.objects["${noteId}"]`);

  // A 移动 → B 收到；B 再移动 → A 收到（并发：A 的撤销条目已过期）
  await dragObj(A, noteId, 100, 70);
  const pos1 = { x: pos0.x + 100, y: pos0.y + 70 };
  await B.waitForFunction(`(()=>{const o=__room.state.objects["${noteId}"];return o&&o.x===${pos1.x}&&o.y===${pos1.y}})()`);
  await dragObj(B, noteId, 50, 50);
  const pos2 = { x: pos1.x + 50, y: pos1.y + 50 };
  await A.waitForFunction(`(()=>{const o=__room.state.objects["${noteId}"];return o&&o.x===${pos2.x}&&o.y===${pos2.y}})()`);

  // 关键场景：较早标签 A 执行撤销 —— 不得把 pos2 覆盖回 pos1
  await A.keyboard.down('Control'); await A.keyboard.press('z'); await A.keyboard.up('Control');
  await sleep(400);
  const afterStaleUndoA = await posOf(A, noteId);
  const afterStaleUndoB = await posOf(B, noteId);
  check('过期撤销被跳过：A 撤销后位置仍为 B 的较新位置',
    eq(afterStaleUndoA, pos2) && eq(afterStaleUndoB, pos2),
    `A=${JSON.stringify(afterStaleUndoA)} B=${JSON.stringify(afterStaleUndoB)} 期望=${JSON.stringify(pos2)}`);
  const toast = await A.evaluate(() => document.querySelector('#toast').textContent);
  check('过期撤销给出提示', toast.includes('已跳过过期撤销'), toast);

  // 较新标签 B 撤销自己的移动 —— 仍有效，正常生效并同步
  await B.keyboard.down('Control'); await B.keyboard.press('z'); await B.keyboard.up('Control');
  await sleep(400);
  check('B 撤销自己的移动生效并同步到 A',
    eq(await posOf(A, noteId), pos1) && eq(await posOf(B, noteId), pos1), JSON.stringify(pos1));

  // B 重做 —— 恢复 pos2 并同步
  await B.keyboard.down('Control'); await B.keyboard.down('Shift'); await B.keyboard.press('z');
  await B.keyboard.up('Shift'); await B.keyboard.up('Control');
  await sleep(400);
  check('B 重做恢复较新位置并同步到 A',
    eq(await posOf(A, noteId), pos2) && eq(await posOf(B, noteId), pos2), JSON.stringify(pos2));

  // 正常单标签撤销链不受影响：A 连续移动两次，两次撤销逐级回退
  await dragObj(A, noteId, 10, 10);
  const pos3 = { x: pos2.x + 10, y: pos2.y + 10 };
  await dragObj(A, noteId, 10, 10);
  const pos4 = { x: pos3.x + 10, y: pos3.y + 10 };
  await A.keyboard.down('Control'); await A.keyboard.press('z'); await A.keyboard.up('Control');
  await sleep(300);
  check('单标签撤销链：第一次撤销回退一步', eq(await posOf(A, noteId), pos3), JSON.stringify(pos3));
  await A.keyboard.down('Control'); await A.keyboard.press('z'); await A.keyboard.up('Control');
  await sleep(300);
  const chainB = await posOf(B, noteId);
  check('单标签撤销链：第二次撤销再回退一步并同步到 B',
    eq(await posOf(A, noteId), pos2) && eq(chainB, pos2), JSON.stringify(pos2));

  // 过期的"撤销添加"不得删除他人已移动的对象
  await A.evaluate(() => __room.addTestObject({ id: 'obj-x', type: 'text', x: 900, y: 600, w: 80, h: 30, text: 'X', color: 'yellow' }));
  await B.waitForFunction('!!__room.state.objects["obj-x"]');
  await dragObj(B, 'obj-x', 40, 40);
  await A.waitForFunction('__room.state.objects["obj-x"].x===940');
  await A.keyboard.down('Control'); await A.keyboard.press('z'); await A.keyboard.up('Control');
  await sleep(400);
  const xA = await posOf(A, 'obj-x');
  const xB = await posOf(B, 'obj-x');
  check('过期"撤销添加"被跳过：对象保留在 B 移动后的位置',
    eq(xA, { x: 940, y: 640 }) && eq(xB, { x: 940, y: 640 }),
    `A=${JSON.stringify(xA)} B=${JSON.stringify(xB)}`);

  await browser.close();
  console.log(failures === 0 ? '\nALL CONFLICT CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
