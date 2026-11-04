# ToyBox

A box of little physics toys. Drop in balls with different weight and bounce,
stack crates, shatter glass, ride conveyor belts, and knock out a tune on the
musical blocks. Drag anything, throw it, watch what happens.

It runs entirely in the browser — no server, no accounts, nothing stored, no
image or sound files (the audio is synthesised).

![ToyBox](./preview.png)

Live at **https://elnuevos.es/toybox**.

## Develop

```bash
npm install
npm run dev        # http://localhost:5175
```

## Check & build

```bash
npm run typecheck
npm run test       # vitest: physics, toy catalog, note maths
npm run build      # outputs ./dist
```

## Add a toy

Edit [`src/toys/catalog.ts`](./src/toys/catalog.ts) — a toy is a palette entry
plus a factory that builds its Matter.js body, with metadata for colour, belt
speed, break threshold or pitch. Add the name to both dictionaries in
[`src/i18n.ts`](./src/i18n.ts) and list it in a `PALETTE_GROUPS` group.

## Deploy

This is a **static** app: Caddy serves the built files under `/toybox`, exactly
like the root dashboard and `/jigsawpuzzle`. No Node process, no port, no pm2.

On the server, one time:

```bash
sudo mkdir -p /var/www/toybox
sudo chown -R "$USER":"$USER" /var/www/toybox
```

Then, from the repo root (never with `sudo` — the webhook runs it as the deploy
user):

```bash
bash deploy/setup.sh          # builds with BASE_PATH=/toybox, publishes to /var/www/toybox
```

Finally add the `handle_path /toybox*` block from
[`deploy/Caddyfile`](./deploy/Caddyfile) to the domain config in the ElNuevos
repo and `sudo systemctl reload caddy`. Auto-deploy: add the repo to
`ElNuevos/deploy/webhook/deploy.config.json` and point a GitHub webhook at
`https://elnuevos.es/_hooks/deploy`.

## How it fits the platform

`elnuevos.es` hosts independent apps, one per URL path. This one owns `/toybox`;
the prefix is baked into the build via `BASE_PATH` so its assets can't collide
with its neighbours. Design notes live in [`PLAN.md`](./PLAN.md).
