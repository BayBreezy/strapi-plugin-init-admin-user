import { DEFAULT_ADMIN, readEnv, type Env } from '../lib/env';
import { passwordPolicyViolations } from '../lib/password';
import { redact } from '../lib/redact';
import type {
  AdminPermission,
  AdminRole,
  AdminServices,
  ApiTokenInput,
  ExtraAdmin,
  PluginConfig,
  RoleInput,
  Strapi,
} from '../lib/types';

const SUPER_ADMIN_CODE = 'strapi-super-admin';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Keeps only the fields Strapi compares and stores (drops ids, the role relation, timestamps). */
const toAdminPermission = ({
  action,
  actionParameters,
  subject,
  properties,
  conditions,
}: AdminPermission): AdminPermission => ({
  action,
  ...(actionParameters !== undefined && { actionParameters }),
  subject: subject ?? null,
  properties: properties ?? {},
  conditions: conditions ?? [],
});

export const createSeeder = (strapi: Strapi, env: Env = process.env) => {
  const admin = (): AdminServices =>
    (strapi as unknown as { admin: { services: AdminServices } }).admin.services;
  const query = (uid: string) => (strapi.db as any).query(uid);

  const getSuperAdminRole = async (): Promise<AdminRole> => {
    try {
      await admin().role.createRolesIfNoneExist();
    } catch (error) {
      strapi.log.error(`Couldn't check for & create existing roles. ${errorMessage(error)}`);
    }

    const existing = await admin().role.getSuperAdmin();
    if (existing) return existing;

    return admin().role.create({
      name: 'Super Admin',
      code: SUPER_ADMIN_CODE,
      description: 'Super Admins can access and manage all features and settings.',
    });
  };

  const findRole = (codeOrName: string) =>
    query('admin::role').findOne({
      where: { $or: [{ code: codeOrName }, { name: codeOrName }] },
    }) as Promise<AdminRole | null>;

  /** Resolves role codes or names to ids. Unknown roles are reported and skipped. */
  const resolveRoleIds = async (roles: string[]): Promise<(number | string)[]> => {
    const ids: (number | string)[] = [];
    for (const role of roles) {
      const found = await findRole(role);
      if (found) ids.push(found.id);
      else strapi.log.warn(`Role "${role}" not found, skipping it.`);
    }
    return ids;
  };

  const warnAboutCredentials = (email: string, password: string) => {
    if (
      env.NODE_ENV !== 'development' &&
      (password === DEFAULT_ADMIN.password || email === DEFAULT_ADMIN.email)
    ) {
      strapi.log.warn(
        'The default admin credentials are in use outside development. Set INIT_ADMIN_EMAIL and INIT_ADMIN_PASSWORD.',
      );
    }

    const violations = passwordPolicyViolations(password);
    if (violations.length > 0) {
      strapi.log.warn(
        `The password for ${email} doesn't meet Strapi's password policy (needs ${violations.join(', ')}).`,
      );
    }
  };

  /** The permissions of `role` (from `copyPermissionsFrom` and `permissions`), ready to assign. */
  const collectPermissions = async (role: RoleInput): Promise<AdminPermission[]> => {
    const collected: AdminPermission[] = [];

    if (role.copyPermissionsFrom) {
      const source = await findRole(role.copyPermissionsFrom);
      if (!source) {
        strapi.log.warn(
          `Role "${role.copyPermissionsFrom}" not found, so no permissions were copied to "${role.name}".`,
        );
      } else {
        const permissions = (await strapi
          .service('admin::permission')
          .findMany({ where: { role: { id: source.id } } })) as AdminPermission[];
        collected.push(...permissions.map(toAdminPermission));
      }
    }

    for (const permission of role.permissions ?? []) {
      collected.push(
        toAdminPermission(typeof permission === 'string' ? { action: permission } : permission),
      );
    }
    return collected;
  };

  const seedRoles = async (roles: RoleInput[]) => {
    for (const role of roles) {
      const exists = await query('admin::role').findOne({
        where: { $or: [{ name: role.name }, ...(role.code ? [{ code: role.code }] : [])] },
      });
      if (exists) continue;

      const { copyPermissionsFrom: _copy, permissions: _permissions, ...attributes } = role;
      let created: AdminRole;
      try {
        created = await admin().role.create(attributes);
      } catch (error) {
        strapi.log.error(`Couldn't create role "${role.name}": ${errorMessage(error)}`);
        continue;
      }

      // Permissions are only assigned to roles created here, so changes made in the admin
      // panel are never overwritten.
      try {
        const permissions = await collectPermissions(role);
        if (permissions.length > 0) {
          await admin().role.assignPermissions(created.id, permissions);
          strapi.log.info(`Created role "${role.name}" with ${permissions.length} permissions.`);
        } else {
          strapi.log.info(`Created role "${role.name}".`);
        }
      } catch (error) {
        strapi.log.error(
          `Created role "${role.name}", but couldn't assign its permissions: ${errorMessage(error)}`,
        );
      }
    }
  };

  const seedFirstAdmin = async (config: PluginConfig) => {
    const users = (await query('admin::user').count()) as number;
    if (users > 0) return;

    const { password, ...rest } = config.admin;
    const attributes = {
      ...rest,
      email: config.admin.email.trim().toLowerCase(),
      password,
      blocked: false,
    };
    warnAboutCredentials(attributes.email, password);

    try {
      if (admin().user.createFirstAdmin) {
        await admin().user.createFirstAdmin!(attributes);
      } else {
        const superAdminRole = await getSuperAdminRole();
        await admin().user.create({
          ...attributes,
          isActive: true,
          registrationToken: null,
          roles: [superAdminRole.id],
        });
      }

      const shown =
        password === DEFAULT_ADMIN.password
          ? password
          : readEnv(env, 'INIT_ADMIN_PASSWORD')
            ? '[INIT_ADMIN_PASSWORD]'
            : '[hidden]';
      strapi.log.info(`Created admin (E-Mail: ${attributes.email}, Password: ${shown}).`);
    } catch (error) {
      strapi.log.error(`Couldn't create admin (${attributes.email}): ${errorMessage(error)}`);
    }
  };

  const seedExtraAdmin = async (extra: ExtraAdmin) => {
    const email = extra.email.trim().toLowerCase();
    const exists = (await query('admin::user').count({ where: { email } })) > 0;
    if (exists) return;

    const { roles = [], ...rest } = extra;
    if (extra.password) warnAboutCredentials(email, extra.password);

    try {
      const roleIds = await resolveRoleIds(roles);
      if (roleIds.length === 0) {
        strapi.log.error(`Couldn't create admin (${email}): none of its roles exist.`);
        return;
      }
      await admin().user.create({
        ...rest,
        email,
        isActive: true,
        registrationToken: null,
        roles: roleIds,
      });
      strapi.log.info(`Created admin (E-Mail: ${email}, Roles: ${roles.join(', ') || 'none'}).`);
    } catch (error) {
      strapi.log.error(
        `Couldn't create admin (${email}): ${errorMessage(error)} ${JSON.stringify(redact(extra))}`,
      );
    }
  };

  const seedApiToken = async (token: ApiTokenInput) => {
    const tokens = strapi.service('admin::api-token') as any;
    if (await tokens.exists({ name: token.name })) return;

    // Newer Strapi versions also have admin tokens and treat a token without a `kind` as one.
    const hasKind = Boolean(
      (strapi.contentType('admin::api-token') as { attributes?: Record<string, unknown> })
        ?.attributes?.kind,
    );

    try {
      const created = await tokens.create({
        name: token.name,
        description: token.description ?? '',
        type: token.type,
        lifespan: token.lifespan ?? null,
        ...(hasKind && { kind: 'content-api' }),
      });

      if (token.accessKey) {
        // Strapi stores HMAC(salt, key), and on newer versions also an encrypted copy of the key.
        const encryption = strapi.service('admin::encryption') as
          { encrypt(value: string): string } | undefined;
        await query('admin::api-token').update({
          where: { id: created.id },
          data: {
            accessKey: tokens.hash(token.accessKey),
            ...(encryption && { encryptedKey: encryption.encrypt(token.accessKey) }),
          },
        });
        strapi.log.info(`Created API token "${token.name}" with the configured access key.`);
      } else {
        strapi.log.info(`Created API token "${token.name}": ${created.accessKey}`);
      }
    } catch (error) {
      strapi.log.error(`Couldn't create API token "${token.name}": ${errorMessage(error)}`);
    }
  };

  return {
    async run(config: PluginConfig) {
      // Strapi creates its default roles in its own bootstrap, which may run after ours.
      await getSuperAdminRole();
      await seedRoles(config.roles);
      await seedFirstAdmin(config);
      for (const extra of config.admins) await seedExtraAdmin(extra);
      for (const token of config.apiTokens) await seedApiToken(token);
    },
  };
};
