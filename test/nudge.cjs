// 微调与远端更新交错：A 微调 → B 远端更新 → A 再微调（900ms 合并窗口内）。
// 两次微调不得合并为同一撤销条目；较早快照立即失效，撤销不得恢复最初值。
// 另验证：无远端插入时，普通连续微调仍合并为一步撤销。
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME_PATH;
const BASE = 'http://127.0.0.1:8123/index.html';
let failures = 0;
function check(name, cond, extra = '') {
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (extra ? '  [' + extra + ']' : ''));
  if (!cond) failures++;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const xOf = (page, id) => page.evaluate(id => __room.state.objects[id] ? __room.state.objects[id].x : null, id);
async function clickObj(page, id) { // 选中（不产生移动）
  const h = await page.$(`[data-oid="${id}"] rect`);
  const box = await h.boundingBox();
  await page.mouse.click(box.x + 20, box.y + 20);
  await sleep(120);
}
const undoKey = async page => { await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control'); };

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const A = await browser.newPage();
  A.on('pageerror', e => { console.log('  PAGE-ERROR A:', e.message); failures++; });
  const B = await browser.newPage();
  B.on('pageerror', e => { console.log('  PAGE-ERROR B:', e.message); failures++; });
  await A.setViewport({ width: 1280, height: 800 });
  await B.setViewport({ width: 1280, height: 800 });
  await A.goto(BASE, { waitUntil: 'load' });
  await A.waitForFunction('window.__room && window.__room.roomId');
  const url = await A.url();
  await B.goto(url, { waitUntil: 'load' });
  await B.waitForFunction('window.__room && window.__room.roomId');

  // ---- 交错时序：A 微调 → B 远端微调 → A 再微调（均在 900ms 合并窗口内）----
  await A.evaluate(() => __room.addTestObject({ id: 'nj', type: 'note', x: 400, y: 400, w: 220, h: 90, text: '交错', color: 'yellow' }));
  await B.waitForFunction('!!__room.state.objects["nj"]');
  await clickObj(A, 'nj');
  await A.keyboard.press('ArrowRight');                    // A 微调 1：400→401
  await B.waitForFunction('__room.state.objects["nj"].x===401');
  await clickObj(B, 'nj');
  await B.keyboard.press('ArrowRight');                    // B 远端更新：401→402
  await A.waitForFunction('__room.state.objects["nj"].x===402');
  await A.keyboard.press('ArrowRight');                    // A 微调 2：402→403（不得与微调 1 合并）
  await sleep(200);
  check('交错后当前位置', await xOf(A, 'nj') === 403, 'x=' + await xOf(A, 'nj'));

  await undoKey(A);                                        // 撤销微调 2 → 402（B 的位置）
  await sleep(250);
  check('第一次撤销只回退微调 2，保留远端位置', await xOf(A, 'nj') === 402, 'x=' + await xOf(A, 'nj'));
  await undoKey(A);                                        // 微调 1 的条目已过期 → 跳过，不得回到 400
  await sleep(300);
  const xA = await xOf(A, 'nj'), xB = await xOf(B, 'nj');
  check('较早快照已失效：第二次撤销被跳过，两标签保持远端位置',
    xA === 402 && xB === 402, `A=${xA} B=${xB}`);
  const toast = await A.evaluate(() => document.querySelector('#toast').textContent);
  check('过期撤销给出提示', toast.includes('已跳过过期撤销'), toast);

  // ---- 普通连续微调仍合并为一步撤销 ----
  await A.evaluate(() => __room.addTestObject({ id: 'nj2', type: 'note', x: 700, y: 400, w: 220, h: 90, text: '合并', color: 'blue' }));
  await sleep(200);
  await clickObj(A, 'nj2');
  await A.keyboard.press('ArrowRight');                    // 700→701
  await sleep(150);
  await A.keyboard.press('ArrowRight');                    // 701→702（窗口内，无远端插入 → 合并）
  await sleep(150);
  await A.keyboard.press('ArrowRight');                    // 702→703
  await sleep(200);
  check('连续微调生效', await xOf(A, 'nj2') === 703, 'x=' + await xOf(A, 'nj2'));
  await undoKey(A);                                        // 一次撤销应直接回到 700
  await sleep(300);
  const mA = await xOf(A, 'nj2'), mB = await xOf(B, 'nj2');
  check('普通微调合并为一步撤销并同步到 B', mA === 700 && mB === 700, `A=${mA} B=${mB}`);

  await browser.close();
  console.log(failures === 0 ? '\nALL NUDGE-INTERLEAVE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
