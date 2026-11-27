import { adminFromEnv, adminsFromEnv, apiTokensFromEnv, rolesFromEnv } from '../lib/env';
import type { ApiTokenType, Mode, PluginConfig } from '../lib/types';

const MODES: Mode[] = ['auto', 'always', 'never'];
const TOKEN_TYPES: ApiTokenType[] = ['read-only', 'full-access', 'custom'];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const assertArray = (config: Record<string, unknown>, key: string) => {
  if (!Array.isArray(config[key])) throw new Error(`"${key}" must be an array`);
};

const assertEntries = (list: unknown[], key: string, required: string[]) => {
  list.forEach((entry, index) => {
    if (!isObject(entry)) throw new Error(`"${key}[${index}]" must be an object`);
    for (const field of required) {
      if (typeof entry[field] !== 'string' || !entry[field]) {
        throw new Error(`"${key}[${index}].${field}" is required`);
      }
    }
  });
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const assertRolePermissions = (role: Record<string, unknown>, path: string) => {
  if (role.copyPermissionsFrom !== undefined && !isNonEmptyString(role.copyPermissionsFrom)) {
    throw new Error(`"${path}.copyPermissionsFrom" must be a role code or name`);
  }
  if (role.permissions === undefined) return;
  if (!Array.isArray(role.permissions)) throw new Error(`"${path}.permissions" must be an array`);

  role.permissions.forEach((permission: unknown, index) => {
    const action = isObject(permission) ? permission.action : permission;
    if (!isNonEmptyString(action)) {
      throw new Error(
        `"${path}.permissions[${index}]" must be an action string or an object with an "action"`,
      );
    }
  });
};

const assertApiToken = (token: Record<string, unknown>, path: string) => {
  if (!TOKEN_TYPES.includes(token.type as ApiTokenType)) {
    throw new Error(`"${path}.type" must be one of: ${TOKEN_TYPES.join(', ')}`);
  }

  if (token.type === 'custom') {
    const { permissions } = token;
    if (!Array.isArray(permissions) || permissions.length === 0) {
      throw new Error(`"${path}.permissions" needs at least one action for a custom token`);
    }
    if (!permissions.every(isNonEmptyString)) {
      throw new Error(`"${path}.permissions" must only contain action strings`);
    }
  } else if (token.permissions !== undefined) {
    throw new Error(`"${path}.permissions" is only allowed on custom tokens`);
  }
};

export default {
  default: (): PluginConfig => ({
    mode: 'auto',
    admin: adminFromEnv(process.env),
    admins: adminsFromEnv(process.env),
    roles: rolesFromEnv(process.env),
    apiTokens: apiTokensFromEnv(process.env),
  }),
  validator(config: Record<string, unknown>) {
    if (!MODES.includes(config.mode as Mode)) {
      throw new Error(`"mode" must be one of: ${MODES.join(', ')}`);
    }
    if (!isObject(config.admin)) throw new Error('"admin" must be an object');

    for (const key of ['admins', 'roles', 'apiTokens']) assertArray(config, key);

    assertEntries(config.admins as unknown[], 'admins', ['email', 'firstname']);
    for (const [index, extra] of (config.admins as { roles?: unknown }[]).entries()) {
      if (!Array.isArray(extra.roles) || extra.roles.length === 0) {
        throw new Error(`"admins[${index}].roles" needs at least one role code or name`);
      }
    }
    assertEntries(config.roles as unknown[], 'roles', ['name']);
    for (const [index, role] of (config.roles as Record<string, unknown>[]).entries()) {
      assertRolePermissions(role, `roles[${index}]`);
    }

    assertEntries(config.apiTokens as unknown[], 'apiTokens', ['name', 'type']);
    for (const [index, token] of (config.apiTokens as Record<string, unknown>[]).entries()) {
      assertApiToken(token, `apiTokens[${index}]`);
    }
  },
};
