import axios from 'axios';
import jwt from 'jsonwebtoken';
import { GetUsers200ResponseOneOfInner as Auth0User } from 'auth0';

import {
  createClient,
  RedisClientType,
  RedisFunctions,
  RedisScripts,
} from '@redis/client';
import redis_json_module from '@redis/json';
import { DateTime } from 'luxon';

export interface UserCacheOptionsWithOptionals {
  auth0: {
    domain: string;
    client_id: string;
    client_secret: string;
  };
  redis: {
    url: string;
  };
  /** seconds */
  ttl?: number;

  /** if specified, will generate mock users for user_ids not found in auth0 */
  create_mock_user_fn?: (user_id: string) => Promise<Auth0User>;
}

export const allbinaryCreateMockUserFn = async (
  id: string,
): Promise<Auth0User> => {
  return new Promise((resolve) => {
    setImmediate(() => {
      const username = `redacted-${crypto.randomUUID()}@example.com`;
      const [provider, identity_id] = id.split('|');
      resolve({
        user_id: id,
        name: `<Deleted user>`,
        username,
        nickname: username,
        given_name: `Deleted`,
        family_name: `User`,
        email: `redacted@example.com`,
        email_verified: false,
        phone_number: '+1555123456',
        phone_verified: false,
        created_at: DateTime.now().toISO(),
        updated_at: DateTime.now().toISO(),
        app_metadata: {
          organization: 'allbinary',
        },
        user_metadata: {},
        picture: '',
        identities: [
          {
            connection: 'Username-Password-Authentication',
            provider: provider,
            user_id: identity_id,
            isSocial: false,
          },
        ],
        multifactor: [],
        last_ip: '127.0.0.1',
        last_login: DateTime.now().toISO(),
        logins_count: 0,
        blocked: true,
      } as unknown as Auth0User);
    });
  });
};

interface UserCacheOptions extends UserCacheOptionsWithOptionals {
  /** seconds */
  ttl: number;
}

export interface IUserCache {
  setUsers: (users: Auth0User[]) => Promise<void>;
  getUsers: (ids: string[]) => Promise<Auth0User[]>;
  searchUsers: (q: string) => Promise<Auth0User[]>;
  disconnect: () => Promise<void>;
}

interface IUserCacheContext {
  options: UserCacheOptions;
  isConnected: boolean;
  redis: RedisClientType<
    { json: typeof redis_json_module },
    RedisFunctions,
    RedisScripts
  >;
  access_token?: string;
}

const isTokenValid = (token: string): boolean => {
  const decoded = jwt.decode(token) as { exp: number };
  return decoded.exp - 60 > Date.now() / 1000;
};

const getToken = async (ctx: IUserCacheContext): Promise<string> => {
  if (!ctx.access_token || !isTokenValid(ctx.access_token)) {
    const { domain, client_id, client_secret } = ctx.options.auth0;
    ctx.access_token = await axios
      .post<{ access_token: string }>(`https://${domain}/oauth/token`, {
        grant_type: 'client_credentials',
        client_id,
        client_secret,
        audience: `https://${domain}/api/v2/`,
      })
      .then((r) => r.data.access_token);
  }
  return ctx.access_token as string;
};

const chunk = <T>(arr: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
    arr.slice(i * size, i * size + size),
  );

const getAuth0Users = async (
  ctx: IUserCacheContext,
  ids: string[],
): Promise<Auth0User[]> => {
  const batches = chunk(ids, 10);

  const users: Auth0User[] = [];
  for (const batch of batches) {
    const { domain } = ctx.options.auth0;
    const batch_users = await axios
      .get<Auth0User[]>(`https://${domain}/api/v2/users`, {
        headers: {
          authorization: `Bearer ${await getToken(ctx)}`,
        },
        params: {
          q: `user_id:("${batch.join('" OR "')}")`,
        },
      })
      .then((r) => r.data);

    users.push(...batch_users);
  }
  return users;
};

const userExists = (user: Auth0User | null): user is Auth0User =>
  !!user?.user_id;

const ensureConnected = async (ctx: IUserCacheContext): Promise<void> => {
  if (!ctx.isConnected) {
    await ctx.redis.connect();
    ctx.isConnected = true;
  }
};

const setUsers = async (
  ctx: IUserCacheContext,
  users: Auth0User[],
): Promise<void> => {
  await ensureConnected(ctx);

  const multi = ctx.redis.multi();
  users.forEach((user) => {
    multi.json
      .set(`user:${user.user_id}`, '$', user)
      .expire(`user:${user.user_id}`, ctx.options.ttl);
  });
  await multi.exec();
};

interface GetUsersOptions {
  force_fetch?: boolean;
}

const getUsers = async (
  ctx: IUserCacheContext,
  ids: string[],
  opts?: GetUsersOptions,
): Promise<Auth0User[]> => {
  await ensureConnected(ctx);

  const cached_users: Auth0User[] = opts?.force_fetch
    ? []
    : (
        await Promise.all(
          ids.map(
            (id) =>
              ctx.redis.json.get(`user:${id}`) as unknown as Auth0User | null,
          ),
        )
      ).filter(userExists);

  const missing_ids = ids.filter(
    (id) => !cached_users.some((u) => u.user_id === id),
  );

  const fetched_users: Auth0User[] = missing_ids.length
    ? await getAuth0Users(ctx, missing_ids)
    : [];

  if (fetched_users.length) {
    await setUsers(ctx, fetched_users);
  }

  if (!ctx.options.create_mock_user_fn) {
    return [...cached_users, ...fetched_users];
  }

  // return mock versions of missing users into cache, to prevent
  // spamming auth0 for users that never existed or were deleted
  const still_missing_ids = missing_ids.filter(
    (id) => !fetched_users.some((u) => u.user_id === id),
  );

  const mock_users: Auth0User[] = [];
  for (const id of still_missing_ids) {
    mock_users.push(await ctx.options.create_mock_user_fn(id));
  }

  if (mock_users.length) {
    await setUsers(ctx, mock_users);
  }

  return [...cached_users, ...fetched_users, ...mock_users];
};

const searchUsers = async (
  ctx: IUserCacheContext,
  q: string,
): Promise<Auth0User[]> => {
  const { domain } = ctx.options.auth0;
  const users = await axios
    .get<Auth0User[]>(`https://${domain}/api/v2/users`, {
      headers: {
        authorization: `Bearer ${await getToken(ctx)}`,
      },
      params: {
        q: `email:/${q}/`,
      },
    })
    .then((r) => r.data);

  await setUsers(ctx, users);
  return users;
};

export default (opts: UserCacheOptionsWithOptionals): IUserCache => {
  const options: UserCacheOptions = {
    ...opts,
    ttl: opts.ttl || 60 * 15,
  };

  const ctx: IUserCacheContext = {
    options,
    isConnected: false,
    redis: createClient({
      url: options.redis.url || 'redis://localhost',
      modules: { json: redis_json_module },
    }).on('error', (e) => {
      console.error(e);
    }),
  };

  return {
    setUsers: async (users) => await setUsers(ctx, users),
    getUsers: async (ids) => await getUsers(ctx, ids),
    searchUsers: async (q) => await searchUsers(ctx, q),
    disconnect: async () => {
      if (ctx.isConnected) {
        await ctx.redis.disconnect();
      }
    },
  };
};
