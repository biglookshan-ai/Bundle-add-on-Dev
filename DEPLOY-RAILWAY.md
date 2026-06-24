# Deploying the admin app to Railway

Railway hosts only the **Remix admin app**. The discount **Function** and the
storefront **theme app extension** live on Shopify and are shipped with
`shopify app deploy` (unchanged by Railway).

## 1. Push this repo to GitHub

```bash
git remote add origin git@github.com:<you>/bundle-addon-app.git
git push -u origin main
```

## 2. Railway

1. New Project → **Deploy from GitHub repo** → pick this repo.
2. Add a **PostgreSQL** plugin (New → Database → PostgreSQL).
3. On the app service → **Variables**, set:
   - `SHOPIFY_API_KEY` = `6297a7921f5449d50493a70d445e8316`
   - `SHOPIFY_API_SECRET` = (Partners dashboard → app → API credentials)
   - `SCOPES` = `read_products,write_discounts,write_products`
   - `DATABASE_URL` = reference the Postgres plugin's `DATABASE_URL`
   - `SHOPIFY_APP_URL` = the service's public domain (set after the first deploy,
     e.g. `https://<service>.up.railway.app`, then redeploy)
4. Railway builds the Dockerfile; `docker-start` runs `prisma migrate deploy`
   automatically.

## 3. Point the Shopify app at Railway

In `shopify.app.bundle-app-dev.toml` set:

```toml
application_url = "https://<service>.up.railway.app"

[auth]
redirect_urls = [
  "https://<service>.up.railway.app/auth/callback",
  "https://<service>.up.railway.app/auth/shopify/callback",
  "https://<service>.up.railway.app/api/auth/callback"
]
```

Set `automatically_update_urls_on_dev = false` so `shopify app dev` doesn't
overwrite these, then run `shopify app deploy` once to push the URLs.

Reinstall/open the app from the store admin — it now loads from Railway, no
`shopify app dev` needed.
