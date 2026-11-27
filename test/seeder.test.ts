import { beforeEach, describe, expect, it, vi } from 'vitest';

import bootstrap from '../server/src/bootstrap';
import type { PluginConfig, Strapi } from '../server/src/lib/types';
import { createSeeder } from '../server/src/services/seeder';

const baseConfig = (overrides: Partial<PluginConfig> = {}): PluginConfig => ({
  mode: 'auto',
  admin: {
    username: 'admin',
    password: 'Secret123',
    firstname: 'Admin',
    lastname: 'Admin',
    email: 'Admin@Example.com',
  },
  admins: [],
  roles: [],
  apiTokens: [],
  ...overrides,
});

const EDITOR_PERMISSIONS = [
  {
    id: 7,
    action: 'plugin::content-manager.explorer.read',
    actionParameters: {},
    subject: 'api::article.article',
    properties: { fields: ['title'] },
    conditions: [],
    role: { id: 2 },
  },
];

const makeStrapi = ({ users = 0, firstAdmin = true, tokenKind = true } = {}) => {
  const state = { users, roles: [] as { id: number; name: string; code: string }[] };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const user = {
    create: vi.fn(async () => {
      state.users += 1;
    }),
    createFirstAdmin: vi.fn(async () => {
      state.users += 1;
    }),
  };
  const role = {
    createRolesIfNoneExist: vi.fn(async () => {}),
    getSuperAdmin: vi.fn(async () => ({ id: 1, name: 'Super Admin', code: 'strapi-super-admin' })),
    create: vi.fn(async (attrs) => {
      const created = { id: state.roles.length + 10, ...attrs };
      state.roles.push(created);
      return created;
    }),
    assignPermissions: vi.fn(async () => []),
  };
  const permission = {
    findMany: vi.fn(async ({ where }: { where: { role: { id: number } } }) =>
      where.role.id === 2 ? EDITOR_PERMISSIONS : [],
    ),
  };
  const apiToken = {
    exists: vi.fn(async () => false),
    create: vi.fn(async (attrs: Record<string, unknown>) => ({
      id: 1,
      ...attrs,
      accessKey: 'generated',
    })),
    hash: vi.fn((key: string) => `hashed:${key}`),
  };
  const services: Record<string, unknown> = {
    'admin::permission': permission,
    'admin::api-token': apiToken,
  };

  const strapi = {
    log,
    config: { get: vi.fn() },
    service: (uid: string) => services[uid],
    contentType: (uid: string) =>
      uid === 'admin::api-token'
        ? { attributes: { name: {}, ...(tokenKind && { kind: {} }) } }
        : undefined,
    admin: { services: { user: firstAdmin ? user : { create: user.create }, role } },
    db: {
      query: (uid: string) => ({
        count: async ({ where }: { where?: { email?: string } } = {}) =>
          uid === 'admin::user' ? (where?.email ? 0 : state.users) : 0,
        findOne: async ({ where }: { where: { $or: Record<string, string>[] } }) =>
          state.roles.find((r) =>
            where.$or.some((c) =>
              Object.entries(c).every(([key, value]) => r[key as 'name' | 'code'] === value),
            ),
          ) ?? (where.$or.some((c) => c.code === 'strapi-editor') ? { id: 2 } : null),
      }),
    },
  };

  return { strapi: strapi as unknown as Strapi, user, role, permission, apiToken, log, state };
};

describe('seeder', () => {
  let ctx: ReturnType<typeof makeStrapi>;
  beforeEach(() => {
    ctx = makeStrapi();
  });

  it('creates the first admin via createFirstAdmin with a normalized email', async () => {
    await createSeeder(ctx.strapi, { NODE_ENV: 'development' }).run(baseConfig());

    expect(ctx.user.createFirstAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'admin@example.com', password: 'Secret123' }),
    );
    expect(ctx.log.info).toHaveBeenCalledWith(expect.stringContaining('Created admin'));
  });

  it('makes sure the default roles exist before creating the first admin', async () => {
    await createSeeder(ctx.strapi, { NODE_ENV: 'development' }).run(baseConfig());

    expect(ctx.role.createRolesIfNoneExist.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.user.createFirstAdmin.mock.invocationCallOrder[0]!,
    );
  });

  it('never logs the password', async () => {
    await createSeeder(ctx.strapi, { NODE_ENV: 'development' }).run(baseConfig());

    const logged = JSON.stringify(ctx.log.info.mock.calls);
    expect(logged).not.toContain('Secret123');
    expect(logged).toContain('[hidden]');
  });

  it('falls back to user.create + the super admin role without createFirstAdmin', async () => {
    ctx = makeStrapi({ firstAdmin: false });
    await createSeeder(ctx.strapi, { NODE_ENV: 'development' }).run(baseConfig());

    expect(ctx.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ roles: [1], isActive: true, registrationToken: null }),
    );
  });

  it('does nothing when an admin already exists (idempotent)', async () => {
    ctx = makeStrapi({ users: 1 });
    await createSeeder(ctx.strapi, { NODE_ENV: 'development' }).run(baseConfig());

    expect(ctx.user.createFirstAdmin).not.toHaveBeenCalled();
    expect(ctx.user.create).not.toHaveBeenCalled();
  });

  it('warns about default credentials outside development', async () => {
    const config = baseConfig();
    config.admin.password = 'admin';
    await createSeeder(ctx.strapi, { NODE_ENV: 'production' }).run(config);

    expect(ctx.log.warn).toHaveBeenCalledWith(expect.stringContaining('default admin credentials'));
    expect(ctx.log.warn).toHaveBeenCalledWith(expect.stringContaining('password policy'));
  });

  it('creates roles first, then extra admins with resolved role ids', async () => {
    await createSeeder(ctx.strapi, { NODE_ENV: 'development' }).run(
      baseConfig({
        roles: [{ name: 'QA', code: 'qa' }],
        admins: [{ email: 'Editor@Example.com', firstname: 'Ed', roles: ['strapi-editor', 'qa'] }],
      }),
    );

    expect(ctx.role.create).toHaveBeenCalledWith({ name: 'QA', code: 'qa' });
    expect(ctx.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'editor@example.com', roles: [2, 10] }),
    );
  });
});

const run = async (mode: PluginConfig['mode'], env: Record<string, string>) => {
  const ctx = makeStrapi();
  (ctx.strapi.config.get as ReturnType<typeof vi.fn>).mockReturnValue(baseConfig({ mode }));
  vi.stubEnv('NODE_ENV', env.NODE_ENV ?? 'production');
  await bootstrap({ strapi: ctx.strapi });
  vi.unstubAllEnvs();
  return ctx;
};

describe('seeder extra admins', () => {
  it('skips an admin when none of its roles exist', async () => {
    const ctx = makeStrapi({ users: 1 });
    await createSeeder(ctx.strapi, { NODE_ENV: 'development' }).run(
      baseConfig({ admins: [{ email: 'a@b.c', firstname: 'A', roles: ['nope'] }] }),
    );

    expect(ctx.user.create).not.toHaveBeenCalled();
    expect(ctx.log.error).toHaveBeenCalledWith(expect.stringContaining('none of its roles exist'));
  });
});

/** Seeds `config` on top of the base config, with an admin already in place. */
const seed = (ctx: ReturnType<typeof makeStrapi>, config: Partial<PluginConfig>) =>
  createSeeder(ctx.strapi, { NODE_ENV: 'development' }).run(baseConfig(config));

describe('seeder role permissions', () => {
  it('copies permissions from another role and adds the listed ones', async () => {
    const ctx = makeStrapi({ users: 1 });
    await seed(ctx, {
      roles: [
        {
          name: 'QA',
          code: 'qa',
          copyPermissionsFrom: 'strapi-editor',
          permissions: ['plugin::upload.read', { action: 'plugin::upload.assets.create' }],
        },
      ],
    });

    expect(ctx.role.create).toHaveBeenCalledWith({ name: 'QA', code: 'qa' });
    expect(ctx.role.assignPermissions).toHaveBeenCalledWith(10, [
      {
        action: 'plugin::content-manager.explorer.read',
        actionParameters: {},
        subject: 'api::article.article',
        properties: { fields: ['title'] },
        conditions: [],
      },
      { action: 'plugin::upload.read', subject: null, properties: {}, conditions: [] },
      { action: 'plugin::upload.assets.create', subject: null, properties: {}, conditions: [] },
    ]);
    expect(ctx.log.info).toHaveBeenCalledWith('Created role "QA" with 3 permissions.');
  });

  it('never touches the permissions of an existing role', async () => {
    const ctx = makeStrapi({ users: 1 });
    ctx.state.roles.push({ id: 5, name: 'QA', code: 'qa' });
    await seed(ctx, { roles: [{ name: 'QA', code: 'qa', permissions: ['plugin::upload.read'] }] });

    expect(ctx.role.create).not.toHaveBeenCalled();
    expect(ctx.role.assignPermissions).not.toHaveBeenCalled();
  });

  it('warns and still creates the role when the source role is missing', async () => {
    const ctx = makeStrapi({ users: 1 });
    await seed(ctx, { roles: [{ name: 'QA', copyPermissionsFrom: 'nope' }] });

    expect(ctx.role.create).toHaveBeenCalled();
    expect(ctx.role.assignPermissions).not.toHaveBeenCalled();
    expect(ctx.log.warn).toHaveBeenCalledWith(expect.stringContaining('Role "nope" not found'));
  });

  it('logs an error when the permissions are rejected', async () => {
    const ctx = makeStrapi({ users: 1 });
    ctx.role.assignPermissions.mockRejectedValueOnce(new Error('Unknown action'));
    await seed(ctx, { roles: [{ name: 'QA', permissions: ['nope'] }] });

    expect(ctx.log.error).toHaveBeenCalledWith(
      expect.stringContaining("couldn't assign its permissions: Unknown action"),
    );
  });
});

describe('seeder API tokens', () => {
  it('creates content API tokens when Strapi knows token kinds', async () => {
    const ctx = makeStrapi({ users: 1 });
    await seed(ctx, { apiTokens: [{ name: 'ci', type: 'read-only' }] });

    expect(ctx.apiToken.create).toHaveBeenCalledWith({
      name: 'ci',
      description: '',
      type: 'read-only',
      lifespan: null,
      kind: 'content-api',
    });
  });

  it('leaves out the kind on Strapi versions without it', async () => {
    const ctx = makeStrapi({ users: 1, tokenKind: false });
    await seed(ctx, { apiTokens: [{ name: 'ci', type: 'full-access' }] });

    expect(ctx.apiToken.create.mock.calls[0]![0]).not.toHaveProperty('kind');
  });

  it('passes the permissions of custom tokens', async () => {
    const ctx = makeStrapi({ users: 1 });
    await seed(ctx, {
      apiTokens: [{ name: 'ci', type: 'custom', permissions: ['api::article.article.find'] }],
    });

    expect(ctx.apiToken.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'custom', permissions: ['api::article.article.find'] }),
    );
    expect(ctx.log.info).toHaveBeenCalledWith('Created API token "ci": generated');
  });

  it('skips tokens that already exist', async () => {
    const ctx = makeStrapi({ users: 1 });
    ctx.apiToken.exists.mockResolvedValueOnce(true);
    await seed(ctx, { apiTokens: [{ name: 'ci', type: 'read-only' }] });

    expect(ctx.apiToken.create).not.toHaveBeenCalled();
  });
});

describe('bootstrap', () => {
  it('seeds in development when mode is auto', async () => {
    expect(
      (await run('auto', { NODE_ENV: 'development' })).user.createFirstAdmin,
    ).toHaveBeenCalled();
  });

  it('skips outside development when mode is auto', async () => {
    expect((await run('auto', {})).user.createFirstAdmin).not.toHaveBeenCalled();
  });

  it('seeds in production when mode is always', async () => {
    expect((await run('always', {})).user.createFirstAdmin).toHaveBeenCalled();
  });

  it('never seeds when mode is never', async () => {
    expect(
      (await run('never', { NODE_ENV: 'development' })).user.createFirstAdmin,
    ).not.toHaveBeenCalled();
  });
});
