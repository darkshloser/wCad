# Third-Party Licenses

wCAD is licensed under the GNU Affero General Public License v3 (see `LICENSE`). Because AGPL-3.0 is a strong copyleft licence, every dependency has to be checked for terms that are incompatible with it — and, if you later dual-license commercially, for terms that would interfere with that. This document records the current position and the reasoning.

**Note on AGPL compatibility:** AGPL-3.0 can incorporate MIT, BSD, ISC and Apache-2.0 code without difficulty. It is *not* compatible with GPL-2.0-only code, which is why the PostGIS position below matters.

**This is engineering diligence, not legal advice.** Before you sell a licence, have a lawyer review this list.

---

## Summary

| Dependency | License | Verdict |
|---|---|---|
| OpenLayers | BSD-2-Clause | Safe — permissive, attribution only |
| proj4js | MIT | Safe |
| React / React DOM | MIT | Safe |
| RBush | MIT | Safe |
| Vite, Vitest, TypeScript | MIT / Apache-2.0 | Safe — build/test tooling |
| fast-check | MIT | Safe |
| SQLite (incl. WASM build) | Public domain | Safe — no obligations at all |
| ezdxf | MIT | Safe |
| pyproj | MIT | Safe |
| lxml | BSD-3-Clause | Safe |
| GDAL / OGR | MIT/X11 | Safe |
| PostgreSQL | PostgreSQL License (BSD-like) | Safe |
| PostGIS | **GPL-2.0-or-later** | Safe as deployed — see below |
| Valkey | BSD-3-Clause | Safe |
| ~~Redis 7.4+ / 8.x~~ | RSALv2 / SSPLv1 / AGPLv3 | **Replaced with Valkey** |
| ~~MinIO~~ | AGPL-3.0 **and archived April 2026** | **Removed** |
| nginx | BSD-2-Clause | Safe |
| node-postgres (`pg`) | MIT | Safe |
| ioredis | MIT | Safe |
| Testcontainers | MIT | Safe |
| SeaweedFS (optional) | Apache-2.0 | Safe |

---

## The three that needed real thought

### PostGIS — GPL-2.0-or-later

PostGIS is genuinely GPL, which sounds alarming for a commercially licensed product. In practice it is fine, for two reasons:

1. **wCAD talks to PostGIS over the PostgreSQL wire protocol as a separate server process.** Communicating with an independent program over a documented network protocol does not make your program a derivative work of it. This is the same position every commercial application that runs against a GPL database relies on.
2. **Distributing a Docker image containing PostGIS is distributing GPL software**, which triggers the GPL's own obligations for *that software* — include the licence text and offer the corresponding source. PostGIS source is publicly available, so compliance is a documentation task. It does not reach into wCAD's own code, because the two are aggregated, not linked.

**What to avoid:** do not link against PostGIS's C libraries, embed it, or ship a modified PostGIS. Keep it a plain upstream image reached over TCP.

### Redis — no longer open source

Redis dropped BSD-3-Clause in March 2024 for a dual RSALv2 / SSPLv1 arrangement, and from Redis 8 (May 2025) it is tri-licensed RSALv2 / SSPLv1 / AGPLv3. None of those three is comfortable underneath a commercial product:

- **RSALv2** forbids offering the software as a commercial managed service and restricts competing use.
- **SSPLv1** is not OSI-approved and requires publishing the entire service management stack if you offer it as a service.
- **AGPLv3** is genuine open source but its network copyleft is exactly what a proprietary product needs to avoid.

The original `redis:7-alpine` tag in this project would have pulled a post-relicence build.

**Resolution: Valkey.** It is the Linux Foundation fork of Redis 7.2.4, still BSD-3-Clause, backed by AWS, Google and Oracle, and wire-compatible — a drop-in replacement for caching, pub/sub and queue use. The Redis modules (RediSearch, RedisJSON) are RSALv2 and have no Valkey equivalent, but wCAD uses none of them.

### MinIO — AGPL-3.0, and no longer maintained

Two independent problems, either of which alone would be disqualifying:

1. **AGPL-3.0.** MinIO completed its move from Apache-2.0 to AGPLv3 in 2021. AGPL's network clause is triggered by offering the software over a network, and MinIO Inc. has been explicit that commercial or proprietary usage requires their commercial licence.
2. **The project is dead.** MinIO entered maintenance mode in December 2025 and the repository was archived in April 2026. Building a new platform on archived, unmaintained storage infrastructure is a poor idea regardless of licensing.

**Resolution:** object storage is now behind a small `ObjectStore` interface with a filesystem-backed implementation as the default. On-premise installs get a mounted volume, which is simpler to operate and to back up than an object store anyway. If S3 semantics are needed later — for horizontal scaling of the tile cold cache — **SeaweedFS** (Apache-2.0) is the recommended adapter.

---

## Ongoing hygiene

Licences change, as Redis and MinIO both demonstrated inside two years. Two habits keep this from becoming a surprise:

- Pin **exact image tags**, never floating majors. `redis:7-alpine` silently crossing a relicence boundary is precisely the failure this document exists to prevent.
- Run a licence scan in CI (`license-checker` for npm, `pip-licenses` for Python) and fail the build on any dependency whose licence is not on the approved list.

Suggested CI addition:

```yaml
- name: License compliance
  run: |
    npx license-checker --production --onlyAllow \
      "MIT;ISC;BSD-2-Clause;BSD-3-Clause;Apache-2.0;CC0-1.0;Unlicense;0BSD"
```

---

## Sources

- [Redis licensing](https://redis.io/legal/licenses/) and [The Redis License Has Changed — Percona](https://www.percona.com/blog/the-redis-license-has-changed-what-you-need-to-know/)
- [Valkey](https://valkey.io/) — Linux Foundation, BSD-3-Clause
- [MinIO is now fully licensed under GNU AGPLv3](https://www.min.io/blog/from-open-source-to-free-and-open-source-minio-is-now-fully-licensed-under-gnu-agplv3)
- [minio/minio repository](https://github.com/minio/minio) — archived April 2026
- [Business Source License 1.1](https://mariadb.com/bsl11/)
