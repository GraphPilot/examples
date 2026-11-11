<p align="center">
  <a href="https://graphpilot.io/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo_plane_name_dark.png">
      <img src=".github/assets/logo_plane_name_light.png" alt="GraphPilot" width="280">
    </picture>
  </a>
</p>

<h1 align="center">GraphPilot Examples</h1>

<p align="center">
  Runnable GraphQL caching examples and integration guides for
  <a href="https://graphpilot.io/">GraphPilot</a>, the managed GraphQL edge cache.
</p>

<p align="center">
  <a href="https://graphpilot.io/">Website</a> ·
  <a href="https://docs.graphpilot.io/">Documentation</a> ·
  <a href="https://docs.graphpilot.io/getting-started/quickstart/">Quickstart</a>
</p>

## About

GraphPilot sits in front of your GraphQL API and caches responses at the edge, close to your
clients. It takes cache lifetimes from your schema or your origin's `Cache-Control` header, and
when a mutation returns an object, it purges every cached response that contained that object.

The examples in this repository show that in practice. Each one comes with a GraphQL origin you
can run on its own, without a GraphPilot account, and the steps to put GraphPilot in front of it.

## Examples

### [GraphQL POST caching](graphql-post-caching/)

A Book GraphQL API (GraphQL Yoga), called directly and through the GraphPilot edge cache, with
the same queries and the same mutation on both endpoints.

- Compare cache `MISS`, `HIT` and mutation-driven invalidation between the direct origin and
  GraphPilot
- Ready-made requests for the terminal, JetBrains IDEs and VS Code
- Ways to give the origin a public URL: a free tunnel (ngrok or Cloudflare), Render, or your own
  server
- A separate, hand-written in-memory cache for learning how GraphQL `POST` caching works

Accompanies the article "How to Cache GraphQL POST Requests: A Practical Guide".

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/GraphPilot/examples/tree/main/graphql-post-caching)
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/GraphPilot/examples)

## Getting started

Every example lives in its own folder, with its own `package.json` and README:

```bash
git clone https://github.com/GraphPilot/examples.git
cd examples/graphql-post-caching
npm install
npm run origin
```

The example's README takes it from there: running the requests, putting GraphPilot in front of the
origin, and comparing both endpoints.

Requirements depend on the example; the GraphQL POST caching example needs Node.js 22.15 or newer.

## Repository layout

| Path | What it is |
| --- | --- |
| [`graphql-post-caching/`](graphql-post-caching/) | The GraphQL POST caching example |
| [`render.yaml`](render.yaml) | Render Blueprint behind the "Deploy to Render" button. It lives at the repository root because the button reads it there, and deploys only the Book origin of `graphql-post-caching/` |
| [`.github/assets/`](.github/assets/) | Logos used in the READMEs |

## Learn more

- [How GraphPilot works](https://docs.graphpilot.io/getting-started/how-it-works/)
- [GraphQL quickstart](https://docs.graphpilot.io/getting-started/quickstart/): from a new account to a cached response
- [When a response is cached](https://docs.graphpilot.io/caching/caching-decision/)
- [Automatic invalidation](https://docs.graphpilot.io/invalidation/automatic/)

## License

[MIT](LICENSE)
