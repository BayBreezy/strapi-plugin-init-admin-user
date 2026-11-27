// End-to-end smoke test: installs the packed plugin into a fresh Strapi app,
// boots it and checks that the admin was created (and only once).
//
//   STRAPI_VERSION=latest node e2e/smoke.mjs     (run `npm run build` first)
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const version = process.env.STRAPI_VERSION || 'latest';
const port = 1400 + Math.floor(Math.random() * 500);
const work = mkdtempSync(join(tmpdir(), 'init-admin-e2e-'));
const app = join(work, 'app');

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

const adminLogin = (email, password) =>
  fetch(`http://localhost:${port}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

const login = async (email, password) => (await adminLogin(email, password)).status;

/** The admin permissions of a user, through the admin API. */
const adminPermissions = async (email, password) => {
  const { data } = await (await adminLogin(email, password)).json();
  const res = await fetch(`http://localhost:${port}/admin/users/me/permissions`, {
    headers: { authorization: `Bearer ${data.token}` },
  });
  return (await res.json()).data ?? [];
};

const apiStatus = async (token, path = '/api/users-permissions/roles') =>
  (
    await fetch(`http://localhost:${port}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    })
  ).status;

const isUp = async () => {
  try {
    return (await fetch(`http://localhost:${port}/_health`)).status === 204;
  } catch {
    return false;
  }
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Stops a Strapi started by `startStrapi`, including any processes it spawned. */
const stop = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((done) => child.once('exit', done));
  const signal = (name) => {
    try {
      process.kill(-child.pid, name); // the whole process group
    } catch {
      // already gone
    }
  };
  signal('SIGTERM');
  const timer = setTimeout(() => signal('SIGKILL'), 15_000);
  await exited;
  clearTimeout(timer);
  for (let attempt = 0; attempt < 30 && (await isUp()); attempt++) await sleep(500);
};

const running = new Set();

const startStrapi = async (env) => {
  // a Strapi that is still running would answer the health check instead of the new one
  if (await isUp()) throw new Error(`Port ${port} is still in use by an earlier Strapi`);

  const logs = [];
  // the scaffold leaves DATABASE_FILENAME empty, which breaks sqlite
  mkdirSync(join(app, '.tmp'), { recursive: true });
  // run the binary directly (npx doesn't forward signals) in its own process group
  const child = spawn(join(app, 'node_modules', '.bin', 'strapi'), ['start'], {
    cwd: app,
    detached: true,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      DATABASE_FILENAME: '.tmp/data.db',
      PORT: String(port),
      ...env,
    },
  });
  running.add(child);
  child.once('exit', () => running.delete(child));
  child.stdout.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr.on('data', (chunk) => logs.push(String(chunk)));

  for (let attempt = 0; attempt < 90; attempt++) {
    if (child.exitCode !== null) break;
    if (await isUp()) return { child, logs: () => logs.join('') };
    await sleep(1000);
  }
  await stop(child);
  throw new Error(`Strapi did not start:\n${logs.join('')}`);
};

const assert = (condition, message, details = '') => {
  if (!condition) throw new Error(`FAILED: ${message}\n${details}`);
  console.log(`ok - ${message}`);
};

try {
  console.log(`Scaffolding a Strapi app (target version: ${version}) in ${app}`);
  run(
    'npx',
    [
      '--yes',
      'create-strapi@latest',
      app,
      '--no-run',
      '--skip-cloud',
      '--js',
      '--use-npm',
      '--install',
      '--no-example',
      '--no-git-init',
      '--non-interactive',
      '--dbclient',
      'sqlite',
    ],
    work,
  );

  if (version !== 'latest') {
    // older create-strapi CLIs lack the non-interactive flags, so pin the packages instead
    const packages = ['@strapi/strapi', '@strapi/plugin-users-permissions', '@strapi/plugin-cloud'];
    run(
      'npm',
      [
        'install',
        '--save-exact',
        '--legacy-peer-deps',
        ...packages.map((name) => `${name}@${version}`),
      ],
      app,
    );
  }

  run('npm', ['pack', '--pack-destination', work], root);
  const tarball = execFileSync('ls', [work], { encoding: 'utf8' })
    .split('\n')
    .find((name) => name.endsWith('.tgz'));
  run('npm', ['install', join(work, tarball)], app);

  const creds = {
    INIT_ADMIN: 'true',
    INIT_ADMIN_EMAIL: 'e2e@example.com',
    INIT_ADMIN_PASSWORD: 'E2ePass1234',
    INIT_ADMINS: JSON.stringify([
      {
        email: 'editor@example.com',
        firstname: 'Ed',
        password: 'Editor1234',
        roles: ['strapi-editor'],
      },
      {
        email: 'qa@example.com',
        firstname: 'Q',
        password: 'QaPass1234',
        roles: ['qa'],
      },
    ]),
    INIT_ROLES: JSON.stringify([{ name: 'QA', code: 'qa', copyPermissionsFrom: 'strapi-editor' }]),
    INIT_API_TOKENS: JSON.stringify([
      { name: 'e2e', type: 'read-only', accessKey: 'e2e-fixed-token' },
      {
        name: 'e2e-custom',
        type: 'custom',
        permissions: ['plugin::users-permissions.role.find'],
        accessKey: 'e2e-custom-token',
      },
    ]),
  };

  // 1. first boot creates the admin
  let strapi = await startStrapi(creds);
  assert(strapi.logs().includes('Created admin'), 'logs the admin creation');
  assert(!strapi.logs().includes(creds.INIT_ADMIN_PASSWORD), 'does not log the password');
  assert(
    (await login(creds.INIT_ADMIN_EMAIL, creds.INIT_ADMIN_PASSWORD)) === 200,
    'admin can log in',
  );
  assert(
    (await login('editor@example.com', 'Editor1234')) === 200,
    'extra admin (INIT_ADMINS) can log in',
  );
  assert(
    (await apiStatus('e2e-fixed-token')) === 200,
    'fixed API token (INIT_API_TOKENS) works',
    strapi
      .logs()
      .split('\n')
      .filter((line) => /token/i.test(line))
      .join('\n'),
  );
  assert((await apiStatus('wrong-token')) === 401, 'a wrong API token is rejected');
  assert(
    (await apiStatus('e2e-custom-token')) === 200,
    'custom API token can use its permitted action',
  );
  // role.findOne is not in the token's permissions (only role.find is)
  const deniedStatus = await apiStatus('e2e-custom-token', '/api/users-permissions/roles/1');
  // Strapi 5.0.0 denies the request with a ForbiddenError but answers 500 instead of 403
  const forbidden =
    deniedStatus === 403 ||
    (deniedStatus === 500 && strapi.logs().includes('ForbiddenError: Forbidden access'));
  assert(
    forbidden,
    'custom API token is denied other actions',
    `GET /api/users-permissions/roles/1 returned ${deniedStatus}`,
  );
  const editorPermissions = await adminPermissions('editor@example.com', 'Editor1234');
  const qaPermissions = await adminPermissions('qa@example.com', 'QaPass1234');
  assert(
    qaPermissions.length > 0 && qaPermissions.length === editorPermissions.length,
    'seeded role (INIT_ROLES) copied the editor permissions',
    `qa: ${qaPermissions.length}, editor: ${editorPermissions.length}\n${strapi
      .logs()
      .split('\n')
      .filter((line) => /role/i.test(line))
      .join('\n')}`,
  );
  await stop(strapi.child);

  // 2. second boot with other credentials changes nothing
  strapi = await startStrapi({ ...creds, INIT_ADMIN_EMAIL: 'other@example.com' });
  assert(!strapi.logs().includes('Created admin'), 'does not create a second admin');
  assert(
    (await login('other@example.com', creds.INIT_ADMIN_PASSWORD)) !== 200,
    'other admin does not exist',
  );
  await stop(strapi.child);

  // 3. without INIT_ADMIN (production) nothing runs
  rmSync(join(app, '.tmp'), { recursive: true, force: true });
  strapi = await startStrapi({ INIT_ADMIN: '' });
  assert(
    !strapi.logs().includes('Created admin'),
    'is disabled outside development without INIT_ADMIN',
  );
  await stop(strapi.child);

  console.log('E2E passed');
} finally {
  for (const child of running) await stop(child);
  rmSync(work, { recursive: true, force: true });
}

// nothing should be left running, but never let a stray handle keep CI waiting
process.exit(0);
