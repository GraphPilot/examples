<p align="center">
  <a href="https://graphpilot.io/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo_plane_name_dark.png">
      <img src=".github/assets/logo_plane_name_light.png" alt="GraphPilot" width="280">
    </picture>
  </a>
</p>

# examples
Practical GraphQL caching examples, runnable demos, and integration guides for GraphPilot.

## Examples

| Example | What it shows |
| --- | --- |
| [`graphql-post-caching`](graphql-post-caching/) | A Book GraphQL API (GraphQL Yoga) called directly and through the GraphPilot edge cache, with a script that compares cache `MISS`, `HIT` and mutation-driven invalidation on both endpoints. Also contains a separate, hand-written in-memory cache for learning how GraphQL `POST` caching works. Accompanies the article "How to Cache GraphQL POST Requests: A Practical Guide". |

Each example is self-contained in its own folder, with its own `package.json` and README. Every
origin runs locally without a GraphPilot account; only the steps that put GraphPilot in front of
it need one.
