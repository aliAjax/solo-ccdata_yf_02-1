// 并发文本编辑：编辑器打开期间对象被其他标签改写，关闭时不得静默提交旧草稿。
// 覆盖：取消=丢弃草稿保留远端；确定=明确覆盖。另验证无冲突时正常提交、不弹框。
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME_PATH;
const BASE = 'http://127.0.0.1:8123/index.html';
let failures = 0;
function check(name, cond, extra = '') {
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (extra ? '  [' + extra + ']' : ''));
  if (!cond) failures++;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const textOf = (page, id) => page.evaluate(id => __room.state.objects[id] && __room.state.objects[id].text, id);

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

  await A.evaluate(() => __room.addTestObject({ id: 'ec', type: 'note', x: 300, y: 300, w: 220, h: 90, text: '原始文本', color: 'yellow' }));
  await B.waitForFunction('!!__room.state.objects["ec"]');
  const svgA = await (await A.$('#svg')).boundingBox();
  const svgB = await (await B.$('#svg')).boundingBox();
  const dbl = async (page, box) => {
    const h = await page.$('[data-oid="ec"] rect'); const b = await h.boundingBox();
    await page.mouse.click(b.x + 40, b.y + 30);
    await page.mouse.click(b.x + 40, b.y + 30, { clickCount: 2 });
    await sleep(150);
  };
  const clickEmpty = async (page, box) => { await page.mouse.click(box.x + 60, box.y + 600); await sleep(250); };

  // 记录弹框；策略变量决定接受或取消
  let dialogPolicy = 'dismiss', dialogs = [];
  A.on('dialog', async d => { dialogs.push(d.message()); await (dialogPolicy === 'accept' ? d.accept() : d.dismiss()); });

  // ---- 轮次 1：A 编辑期间 B 改写，A 选择丢弃草稿 ----
  await dbl(A, svgA);
  check('A 编辑器打开且载入原文', await A.evaluate(() => !document.querySelector('#editor').hidden && document.querySelector('#editor').value === '原始文本'));
  await A.keyboard.type('A的草稿');
  await dbl(B, svgB);
  await B.keyboard.type('B的新版');
  await B.keyboard.down('Control'); await B.keyboard.press('Enter'); await B.keyboard.up('Control'); // B 提交
  await A.waitForFunction('__room.state.objects["ec"].text==="B的新版"');                            // A 收到远端改写时编辑器仍开着
  check('A 编辑器在远端改写后仍打开', await A.evaluate(() => !document.querySelector('#editor').hidden));
  dialogPolicy = 'dismiss'; dialogs = [];
  await clickEmpty(A, svgA);                                                                          // 关闭编辑器 → 触发冲突确认 → 取消
  check('检测到版本变化并弹确认框', dialogs.length === 1 && dialogs[0].includes('已被其他标签页修改'), 'dialogs=' + dialogs.length);
  check('丢弃草稿：两标签保留远端内容', (await textOf(A, 'ec')) === 'B的新版' && (await textOf(B, 'ec')) === 'B的新版',
    `A=${await textOf(A, 'ec')} B=${await textOf(B, 'ec')}`);
  check('丢弃草稿有提示', await A.evaluate(() => document.querySelector('#toast').textContent.includes('已丢弃草稿')));

  // ---- 轮次 2：再次并发，A 明确确认覆盖 ----
  await dbl(A, svgA);
  await A.keyboard.type('A的二稿');
  await dbl(B, svgB);
  await B.keyboard.type('B的三版');
  await B.keyboard.down('Control'); await B.keyboard.press('Enter'); await B.keyboard.up('Control');
  await A.waitForFunction('__room.state.objects["ec"].text==="B的三版"');
  dialogPolicy = 'accept'; dialogs = [];
  await clickEmpty(A, svgA);
  check('再次检测到冲突并弹框', dialogs.length === 1, 'dialogs=' + dialogs.length);
  await A.waitForFunction('__room.state.objects["ec"].text==="A的二稿"');
  await B.waitForFunction('__room.state.objects["ec"].text==="A的二稿"');
  check('确认覆盖：草稿提交并同步到 B', (await textOf(A, 'ec')) === 'A的二稿' && (await textOf(B, 'ec')) === 'A的二稿');

  // ---- 轮次 3：无并发编辑，正常提交不弹框 ----
  dialogs = [];
  await dbl(A, svgA);
  await A.keyboard.type('最终文本');
  await clickEmpty(A, svgA);
  check('无冲突编辑不弹确认框', dialogs.length === 0, 'dialogs=' + dialogs.length);
  await B.waitForFunction('__room.state.objects["ec"].text==="最终文本"');
  check('无冲突编辑正常提交并同步', (await textOf(A, 'ec')) === '最终文本' && (await textOf(B, 'ec')) === '最终文本');

  // ---- 覆盖提交可撤销（撤销守卫基于内容，仍有效）----
  await A.keyboard.down('Control'); await A.keyboard.press('z'); await A.keyboard.up('Control');
  await sleep(300);
  check('编辑提交可撤销并同步', (await textOf(A, 'ec')) === 'A的二稿' && (await textOf(B, 'ec')) === 'A的二稿',
    `A=${await textOf(A, 'ec')}`);

  await browser.close();
  console.log(failures === 0 ? '\nALL EDIT-CONFLICT CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
