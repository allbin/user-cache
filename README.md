# @allbin/user-cache

Example:

```ts
import UserCache from "@allbin/user-cache";

const cache = UserCache({
  auth0: {
    domain: "...",
    client_id: "...",
    client_secret: "...",
  },
  redis: {
    url: "redis://localhost",
  },
  ttl: 60 * 15,
});

const users = await cache.getUsers(["auth0|xxx...", "auth0|yyy..."]);

await cache.disconnect();
```
