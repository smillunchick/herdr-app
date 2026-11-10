import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(fs.readFileSync('/tmp/herdr-android-fixture.json', 'utf8'));
assert.match(fixture.dir, /^\/tmp\/ha-[A-Za-z0-9]+$/);
assert.equal(fixture.socket, `${fixture.dir}/state/herdr-core/a/a.sock`);
assert.equal(fixture.project, `${fixture.dir}/home/project`);
assert.equal(fixture.port, 4829);
const adb = process.env.ADB || '/opt/homebrew/share/android-commandlinetools/platform-tools/adb';
const serial = 'emulator-5570';
const pkg = 'dev.herdr.android.debug';
const folder = `/data/user/0/${pkg}/files/herdr-app`;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-native-proof-'));
const suffix = Date.now().toString(36);
const probe = `native-probe-${suffix}`;
const clone = `native-layout-${suffix}`;
const modCopy = `native-files-${suffix}`;
const large = `${fixture.project}/native-large-${suffix}.txt`;
const checks = [];
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const device = args => execFileSync(adb, ['-s', serial, ...args], {
  encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
});
function control(request) {
  const command = `printf '%s\\n' ${shellQuote(JSON.stringify(request))} | run-as ${pkg} toybox nc -W 8 -U ${folder}/herdr-app.sock`;
  const reply = JSON.parse(device(['shell', command]));
  if (reply.error) throw new Error(reply.error);
  return reply;
}
const run = (command, args = {}) => control({ do: command, args });
const status = () => control({ status: true });
const readApp = name => JSON.parse(device(['exec-out', 'run-as', pkg, 'cat', `${folder}/${name}`]));
function upload(relative, content) {
  const local = path.join(temporary, 'upload');
  fs.writeFileSync(local, content);
  const remote = `/data/local/tmp/herdr-native-${suffix}`;
  device(['push', local, remote]);
  try { device(['shell', `run-as ${pkg} cp ${remote} ${shellQuote(`${folder}/${relative}`)}`]); }
  finally { device(['shell', 'rm', remote]); }
}
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(fixture.socket);
    let buffer = '';
    socket.setTimeout(10000, () => socket.destroy(new Error(`Scratch ${method} timed out`)));
    socket.on('connect', () => socket.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n'));
    socket.on('error', reject);
    socket.on('data', data => {
      buffer += data;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      socket.end();
      const reply = JSON.parse(buffer.slice(0, newline));
      reply.error ? reject(new Error(JSON.stringify(reply.error))) : resolve(reply.result);
    });
  });
}
async function until(read, accept, label) {
  const deadline = Date.now() + 30000;
  let result;
  while (Date.now() < deadline) {
    result = await read();
    if (accept(result)) return result;
    await pause(200);
  }
  throw new Error(`${label}: ${JSON.stringify(result)}`);
}
async function check(name, action) {
  try {
    await action();
    checks.push({ name, passed: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    checks.push({ name, passed: false, error: error.message });
    throw error;
  }
}
const proof = () => readApp('shared.json')['android.native.proof'];
function source(revision) {
  return `import { View, div } from "gpui-kit";
import { appHome, readTextFile, exec, setShared, layout, theme } from "herdr";
export default class Probe extends View {
  init(_props, cx) {
    let tick = 0;
    cx.timer.every(150, () => setShared("android.native.tick", { revision: ${JSON.stringify(revision)}, tick: ++tick, background: layout().background }));
    cx.spawn(async cx => {
      try {
        const local = JSON.parse(await readTextFile(appHome() + "/settings.json"));
        const alias = appHome().includes("/data/user/0/")
          ? appHome().replace("/data/user/0/", "/data/data/")
          : appHome().replace("/data/data/", "/data/user/0/");
        const localAlias = JSON.parse(await readTextFile(alias + "/settings.json"));
        const text = await readTextFile(${JSON.stringify(`${fixture.project}/hello.txt`)});
        const missing = await readTextFile(${JSON.stringify(`${fixture.project}/absent-${suffix}.txt`)});
        let largeRejected = false;
        try { await readTextFile(${JSON.stringify(large)}); }
        catch (error) { largeRejected = String(error).includes("1 MiB"); }
        const command = await exec("sh", ["-c", "printf native-out; printf native-err >&2; exit 7"]);
        setShared("android.native.proof", { revision: ${JSON.stringify(revision)}, local: local.core, localAlias: localAlias.core, text, missing, largeRejected, command });
      } catch (error) { setShared("android.native.proof", { revision: ${JSON.stringify(revision)}, error: String(error) }); }
      cx.notify();
    });
  }
  render() { return div().size_full().p(12).text_color(theme().foreground).child("Native mod ${revision} 🌕"); }
}
`;
}
let pane;
let tab;
let inputTerminal;
let oldLayout;
try {
  await check('native window uses the scratch core', async () => {
    assert.equal(readApp('settings.json').core, 'http://127.0.0.1:4829', 'Refusing to test a non-scratch endpoint');
    const current = await until(status, s => s.space === 'sp-android-check', 'Scratch space was not shown');
    oldLayout = current.layout;
    assert.equal(current.layout, 'phone', 'Android starts on the phone layout');
    assert.equal(current.tab, 'tb-android-check');
    assert.deepEqual(current.errors, []);
  });
  for (const _ of status().overlays) run('app.back');
  fs.writeFileSync(large, 'x'.repeat(1024 * 1024 + 1));
  device(['shell', `run-as ${pkg} mkdir -p ${folder}/mods/${probe}`]);
  upload(`mods/${probe}/main.js`, source('v1'));
  const createdPane = await until(() => {
    try { return run('pane.split', { direction: 'down', pane: 'p-android-check', mod: probe }); }
    catch (error) {
      if (error.message === `no mod ${JSON.stringify(probe)} in mods/`) return null;
      throw error;
    }
  }, value => Boolean(value?.pane), 'The new mod was not discovered');
  pane = createdPane.pane;
  await check('native mod reads Android settings and server files', async () => {
    const result = await until(proof, value => value?.revision === 'v1', 'Native mod did not run');
    assert.equal(result.error, undefined);
    assert.equal(result.local, 'http://127.0.0.1:4829');
    assert.equal(result.localAlias, result.local);
    assert.equal(result.text, 'Android file preview works.\n');
    assert.equal(result.missing, null);
    assert.equal(result.largeRejected, true);
  });
  await check('native mod runs a server command with exact output and exit code', async () => {
    assert.deepEqual(proof().command, { code: 7, stdout: 'native-out', stderr: 'native-err' });
  });
  await check('a native mod pane reaches the shared core document', async () => {
    await until(() => rpc('doc.get', { name: 'herdr-app' }), doc => JSON.stringify(doc.value).includes(probe), 'Core document did not contain the mod pane');
  });
  await check('editing JavaScript reloads a native mod', async () => {
    upload(`mods/${probe}/main.js`, source('v2'));
    await until(proof, value => value?.revision === 'v2' && !value.error, 'Native mod did not reload');
  });
  await check('a broken edit keeps the last good native mod running', async () => {
    const before = readApp('shared.json')['android.native.tick'].tick;
    upload(`mods/${probe}/main.js`, 'export default class { invalid syntax !');
    await until(status, value => value.errors.length > 0, 'Broken edit was not reported');
    await until(() => readApp('shared.json')['android.native.tick'], value => value.revision === 'v2' && value.tick > before + 2, 'The last good mod stopped');
    upload(`mods/${probe}/main.js`, source('v3'));
    await until(proof, value => value?.revision === 'v3' && !value.error, 'Corrected mod did not recover');
    await until(status, value => value.errors.length === 0, 'Corrected mod still reports errors');
  });
  await check('cloned layouts reload without changing the desktop original', async () => {
    run('layout.clone', { name: 'main', as: clone });
    const original = readApp('layouts/main.json');
    const edited = readApp(`layouts/${clone}.json`);
    edited.background = '#153044';
    upload(`layouts/${clone}.json`, JSON.stringify(edited));
    await until(() => readApp('shared.json')['android.native.tick'], value => value?.background === '#153044', 'Layout change did not reach the native mod');
    assert.deepEqual(readApp('layouts/main.json'), original);
    run('layout.switch', { name: oldLayout });
  });
  await check('shipped mods clone as editable copies', async () => {
    run('mod.clone', { name: 'files', as: modCopy });
    const copied = device(['exec-out', 'run-as', pkg, 'cat', `${folder}/mods/${modCopy}/main.js`]);
    assert.ok(copied.includes('export default class Files'));
    assert.ok(!copied.includes('mods/files/'));
  });
  run('pane.close', { pane });
  pane = null;
  await check('new Android tabs reach the same core document', async () => {
    const created = run('tab.new', { name: 'Android proof', space: 'sp-android-check', folder: fixture.project, argv: ['/bin/sh', '-i'] });
    tab = created.tab;
    inputTerminal = created.terminal;
    assert.ok(tab && inputTerminal, JSON.stringify(created));
    await until(() => rpc('doc.get', { name: 'herdr-app' }), doc => JSON.stringify(doc.value).includes(tab), 'New tab did not reach the core');
  });
  await check('Android touch and keyboard input reaches the live terminal', async () => {
    run('terminal.show', { terminal: inputTerminal });
    device(['shell', 'input tap 600 500']);
    await until(() => {
      const state = device(['shell', '-n', 'dumpsys input_method']);
      return state.includes('mInputShown=true') && state.includes(`packageName=${pkg}`);
    }, Boolean, 'Android keyboard did not open for the app');
    const token = `HA_${suffix}_INPUT`;
    device(['shell', `input text ${shellQuote(`echo%s${token}`)}`]);
    device(['shell', 'input keyevent 66']);
    const env = { PATH: process.env.PATH, HOME: fixture.home, XDG_STATE_HOME: `${fixture.dir}/state`, XDG_CONFIG_HOME: `${fixture.dir}/config`, HC_SESSION: 'a' };
    await until(() => execFileSync('hc', ['read', inputTerminal, '--json'], { env, encoding: 'utf8', timeout: 10000 }), value => value.split(token).length >= 3, 'Android input did not execute in the core terminal');
  });
  await check('hardware shortcuts and Escape work while the Android text editor has focus', async () => {
    device(['shell', 'input keycombination 113 59 44']);
    await until(status, value => value.overlays.includes('frame-palette'), 'Ctrl+Shift+P did not open the palette');
    device(['shell', 'input keyevent 111']);
    await until(status, value => !value.overlays.includes('frame-palette'), 'Escape did not close the palette');
  });
  await check('Back closes the keyboard, then the popup, then leaves Files, then keeps Herdr open', async () => {
    for (const _ of status().overlays) run('app.back');
    await until(status, value => value.overlays.length === 0, 'Windows stayed open');
    run('layout.select', { stack: 'screen', child: 'files' });
    const shown = () => { try { return readApp('layouts/.state/phone.json').nodes?.screen?.active ?? 'main'; } catch { return 'main'; } };
    await until(shown, screen => screen === 'files', 'Files did not open');
    run('mod.open', { name: 'picker' });
    await until(status, value => value.overlays.includes('picker'), 'Picker did not open');
    const keyboard = () => device(['shell', '-n', 'dumpsys input_method']).includes('mInputShown=true');
    if (keyboard()) {
      device(['shell', 'input keyevent 4']);
      await until(keyboard, shown => !shown, 'Back did not close the keyboard first');
    }
    device(['shell', 'input keyevent 4']);
    await until(status, value => value.overlays.length === 0, 'Back did not close the picker');
    device(['shell', 'input keyevent 4']);
    await until(shown, screen => screen === 'main', 'Back did not return to the terminals');
    const top = device(['shell', 'dumpsys activity activities']).split('\n').find(line => line.includes('topResumedActivity')) ?? '';
    assert.ok(top.includes(pkg), `Herdr left too early: ${top}`);
  });
  await check('the key row sends Ctrl+C and a held Ctrl, and the keyboard Backspace deletes', async () => {
    const env = { PATH: process.env.PATH, HOME: fixture.home, XDG_STATE_HOME: `${fixture.dir}/state`, XDG_CONFIG_HOME: `${fixture.dir}/config`, HC_SESSION: 'a' };
    const screen = () => execFileSync('hc', ['read', inputTerminal, '--json'], { env, encoding: 'utf8', timeout: 10000 });
    device(['shell', 'input tap 600 900']);
    await until(() => device(['shell', '-n', 'dumpsys input_method']), state => state.includes('mInputShown=true'), 'Keyboard did not open');
    const xml = device(['exec-out', 'sh', '-c', 'uiautomator dump --windows /sdcard/herdr-keys.xml >/dev/null && cat /sdcard/herdr-keys.xml']);
    const keys = {};
    for (const m of xml.matchAll(/(?:text|content-desc)="([^"]+)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)) keys[m[1]] ??= [(+m[2] + +m[4]) >> 1, (+m[3] + +m[5]) >> 1];
    assert.ok(keys['^C'] && keys.Ctrl && keys.Delete, `Key row or keyboard Delete not found: ${Object.keys(keys)}`);
    const tap = ([x, y]) => device(['shell', `input tap ${x} ${y}`]);
    device(['shell', 'input text sleep%s300']);
    device(['shell', 'input keyevent 66']);
    await pause(500);
    tap(keys['^C']);
    const token = `HK_${suffix}`;
    device(['shell', `input text ${shellQuote(`echo%sDROPPED`)}`]);
    tap(keys.Ctrl);
    device(['shell', 'input keyevent 49']);
    device(['shell', `input text ${shellQuote(`echo%s${token}X`)}`]);
    await pause(500);
    tap(keys.Delete);
    await pause(500);
    device(['shell', 'input keyevent 66']);
    const lines = text => JSON.parse(text).text.split('\n').map(line => line.trim());
    await until(screen, value => lines(value).includes('^C') && lines(value).includes(token), 'Key row keys or Backspace did not reach the terminal');
    assert.ok(!lines(screen()).includes(`${token}X`), 'Backspace did not delete');
    assert.ok(!lines(screen()).includes('DROPPED'), 'Held Ctrl did not turn u into Ctrl+U');
  });
  await check('tapping a web address opens it in the phone browser', async () => {
    const env = { PATH: process.env.PATH, HOME: fixture.home, XDG_STATE_HOME: `${fixture.dir}/state`, XDG_CONFIG_HOME: `${fixture.dir}/config`, HC_SESSION: 'a' };
    const url = `https://example.com/herdr-${suffix}`;
    for (const _ of status().overlays) run('app.back');
    run('tab.select', { id: 'tb-android-check' });
    execFileSync('hc', ['send', 't1', `clear; echo ${url}`], { env, timeout: 10000 });
    await pause(1500);
    device(['logcat', '-c']);
    device(['shell', 'input tap 200 442']);
    await until(() => device(['logcat', '-d']), log => log.includes('act=android.intent.action.VIEW') && log.includes('from uid'), 'The tap did not ask Android to open the address');
    device(['shell', 'am force-stop com.android.chrome']);
    device(['shell', `am start -n ${pkg}/dev.herdr.android.HerdrActivity`]);
  });
} catch (error) {
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  try { if (tab) run('tab.close', { id: tab, confirmed: true }); } catch {}
  try { if (oldLayout) run('layout.switch', { name: oldLayout }); } catch {}
  try { if (pane) run('pane.close', { pane }); } catch {}
  fs.rmSync(large, { force: true });
  const apk = path.join(app, 'android/build/herdr-android-debug.apk');
  fs.writeFileSync('/tmp/herdr-android-native-proof.json', JSON.stringify({
    apkSha256: crypto.createHash('sha256').update(fs.readFileSync(apk)).digest('hex'),
    scope: 'Focused native checks only; full desktop parity remains unfinished.',
    focusedChecksPassed: checks.length === 14 && checks.every(check => check.passed),
    serial, fixture: fixture.dir, resources: { probe, clone, modCopy }, checks,
  }, null, 2));
  fs.rmSync(temporary, { recursive: true, force: true });
}
