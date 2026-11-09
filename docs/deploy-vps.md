# Deploy Agently to a Hostinger VPS (test setup)

This puts the API, worker, database and HTTPS on one VPS so Messenger can reach the bot. The dashboard and admin screens are still placeholders. Instead, a command connects your shop and Facebook page, and you test by messaging your page.

You need:
- A Hostinger VPS (KVM 2 or bigger, Ubuntu 24.04)
- A domain you can add DNS records to
- Your Meta developer app
- An OpenAI API key

Plan for about 30 minutes.

**Already running another site on this VPS (like MinuteFlow)?** Do steps 1 to 3, then follow [Sharing the server with another site](#sharing-the-server-with-another-site) instead of step 4. Nothing about the other site changes.

## 1. Point three subdomains at the VPS

In your domain's DNS (in hPanel → Domains → DNS, or wherever the domain is registered), add three **A records**. Each one points to the VPS's IP address, which is shown in hPanel → VPS → Overview.

| Name | Type | Value |
| --- | --- | --- |
| `api` | A | your VPS IP |
| `app` | A | your VPS IP |
| `admin` | A | your VPS IP |

This guide uses `api.example.com`, `app.example.com` and `admin.example.com`; replace `example.com` with your domain everywhere. DNS can take a few minutes to update.

## 2. Install Docker on the VPS

In hPanel you can reinstall the VPS with the **Ubuntu 24.04 with Docker** template, or install Docker yourself. To install it yourself, sign in over SSH:

```sh
ssh root@YOUR_VPS_IP
curl -fsSL https://get.docker.com | sh
```

Open the web ports if the firewall is on:

```sh
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```

## 3. Get the code and fill in `.env`

```sh
git clone https://github.com/sharifsumon/aichatbot.git agently
cd agently
cp .env.example .env
nano .env
```

The repository is private, so `git clone` asks you to sign in. Use your GitHub username, and a personal access token as the password (GitHub → Settings → Developer settings → Personal access tokens).

Set these values in `.env` and leave the rest as they are:

```sh
POSTGRES_PASSWORD=            # a long random password: openssl rand -hex 24
ENCRYPTION_KEY=               # openssl rand -base64 32   (keep it; losing it loses page connections)

WEB_URL=https://app.example.com
ADMIN_URL=https://admin.example.com
API_URL=https://api.example.com
COOKIE_DOMAIN=.example.com

META_APP_ID=                  # Meta app → App settings → Basic
META_APP_SECRET=
META_VERIFY_TOKEN=            # any random string: openssl rand -hex 16

AI_BASE_URL=https://api.openai.com/v1
AI_API_KEY=                   # your OpenAI key
AI_CHAT_MODEL=gpt-4o-mini
AI_EMBEDDING_MODEL=text-embedding-3-small
AI_EMBEDDING_DIMENSIONS=1024
AI_INPUT_COST_PER_MTOK=0.15
AI_OUTPUT_COST_PER_MTOK=0.6

WEB_DOMAIN=app.example.com
API_DOMAIN=api.example.com
ADMIN_DOMAIN=admin.example.com
```

Delete the `DATABASE_URL` and `REDIS_URL` lines, or leave them alone; Docker sets its own values for these. Leave the `S3_*` lines empty for now. Without them only file uploads are off.

## 4. Start everything

```sh
docker compose up -d --build
```

The first build takes a few minutes. It runs the database migrations, then starts the API, worker, web, admin and Caddy, which gets HTTPS certificates by itself. Check that the API is up:

```sh
curl https://api.example.com/health
docker compose logs -f api worker    # Ctrl+C to stop following
```

## 5. Point the Meta app at the server

At developers.facebook.com, open your app:

1. **Messenger → Messenger API Settings → Webhooks:** set the callback URL to `https://api.example.com/webhooks/meta` and the verify token to your `META_VERIFY_TOKEN`. Click **Verify and save**, then subscribe to `messages`, `messaging_postbacks` and `feed`.
2. **App settings → Basic:**
   - Set the data deletion callback URL to `https://api.example.com/webhooks/meta/data-deletion`.
   - Set the deauthorize callback URL to `https://api.example.com/webhooks/meta/deauthorize`.
   - Add `example.com` to the App domains.
3. **Facebook Login → Settings:** add `https://api.example.com/auth/facebook/callback` as a valid OAuth redirect URI.

The app stays in development mode. Only people with a role on it get replies from the bot, so add the accounts you will test with under **App roles → Roles** (as testers or admins).

## 6. Connect your shop and page

1. Open the Graph API Explorer at developers.facebook.com/tools/explorer.
2. Pick your app, and add these permissions:
   - `pages_show_list`
   - `pages_manage_metadata`
   - `pages_messaging`
   - `pages_read_engagement`
   - `pages_manage_engagement`
   - `pages_read_user_content`
3. Click **Generate Access Token**, allow it for your page, and copy the token.

On the VPS, list your pages:

```sh
docker compose run --rm -e FB_USER_TOKEN=PASTE_TOKEN migrate pnpm shop:connect
```

Then connect one. `SAMPLE=1` adds a demo T-shirt (code TS-01, black and white, M and L) and a short text about delivery and returns, so the bot has something to answer from:

```sh
docker compose run --rm -e FB_USER_TOKEN=PASTE_TOKEN -e PAGE_ID=YOUR_PAGE_ID -e SHOP_NAME="My Shop" -e SAMPLE=1 migrate pnpm shop:connect
```

The command swaps the token for a long-lived one, subscribes the page to the webhook, and switches the bot live. Running it again later refreshes the page token.

## 7. Try it

From an account with a role on the app, message your page on Messenger. Try these:
- "T-shirt er dam koto?"
- "Black L ache?"
- "Delivery charge koto Dhakar baire?"
- "Ami 1ta black M nibo." The bot confirms the order and asks for your address and payment method.

A comment on one of the page's posts gets a reply too.

Watch what happens:

```sh
docker compose logs -f worker
```

## 8. Make your super admin account (optional for now)

```sh
docker compose run --rm -e ADMIN_EMAIL=you@example.com -e ADMIN_NAME="Your Name" migrate pnpm admin:create
```

It prints a one-time password. The admin screens aren't built yet; the account is ready for when they are.

## Sharing the server with another site

When another site already uses ports 80 and 443, Agently leaves them alone. Its own Caddy stays off, and the web server you already have (Nginx, Caddy, Traefik) forwards Agently's three subdomains to it.

**1. Find free local ports.** This lists the ports in use:

```sh
sudo ss -tlnp | grep -E ':(80|443|3000|3001|4000|5432|6379)\s'
```

**2. In Agently's `.env`,** turn Caddy off and pick ports nothing else uses. The 1xxxx ports below are unlikely to clash:

```sh
COMPOSE_PROFILES=app
API_HOST_PORT=14000
WEB_HOST_PORT=13000
ADMIN_HOST_PORT=13001
POSTGRES_HOST_PORT=15432
REDIS_HOST_PORT=16379
```

These ports listen on `127.0.0.1` only, so they can't be reached from outside the server. Agently has its own Postgres and Redis in Docker, separate from the other site's data.

On a small server, don't build there: a build takes more than 2 GB of memory and can push the other site out. GitHub builds the images on every merge to main (the **Images** workflow), and the server only downloads them. The images are private, so sign in once with a GitHub token that has the `read:packages` scope (GitHub → Settings → Developer settings → Personal access tokens):

```sh
echo YOUR_TOKEN | docker login ghcr.io -u sharifsumon --password-stdin
docker compose pull
docker compose up -d
curl http://127.0.0.1:14000/health      # should answer ok
```

If the server ever runs short of memory, the kernel stops Agently's processes first (they have a higher `oom_score_adj`), so the other site keeps running.

**3. Add the subdomains to your existing web server.**

If it is **Nginx**, create `/etc/nginx/sites-available/agently`:

```nginx
server {
    server_name api.example.com;
    client_max_body_size 25m;   # knowledge base file uploads
    location / {
        proxy_pass http://127.0.0.1:14000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
server {
    server_name app.example.com;
    location / { proxy_pass http://127.0.0.1:13000; proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto $scheme; }
}
server {
    server_name admin.example.com;
    location / { proxy_pass http://127.0.0.1:13001; proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto $scheme; }
}
```

Then turn it on, check the config, and get HTTPS certificates. `nginx -t` checks the config before reloading, so a mistake can't take the other site down:

```sh
sudo ln -s /etc/nginx/sites-available/agently /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.example.com -d app.example.com -d admin.example.com
```

If it is **Caddy**, add this to its Caddyfile and run `sudo systemctl reload caddy`. Caddy gets the certificates by itself:

```
api.example.com {
	reverse_proxy 127.0.0.1:14000
}
app.example.com {
	reverse_proxy 127.0.0.1:13000
}
admin.example.com {
	reverse_proxy 127.0.0.1:13001
}
```

Then carry on from step 5.

**Memory.** Nothing is reserved. Each part of Agently uses memory only while it's working, so both sites share what the server has. When Agently is idle it uses roughly 400 to 600 MB. If you only test Agently now and then, stop it in between and it gives back all of its memory:

```sh
docker compose stop      # stop Agently; MinuteFlow keeps running
docker compose start     # start it again (data is kept)
```

## Updating to a new version

```sh
cd agently && git pull && docker compose up -d --build
# On a shared or small server, download GitHub's images instead of building:
cd agently && git pull && docker compose pull && docker compose up -d
```

## If something goes wrong

- **Meta says the webhook could not be verified:**
  - Check that `curl https://api.example.com/health` works from your own computer.
  - Check that the verify token matches `META_VERIFY_TOKEN` exactly.
- **No reply on Messenger:**
  - Check the sender has a role on the app.
  - Run `docker compose logs worker`. "skipped_agent_not_live" means run step 6 again. "skipped_no_credits" means the trial's credits are used up.
- **The other site stopped working after adding Agently:**
  - Run `sudo nginx -t` to see the config error.
  - Remove `/etc/nginx/sites-enabled/agently` and reload Nginx to get back to how it was.
- **HTTPS certificate errors:**
  - DNS may still be updating. Run `docker compose logs caddy`.
  - Ports 80 and 443 must be open.
