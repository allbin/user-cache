import UserCache from './';

void (async function () {
  const cache = UserCache({
    auth0: {
      domain: 'allbin.eu.auth0.com',
      client_id: 'aIHQ1Od4oWyxrSjVvhHFLQY8mxPfS1Eq',
      client_secret: process.env.CLIENT_SECRET || '',
    },
    redis: {
      url: 'redis://localhost',
    },
  });

  try {
    // const output = await cache.getUsers([
    //   'auth0|640876b24806af937db481d2',
    //   'auth0|642435c7d74e82cbf0a4b48e',
    //   'auth0|642435c7d74e82cbf0a4b48f',
    // ]);
    // console.log(output);

    console.time('searchUsers');
    const users = await cache.searchUsers('chris');
    console.timeEnd('searchUsers');
    console.log(users);
  } catch (e) {
    console.error(e);
    process.exit(1);
  } finally {
    await cache.disconnect();
  }
})();
