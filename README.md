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
| [`graphql-post-caching`](graphql-post-caching/) | Caching GraphQL `POST` (and HTTP `QUERY`) responses with a small in-memory cache in front of a GraphQL Yoga Book API: cache keys, HIT, MISS and BYPASS, TTL, bounded storage, and invalidation after a mutation. Accompanies the article "How to Cache GraphQL POST Requests: A Practical Guide". |

Each example is self-contained in its own folder, with its own `package.json` and README. None of
them needs a GraphPilot account to run.
