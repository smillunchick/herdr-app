import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = path.resolve(app, '../herdr-web');
const dir = fs.mkdtempSync('/tmp/ha-');
const home = path.join(dir, 'home');
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, 'hello.txt'), 'Android file preview works.\n');
fs.writeFileSync(path.join(project, 'sample.js'), 'const answer = 42;\n');
const session = 'a';
const env = {
  PATH: process.env.PATH,
  USER: process.env.USER,
  LOGNAME: process.env.LOGNAME,
  LANG: 'en_US.UTF-8',
  HOME: home,
  SHELL: '/bin/sh',
  TMPDIR: dir,
  XDG_STATE_HOME: path.join(dir, 'state'),
  XDG_CONFIG_HOME: path.join(dir, 'config'),
  HC_SESSION: session,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
execFileSync('git', ['init', '-q', project], { env });
execFileSync('git', ['-C', project, 'config', 'user.name', 'Herdr Android test'], { env });
execFileSync('git', ['-C', project, 'config', 'user.email', 'android-check@localhost'], { env });
execFileSync('hc', ['server', 'start'], { env, timeout: 15000 });
const socket = path.join(env.XDG_STATE_HOME, 'herdr-core', session, `${session}.sock`);
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const connection = net.connect(socket);
    let bytes = '';
    connection.setTimeout(10000, () => connection.destroy(new Error('Scratch core timed out')));
    connection.on('connect', () => connection.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n'));
    connection.on('error', reject);
    connection.on('data', (chunk) => {
      bytes += chunk.toString();
      const end = bytes.indexOf('\n');
      if (end < 0) return;
      connection.end();
      const reply = JSON.parse(bytes.slice(0, end));
      reply.error ? reject(new Error(JSON.stringify(reply.error))) : resolve(reply.result);
    });
  });
}
const terminal = await rpc('terminal.run', {
  argv: ['/bin/sh', '-i'], cwd: project, keep: true, no_parent: true,
  env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  labels: { 'herdr.space': 'sp-android-check', 'herdr.tab': 'tb-android-check', 'herdr.seen': '0' },
});
const doc = await rpc('doc.get', { name: 'herdr-app' });
await rpc('doc.set', { name: 'herdr-app', version: doc.version, value: {
  spaces: [{ id: 'sp-android-check', name: 'Android check', folder: project, tabs: [{
    id: 'tb-android-check', name: 'Shell', root: { id: 'tb-android-check', type: 'row', children: [{
      id: 'p-android-check', type: 'block', content: { terminal: terminal.address },
    }] },
  }] }],
} });
const server = spawn(process.execPath, [path.join(web, 'server.mjs')], {
  cwd: web, env: { ...env, PORT: '4829', HOST: '127.0.0.1', HC_SOCKET: socket }, stdio: 'inherit',
});
fs.writeFileSync('/tmp/herdr-android-fixture.json', JSON.stringify({ dir, home, project, socket, session, terminal: terminal.address, port: 4829, pid: process.pid }, null, 2));
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.kill();
  try { execFileSync('hc', ['server', 'stop'], { env, timeout: 10000 }); } catch (error) { console.error(error.message); }
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
server.on('exit', (code) => { if (!stopping) { console.error('Scratch relay stopped', code); stop(); } });
console.log('Scratch core and relay only. State in /tmp/herdr-android-fixture.json');
